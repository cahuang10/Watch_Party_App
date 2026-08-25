import { useCallback, useEffect, useRef, useState } from "react";
import { iceServers } from "./iceServers";
import { joinSignalingChannel } from "./signaling";
import { SLOT_ORDER, resolveSlots } from "./mediaSlots";
import { captureScreen, applyScreenQuality, preferVideoCodecs } from "./screenShare";

// If we believe we're the answerer but no offer shows up in this long, assume the
// offerer election picked wrong (a stale presence entry is the usual cause) and
// ask for one explicitly rather than waiting forever.
const OFFER_TIMEOUT_MS = 3000;

// The whole call lives here: signaling, the peer connection, and the camera/mic
// and screen-share controls. It's a hook rather than code inside App because the
// toggle buttons need to reach the peer connection's senders and the local
// streams, and those used to be closure variables locked inside a useEffect.
//
// --- the idea the media controls rest on ---------------------------------
// A *transceiver* is a durable slot in the connection; a *track* is just what's
// currently plugged into that slot. `sender.replaceTrack(x)` swaps what flows
// through the slot without renegotiating, as long as the kind matches, and
// `replaceTrack(null)` stops sending with the slot left intact.
//
// Session 3 used this for the camera: one slot, reserved at connection time,
// filled or emptied without ever touching offer/answer. Screen share (Session 4)
// is the same idea applied one step earlier: FOUR slots are reserved up front --
// mic, camera, screen audio, screen video -- so starting or stopping a share is
// also just a replaceTrack. See mediaSlots.js for the slot table and why the
// answerer must resolve them by index instead of pre-creating its own.
export function useWatchPartyCall() {
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  // The shared-content surface. Local when WE are sharing, remote when the
  // partner is -- see wireRemoteStreams() and startShare() for how each gets
  // its srcObject.
  const localScreenVideoRef = useRef(null);
  const remoteScreenVideoRef = useRef(null);

  const [status, setStatus] = useState("waiting for partner...");
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [partnerCameraOn, setPartnerCameraOn] = useState(true);
  const [partnerMicOn, setPartnerMicOn] = useState(true);
  // True while a getUserMedia is in flight for OUR camera. Without this the tile
  // renders a black rectangle for the whole device-open: `cameraOn` flips the
  // instant you click, but the frames don't arrive for several hundred ms.
  const [cameraStarting, setCameraStarting] = useState(false);

  const [sharing, setSharing] = useState(false);
  const [shareStarting, setShareStarting] = useState(false);
  const [partnerSharing, setPartnerSharing] = useState(false);
  // Populated when captureScreen() detects the user picked a window/screen
  // instead of a tab, or shared without tab audio. Shown in the UI rather than
  // thrown, because the share is still real and still worth displaying.
  const [shareWarnings, setShareWarnings] = useState([]);

  // Static for the life of the app -- iOS Safari has no getDisplayMedia at all,
  // which is exactly locked decision #5 (phones are viewer-only). Computed once
  // rather than as state since it can't change while the page is open.
  const canShare = typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";

  // Same values as state, mirrored into refs. The effect below runs once and
  // its callbacks would otherwise close over the values from the first render
  // forever; async code reads the refs to get the *current* intent.
  const cameraOnRef = useRef(true);
  const micOnRef = useRef(true);
  const sharingRef = useRef(false);

  // Everything that belongs to one peering session. Refs, not state: none of it
  // is render data, and rebuilding a peer connection must not re-render the UI.
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  // Camera+mic from the partner -> the partner's CameraBox tile.
  const remoteCameraStreamRef = useRef(null);
  // Screen audio+video from the partner -> the Stage.
  const remoteScreenStreamRef = useRef(null);
  // Our own screen capture, while sharing -> our half of the Stage.
  const localScreenStreamRef = useRef(null);
  // The four reserved transceivers for the current peering session, keyed by
  // role (see mediaSlots.js). Built once per session -- by createPeerConnection
  // for the offerer, by attachLocalMediaToAnswer for the answerer -- and used
  // by every control (toggleCamera, toggleMic, startShare, stopShare) to reach
  // the right sender without caring which role built it.
  const slotsRef = useRef({});
  const signalingRef = useRef(null);
  // Bumped on every camera toggle. Opening a camera is slow (~300ms) and
  // toggleCamera is async, so clicking faster than that leaves more than one
  // getUserMedia in flight at once. Only the newest may keep its track; without
  // this the earlier ones each add a live track to the stream and the *device*
  // stays open behind them -- the camera light stays on with the UI showing
  // "camera off", which is exactly the failure that looks like a lie.
  const cameraOpRef = useRef(0);
  // Same idea for screen capture: getDisplayMedia is async and its own picker
  // adds an unpredictable delay, so a double-click on Share can leave two tab
  // captures live -- the abandoned one still shows Chrome's "sharing" indicator
  // for a tab nobody is using.
  const shareOpRef = useRef(0);
  // Bumped every time a peering session is torn down, so async work started by
  // the old session can notice it has been outlived. See onPeerOnline.
  const peeringTokenRef = useRef(0);

  // Tell the partner what our devices are doing. They cannot work this out from
  // the stream itself: a muted mic sends silence and a stopped camera sends
  // nothing -- and, as of this session, an idle screen-video receiver reports
  // `track.muted === false` even when nobody has shared anything yet, so
  // whether a share is live is *exactly* as untellable from the stream as
  // camera/mic state. So all three are said, not guessed.
  const sendMediaState = useCallback(() => {
    signalingRef.current?.sendSignal({
      type: "media-state",
      camera: cameraOnRef.current,
      mic: micOnRef.current,
      sharing: sharingRef.current,
    });
  }, []);

  const toggleMic = useCallback(() => {
    const next = !micOnRef.current;
    micOnRef.current = next;
    setMicOn(next);

    // `enabled = false` leaves the track and its transceiver exactly where they
    // are -- the connection never notices, it just carries silence. Instant, and
    // instant is what matters mid-conversation. The mic has no hardware
    // indicator to worry about, which is why it doesn't need the camera's
    // heavier stop-and-reacquire treatment.
    const audioTrack = localStreamRef.current?.getAudioTracks()[0];
    if (audioTrack) audioTrack.enabled = next;

    sendMediaState();
  }, [sendMediaState]);

  // `getUserMedia` resolving means a track EXISTS, not that frames are being
  // painted -- the element still has to decode its first one. Lifting the
  // placeholder on the promise therefore still flashes black. This waits for a
  // frame to actually reach the screen. The timeout is a safety net: a camera
  // that never produces a frame must not wedge the tile in "starting..." forever.
  // Generic over camera vs. screen-share elements -- both need exactly this.
  const waitForFirstFrame = useCallback((el, timeoutMs = 2000) => {
    return new Promise((resolve) => {
      if (!el) return resolve();

      // requestVideoFrameCallback does NOT fire while the document is hidden --
      // Chrome suspends frame callbacks for background tabs. Waiting there just
      // burns the whole timeout, and there is no visible flash to prevent when
      // nobody is looking at the tile. This is not an edge case: Session 4 puts
      // the sharer on the content tab with this one in the background, so a
      // hidden document is the normal state while sharing.
      if (document.hidden) return resolve();

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        resolve();
      };
      // Backgrounded mid-wait: frames stop arriving, so give up now rather than
      // sitting out the timeout.
      const onVisibilityChange = () => {
        if (document.hidden) finish();
      };
      document.addEventListener("visibilitychange", onVisibilityChange);

      // Safety net for a camera that opens but never produces a frame.
      const timer = setTimeout(finish, timeoutMs);
      if (typeof el.requestVideoFrameCallback === "function") {
        el.requestVideoFrameCallback(() => finish());
      } else {
        // Older engines: `playing` is the closest signal available.
        el.addEventListener("playing", () => finish(), { once: true });
      }
    });
  }, []);

  const toggleCamera = useCallback(async () => {
    const next = !cameraOnRef.current;
    cameraOnRef.current = next;
    setCameraOn(next);
    // Claim this toggle. Any acquisition still in flight from an earlier click
    // is now stale and must throw its track away rather than attach it.
    const op = ++cameraOpRef.current;

    const stream = localStreamRef.current;
    const sender = slotsRef.current.camera?.sender;

    if (!next) {
      // Off. Order matters here, and it used to be the other way round.
      //
      // Release the DEVICE first, unconditionally. Unplugging the sender is a
      // tidy-up; releasing the camera is the thing the user actually asked for,
      // and it must not be able to fail because of the tidy-up. `replaceTrack`
      // throws InvalidStateError on a stopped sender -- which is what a sender
      // becomes when its peer connection gets closed underneath it, e.g. when
      // presence churn tears down a peering session mid-toggle. With the
      // unguarded `await` first, that throw skipped the stop() below and left
      // the camera light on while the UI insisted the camera was off.
      stream?.getVideoTracks().forEach((track) => {
        track.stop();
        stream.removeTrack(track);
      });
      try {
        await sender?.replaceTrack(null);
      } catch (err) {
        // The device is already released by this point, so this is cosmetic.
        console.warn("replaceTrack(null) failed after releasing camera:", err);
      }
    } else if (stream) {
      // On: fetch a fresh track and plug it into the same slot. `stop()` is
      // permanent -- a stopped track can never be restarted -- so coming back
      // always means a new getUserMedia, and that's the ~300ms light-blink.
      // Opening a camera is genuinely slow -- this is the cost of `stop()`ing it
      // on the way out. Timed so the number is observable rather than argued
      // about; if it's consistently over ~1s the grace-period option in
      // SESSION_3_POSTMORTEM Part 6 is worth taking.
      setCameraStarting(true);
      const openedAt = performance.now();
      let cameraStream;
      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
      } catch (err) {
        // Only on failure do we clear it here -- on success the placeholder has
        // to stay up until a frame is on screen (see the end of this branch).
        // Without this a denied camera strands the tile in "starting..." forever.
        // Only the newest toggle may clear the flag: an older one finishing late
        // must not un-blank a tile still waiting on its own device.
        if (op === cameraOpRef.current) setCameraStarting(false);
        throw err;
      }
      console.log(`camera device opened in ${Math.round(performance.now() - openedAt)}ms`);
      const videoTrack = cameraStream.getVideoTracks()[0];
      if (op !== cameraOpRef.current || !cameraOnRef.current || localStreamRef.current !== stream) {
        // Superseded by a later toggle, toggled off again, or the peering
        // session was rebuilt while the device was opening. Whoever superseded
        // us sends their own state. Stopping the track here is the whole point:
        // an abandoned track holds the camera open forever.
        videoTrack.stop();
        if (op === cameraOpRef.current) setCameraStarting(false);
        return;
      }
      // Belt and braces: clear the slot before filling it, so the stream can
      // never accumulate two video tracks even if the guard above is ever
      // weakened. A track left in the stream keeps the device open.
      stream.getVideoTracks().forEach((track) => {
        track.stop();
        stream.removeTrack(track);
      });
      await sender?.replaceTrack(videoTrack);
      stream.addTrack(videoTrack);

      // srcObject has to be set before we can wait on the element, and the
      // reassignment at the end of this function is too late for that.
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      await waitForFirstFrame(localVideoRef.current);
      console.log(`camera first frame at ${Math.round(performance.now() - openedAt)}ms`);
      if (op === cameraOpRef.current) setCameraStarting(false);
    }
    // No stream at all means no partner yet, so there is nothing to do to the
    // hardware -- the flag above is pre-arm intent, honoured by openDevices().

    // Re-assign so the element picks up the changed track set.
    if (localVideoRef.current) localVideoRef.current.srcObject = stream ?? null;

    // What THIS tab still holds open, in its own words. If the camera light is
    // on and this line shows no live video track, the device is held by
    // something else -- another tab of this app (every dev server and the
    // deployment share one signaling room, so stray tabs pair up and each opens
    // its own camera) or another program entirely.
    console.log(
      `camera ${next ? "on" : "off"} — this tab now holds:`,
      stream?.getTracks().map((t) => `${t.kind}:${t.readyState}`).join(" ") || "(no tracks)"
    );

    sendMediaState();
  }, [sendMediaState, waitForFirstFrame]);

  // Begin sharing a tab. Fills the screenAudio/screenVideo slots that were
  // reserved (empty) when the peering session started -- see mediaSlots.js.
  // Because the slots already exist, this is a replaceTrack, exactly like
  // turning the camera on: no offer, no answer, no renegotiation, no glare.
  const startShare = useCallback(async () => {
    const slots = slotsRef.current;
    if (!slots.screenVideo || !slots.screenAudio) {
      // No peering session yet (or it hasn't finished negotiating), so the
      // slots don't exist -- there's nowhere to send this to.
      console.warn("no partner yet, ignoring share request");
      return;
    }
    if (sharingRef.current) return; // already sharing, nothing to do

    const op = ++shareOpRef.current;
    setShareWarnings([]);

    let capture;
    try {
      capture = await captureScreen();
    } catch (err) {
      // By far the most common case is the user closing the picker without
      // choosing anything (NotAllowedError). That's not a connection problem,
      // just a share that didn't start -- no need to touch `status` over it.
      console.warn("screen capture cancelled or failed:", err.name, err.message);
      return;
    }
    const { stream, warnings } = capture;

    if (op !== shareOpRef.current) {
      // A second click landed before the picker closed on this one. Release
      // this capture immediately -- an abandoned tab-capture is exactly the
      // camera-light bug from Session 3, just with Chrome's sharing indicator
      // standing in for the camera light.
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    sharingRef.current = true;
    setSharing(true);
    setShareStarting(true);
    setShareWarnings(warnings);

    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0] ?? null;

    // Chrome's own "Stop sharing" bar (or the OS-level screen-share menu) can
    // end this track directly, bypassing our Stop button entirely. Without
    // this listener the UI keeps claiming a share the browser already tore
    // down. Guarded by `op` so a track from an OLD share ending late can't
    // reach in and stop a NEW one that has since started.
    videoTrack.onended = () => {
      if (op === shareOpRef.current) stopShare();
    };

    await slots.screenVideo.sender.replaceTrack(videoTrack);
    if (audioTrack) await slots.screenAudio.sender.replaceTrack(audioTrack);
    await applyScreenQuality(slots.screenVideo.sender, videoTrack);

    localScreenStreamRef.current = stream;
    if (localScreenVideoRef.current) localScreenVideoRef.current.srcObject = stream;
    await waitForFirstFrame(localScreenVideoRef.current);
    if (op === shareOpRef.current) setShareStarting(false);

    sendMediaState();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stopShare is defined below and stable via useCallback
  }, [sendMediaState, waitForFirstFrame]);

  // End a share, ours or one the tie-break below decided must yield. Mirrors
  // toggleCamera's off-branch: release the actual capture first (that's what
  // turns off Chrome's sharing indicator), tidy the senders second, so a
  // failure in the tidy-up can never leave the device held open.
  const stopShare = useCallback(async () => {
    if (!sharingRef.current) return;
    shareOpRef.current += 1; // invalidates any in-flight startShare or onended
    sharingRef.current = false;
    setSharing(false);
    setShareStarting(false);
    setShareWarnings([]);

    const slots = slotsRef.current;
    const stream = localScreenStreamRef.current;
    stream?.getTracks().forEach((track) => track.stop());
    localScreenStreamRef.current = null;
    if (localScreenVideoRef.current) localScreenVideoRef.current.srcObject = null;

    try {
      await slots.screenVideo?.sender.replaceTrack(null);
      await slots.screenAudio?.sender.replaceTrack(null);
    } catch (err) {
      // The capture is already released by this point, so this is cosmetic --
      // same reasoning as the equivalent catch in toggleCamera.
      console.warn("replaceTrack(null) failed after stopping share:", err);
    }

    sendMediaState();
  }, [sendMediaState]);

  useEffect(() => {
    let cancelled = false;

    // TURN-only test mode. Load the page with ?relay=1 to throw away every
    // direct candidate (host/srflx) so media *must* go through the TURN relay.
    // TURN normally only kicks in when a direct connection fails, which means a
    // broken relay config looks perfectly fine until the day it matters -- this
    // flag makes verifying it a one-second thing to repeat, rather than a line
    // that gets commented in and out.
    const forceRelay = new URLSearchParams(window.location.search).get("relay") === "1";

    // --- peering session handshake state ------------------------------------
    // All of this belongs to one peering session, NOT to the page. When the
    // partner reloads they come back as a different peer, and every bit of it is
    // thrown away and rebuilt. Reusing a finished connection is what produced the
    // "setRemoteDescription ... called in wrong state: stable" failures: the old
    // connection was already negotiated, so a new partner's answer had nothing to
    // attach to.
    let offerSent = false;
    let nudgeSent = false;
    let remoteDescriptionSet = false;
    let queuedCandidates = [];
    let offerTimer;

    // Open the devices for one peering session. Deliberately NOT called at page
    // load: opening the camera while you sit alone waiting means the camera
    // light burns the entire time nobody is there to see it. Returns the stream
    // rather than storing it, so the caller can check it's still wanted before
    // wiring it in -- see the token check in onPeerOnline.
    async function openDevices() {
      const stream = await navigator.mediaDevices.getUserMedia({
        // `false` here is how pre-arming works: turn the camera off before a
        // partner arrives and it simply never opens when they do.
        video: cameraOnRef.current,
        // Explicit, not `audio: true` -- this is a MICROPHONE, so echo
        // cancellation matters: without it, the partner's voice coming out of
        // your speakers gets picked back up and sent right back to them.
        // screenShare.js turns these same three settings OFF for the opposite
        // reason -- that's tab content, not a voice call, and the processing
        // would mangle music or dialogue. EC is tuned for voices and can't
        // fully cancel loud content playing over speakers either way --
        // headphones are the actual fix (CLAUDE.md, "Audio feedback loops").
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      // The mic track always exists -- muting it is `enabled = false`, which
      // needs a track to be there in the first place.
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) audioTrack.enabled = micOnRef.current;
      return stream;
    }

    // Builds (or refreshes) the two remote streams -- camera+mic for the
    // partner's tile, screen audio+video for the Stage -- from whatever the
    // connection's transceivers currently hold. Called from ontrack, which can
    // fire before attachLocalMediaToAnswer() has run: on the answerer, a
    // receiver's track exists the instant setRemoteDescription creates the
    // transceiver, not after we've attached our own media. So this re-resolves
    // slot roles fresh each call via resolveSlots() rather than trusting
    // slotsRef to already be populated.
    function wireRemoteStreams() {
      const pc = pcRef.current;
      if (!pc) return;
      const slots = resolveSlots(pc.getTransceivers());

      if (!remoteCameraStreamRef.current) remoteCameraStreamRef.current = new MediaStream();
      if (!remoteScreenStreamRef.current) remoteScreenStreamRef.current = new MediaStream();
      const cameraStream = remoteCameraStreamRef.current;
      const screenStream = remoteScreenStreamRef.current;

      // MediaStream.addTrack is a no-op if the track is already present, so
      // this is safe to call every time a new track arrives rather than only
      // once.
      if (slots.mic) cameraStream.addTrack(slots.mic.receiver.track);
      if (slots.camera) cameraStream.addTrack(slots.camera.receiver.track);
      if (slots.screenAudio) screenStream.addTrack(slots.screenAudio.receiver.track);
      if (slots.screenVideo) screenStream.addTrack(slots.screenVideo.receiver.track);

      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = cameraStream;
      if (remoteScreenVideoRef.current) remoteScreenVideoRef.current.srcObject = screenStream;
    }

    // `isOfferer` decides how our own media gets attached, and the two roles are
    // genuinely different -- see the transceiver block at the bottom.
    function createPeerConnection(isOfferer) {
      const connection = new RTCPeerConnection({
        iceServers,
        ...(forceRelay ? { iceTransportPolicy: "relay" } : {}),
      });

      connection.ontrack = () => {
        wireRemoteStreams();
        setStatus("connected");
      };

      connection.onicecandidate = (event) => {
        if (!event.candidate) return;
        // For a `relay` candidate, `address` is the address the TURN server
        // allocated for us. Worth logging because it's the only visible sign
        // TURN is alive at all -- no relay candidate means the credentials or
        // the host are wrong. `free.expressturn.com` resolves to more than one
        // IP, so the two peers can be allocated on different ones; that is
        // normal and fine, each allocation is independently usable.
        console.log(
          "local  candidate:",
          event.candidate.type,
          event.candidate.protocol,
          event.candidate.address
        );
        signalingRef.current?.sendSignal({ type: "ice-candidate", candidate: event.candidate });
      };

      connection.onconnectionstatechange = () => {
        console.log("connectionState:", connection.connectionState);
        if (connection.connectionState === "connected") {
          // Send our camera/mic/sharing state here rather than when the
          // peering session starts. signaling.js drops any message whose
          // `session` the receiver hasn't computed yet, and at session start
          // that's a genuine race -- by the time the connection is up, both
          // sides provably agree on it.
          sendMediaState();
        }
        if (
          connection.connectionState === "disconnected" ||
          connection.connectionState === "failed"
        ) {
          setStatus("disconnected");
        }
      };
      connection.oniceconnectionstatechange = () => {
        console.log("iceConnectionState:", connection.iceConnectionState);
      };
      // Fires when a STUN/TURN server rejects us. 401 = bad credentials,
      // 486 = allocation quota reached, 701 = server unreachable.
      connection.onicecandidateerror = (e) => {
        console.warn("icecandidateerror:", e.errorCode, e.errorText, e.url);
      };

      // --- attaching our media: the offerer and the answerer differ ----------
      //
      // The offerer defines the m-lines, so it reserves one slot per role here
      // -- FOUR now, not two -- whether or not there's a track to put in it
      // yet. That's what makes turning the camera on, or starting a screen
      // share, later a plain replaceTrack into an existing slot instead of a
      // renegotiation.
      //
      // The ANSWERER must not do this. setRemoteDescription(offer) builds its
      // own transceivers from the offer's m-lines, and it will NOT adopt ones
      // made by addTransceiver -- only addTrack-created transceivers are
      // eligible for that. Pre-creating them here would leave the answerer
      // holding eight: four orphans with `mid: null` that never send, plus
      // four recvonly ones from the SDP. The answerer fills in its tracks
      // after setRemoteDescription instead -- see attachLocalMediaToAnswer().
      if (isOfferer) {
        const stream = localStreamRef.current;
        const tracksByRole = {
          mic: stream?.getAudioTracks()[0] ?? null,
          camera: stream?.getVideoTracks()[0] ?? null,
          // Nobody shares at connection time -- these two start empty, exactly
          // like the camera slot does when connecting with the camera off.
          screenAudio: null,
          screenVideo: null,
        };
        const slots = {};
        SLOT_ORDER.forEach(({ role, kind }) => {
          const isScreenSlot = role === "screenAudio" || role === "screenVideo";
          const track = tracksByRole[role];
          const options = {
            direction: "sendrecv",
            // The camera/mic slots share the mic+camera MediaStream so the
            // partner's browser groups them as one source; the screen slots
            // have no stream to advertise yet -- one gets created in
            // startShare() once there's an actual capture to associate.
            streams: isScreenSlot ? [] : stream ? [stream] : [],
          };
          if (role === "screenVideo") {
            // A baseline cap set at slot-creation time; startShare() sets the
            // authoritative one via setParameters() once real encoding starts
            // (see applyScreenQuality), regardless of which side ends up
            // sharing through this slot.
            options.sendEncodings = [{ maxBitrate: 3_000_000 }];
          }
          slots[role] = connection.addTransceiver(track ?? kind, options);
        });
        // Must happen before createOffer() -- setCodecPreferences only affects
        // SDP generated after it's called, and the offer is what fixes the
        // codec list for this connection's whole life.
        preferVideoCodecs(slots.screenVideo, ["VP9", "AV1"]);
        slotsRef.current = slots;
      }

      return connection;
    }

    // The answerer's half of the above. Called once, after
    // setRemoteDescription(offer) has created the transceivers and before
    // createAnswer() reads their directions off to build the SDP.
    async function attachLocalMediaToAnswer() {
      const stream = localStreamRef.current;
      const transceivers = pcRef.current.getTransceivers();
      console.log(
        "answerer transceivers from offer:",
        transceivers.map((t) => `${t.mid}:${t.receiver.track.kind}:${t.direction}`).join(" ")
      );

      // resolveSlots already applies the stopped/kind-mismatch skips that used
      // to be written out by hand here -- see mediaSlots.js. Whatever it can't
      // resolve simply doesn't appear below, which is exactly the old
      // `continue` behaviour.
      const slots = resolveSlots(transceivers);
      slotsRef.current = slots;

      const tracksByRole = {
        mic: stream?.getAudioTracks()[0] ?? null,
        camera: stream?.getVideoTracks()[0] ?? null,
        // Nothing to attach yet -- same as the offerer at connection time.
        // These slots exist so a LATER share is a replaceTrack, not a
        // renegotiation, no matter which side ends up sharing.
        screenAudio: null,
        screenVideo: null,
      };

      for (const [role, transceiver] of Object.entries(slots)) {
        const track = tracksByRole[role];
        // A missing track is fine and expected -- it's the camera being off,
        // or nobody sharing yet. The slot still exists, which is the point.
        if (track) await transceiver.sender.replaceTrack(track);
        // Without this the transceiver stays `recvonly` (it was built from an
        // offer at a moment when we had nothing attached) and we never send.
        transceiver.direction = "sendrecv";
      }

      // Same reasoning as the offerer's call above: must happen before
      // createAnswer(), which runs immediately after this function returns.
      if (slots.screenVideo) preferVideoCodecs(slots.screenVideo, ["VP9", "AV1"]);
    }

    // Throw away the current peering session, devices included.
    function endPeeringSession() {
      clearTimeout(offerTimer);
      // Anything async still in flight for the session we're tearing down must
      // not be able to wire itself into the next one.
      peeringTokenRef.current += 1;

      pcRef.current?.close();
      pcRef.current = null;
      slotsRef.current = {};
      offerSent = false;
      nudgeSent = false;
      remoteDescriptionSet = false;
      queuedCandidates = [];

      // The devices belong to the call, not to the page: no partner means no
      // call, so the camera light goes off. (Session 2's version deliberately
      // kept the stream alive to avoid re-prompting for permission. That
      // reasoning doesn't hold -- Chrome remembers the grant per origin on
      // https and localhost, so re-acquiring is silent.)
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      if (localVideoRef.current) localVideoRef.current.srcObject = null;

      // The screen capture is call-scoped too, for the same reason: no partner
      // means nothing to send a share to. Known trade-off -- a partner reload
      // is a leave-then-join, so it also ends any share in progress and you
      // have to re-pick the tab, same as the camera's blink-off-and-on. Not
      // fixed here: keeping the capture alive across peering sessions means
      // state outliving its session, which is the exact class of bug that ate
      // Session 2.
      shareOpRef.current += 1;
      sharingRef.current = false;
      setSharing(false);
      setShareStarting(false);
      setShareWarnings([]);
      localScreenStreamRef.current?.getTracks().forEach((track) => track.stop());
      localScreenStreamRef.current = null;
      if (localScreenVideoRef.current) localScreenVideoRef.current.srcObject = null;

      // Without this the partner's frozen last frame stays on screen, looking
      // exactly like a live connection.
      remoteCameraStreamRef.current = null;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
      remoteScreenStreamRef.current = null;
      if (remoteScreenVideoRef.current) remoteScreenVideoRef.current.srcObject = null;

      // We know nothing about the next partner's devices until they tell us.
      setPartnerCameraOn(true);
      setPartnerMicOn(true);
      setPartnerSharing(false);
    }

    async function applyRemoteDescription(description) {
      await pcRef.current.setRemoteDescription(description);
      remoteDescriptionSet = true;
      for (const candidate of queuedCandidates.splice(0)) {
        await pcRef.current.addIceCandidate(candidate);
      }
    }

    // How many m= sections a description carries. FOUR (mic, camera,
    // screenAudio, screenVideo) is what this app should produce from Session 4
    // onward; anything else means something added a section we didn't ask for,
    // and that's worth seeing in the log.
    function sectionCount(description) {
      return (description?.sdp?.match(/^m=/gm) || []).length;
    }

    async function createAndSendOffer(reason) {
      if (offerSent) return;
      offerSent = true;
      console.log("creating offer:", reason);
      setStatus("offerer · creating offer");
      const offer = await pcRef.current.createOffer();
      await pcRef.current.setLocalDescription(offer);
      console.log(
        "offer sections:", sectionCount(offer),
        (offer.sdp.match(/^m=.*/gm) || []).map((m) => m.split(" ")[0]).join(" ")
      );
      signalingRef.current.sendSignal({ type: "offer", description: offer });
      setStatus("offerer · offer sent");
    }

    function start() {
      // No getUserMedia here. The camera opens when someone is actually there to
      // see it -- see onPeerOnline below.
      setStatus("waiting for partner...");
      console.log(
        forceRelay ? "ICE mode: relay-only (TURN forced)" : "ICE mode: all transports"
      );

      signalingRef.current = joinSignalingChannel({
        onPeerOnline: async ({ isOfferer, peerId }) => {
          // Both of these callbacks are invoked by the channel and are not awaited
          // by start(), so start().catch() does not cover them. Without these
          // try/catch blocks a failure here becomes an unhandled rejection and the
          // UI just sits on its last status forever with no clue why.
          try {
            console.log("peering with", peerId);
            // A new peer id means a new peering session -- discard whatever the
            // previous one left behind before building the new connection.
            endPeeringSession();

            // Snapshot the token *after* the teardown above bumped it. Opening
            // the devices is async, and the partner can reload while we're still
            // waiting on the camera -- that fires onPeerOnline again, tears this
            // session down, and bumps the token. Without this check the stale
            // stream gets wired into the new connection. Same class of bug that
            // ate Session 2: state belonging to a peering session outliving it.
            const token = peeringTokenRef.current;
            setStatus("opening camera...");
            setCameraStarting(true);
            const openedAt = performance.now();
            let stream;
            try {
              stream = await openDevices();
            } finally {
              setCameraStarting(false);
            }
            console.log(`devices opened in ${Math.round(performance.now() - openedAt)}ms`);
            if (cancelled || token !== peeringTokenRef.current) {
              console.warn("peering session changed while opening devices — discarding stream");
              stream.getTracks().forEach((track) => track.stop());
              return;
            }
            localStreamRef.current = stream;
            if (localVideoRef.current) localVideoRef.current.srcObject = stream;

            pcRef.current = createPeerConnection(isOfferer);

            if (isOfferer) {
              await createAndSendOffer("elected offerer");
              return;
            }

            setStatus("answerer · waiting for offer");

            // Safety net: if the election deferred to a stale presence entry then
            // nobody is actually going to offer, and both peers wait forever.
            // After a beat, ask out loud.
            offerTimer = setTimeout(() => {
              if (remoteDescriptionSet) return;
              nudgeSent = true;
              console.warn("no offer after 3s — asking peer to send one");
              setStatus("answerer · no offer yet, nudging peer");
              signalingRef.current.sendSignal({ type: "need-offer" });
            }, OFFER_TIMEOUT_MS);
          } catch (err) {
            console.error("handshake failed:", err);
            setStatus(`error: ${err.message}`);
          }
        },

        onPeerLeft: () => {
          console.log("partner left");
          endPeeringSession();
          setStatus("waiting for partner...");
        },

        onSignal: async (payload) => {
          try {
            // Handled before the peer-connection check below: this one is about
            // the partner's devices, not about negotiation, so it's meaningful
            // whether or not a connection exists.
            if (payload.type === "media-state") {
              console.log("partner media-state:", payload.camera, payload.mic, payload.sharing);
              setPartnerCameraOn(payload.camera);
              setPartnerMicOn(payload.mic);
              setPartnerSharing(Boolean(payload.sharing));

              // Symmetric slots mean both people COULD start sharing in the
              // same instant. The UI disables Share while the partner is
              // sharing, but that's a best-effort lock that can lose a genuine
              // simultaneous click -- this is the backstop. Same shape as the
              // `need-offer` tie-break below: pick a winner by tab id so
              // exactly one share survives instead of both fighting over the
              // same slot forever.
              if (payload.sharing && sharingRef.current && signalingRef.current.tabId > payload.from) {
                console.warn("simultaneous share detected — stopping ours, lower tab id wins");
                stopShare();
              }
              return;
            }

            const pc = pcRef.current;
            if (!pc) {
              // Signal landed before presence told us who the peer is. Rare, and
              // the answerer's nudge recovers it.
              console.warn("signal before peering session started:", payload.type);
              return;
            }

            if (payload.type === "offer") {
              // Only a connection with nothing in flight can accept an offer.
              // Anything else means glare -- both sides offered at once. This
              // still can't happen post-Session-4: screen share never triggers
              // a new offer, so exactly one side (the fixed offerer) ever
              // sends one, same as before.
              if (pc.signalingState !== "stable") {
                console.warn("ignoring offer, signalingState is", pc.signalingState);
                return;
              }
              clearTimeout(offerTimer);
              setStatus("answerer · offer received");
              console.log(
                "offer sections:", sectionCount(payload.description),
                (payload.description.sdp.match(/^m=.*/gm) || []).map((m) => m.split(" ")[0]).join(" ")
              );
              await applyRemoteDescription(payload.description);
              // Must happen between setRemoteDescription and createAnswer:
              // the transceivers only exist after the first, and the answer SDP
              // is generated from their directions in the second.
              await attachLocalMediaToAnswer();
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              signalingRef.current.sendSignal({ type: "answer", description: answer });
              setStatus("answerer · answer sent");
            } else if (payload.type === "answer") {
              // An answer is only meaningful while our own offer is outstanding.
              // Applying one in `stable` throws, and that is exactly the error a
              // one-sided refresh used to produce. signaling.js now filters out
              // finished sessions upstream, so this is a second line of defence
              // rather than the only one.
              if (pc.signalingState !== "have-local-offer") {
                console.warn("ignoring answer, signalingState is", pc.signalingState);
                return;
              }
              await applyRemoteDescription(payload.description);
              setStatus("offerer · answer received");
            } else if (payload.type === "need-offer") {
              if (offerSent && pc.signalingState === "have-local-offer") {
                // Our offer is still outstanding, so the broadcast itself must
                // have been dropped -- Supabase broadcast is fire-and-forget with
                // no retry. Re-send the description we already have; a second,
                // different offer would invalidate the first.
                console.log("re-sending existing offer (peer never got it)");
                signalingRef.current.sendSignal({ type: "offer", description: pc.localDescription });
                return;
              }
              // Otherwise the peer gave up waiting. If we nudged too then we both
              // think we're the answerer -- tie-break on id so exactly one of us
              // takes the offerer role, instead of both offering at once.
              if (nudgeSent && signalingRef.current.tabId > payload.from) return;
              await createAndSendOffer("peer asked for one");
            } else if (payload.type === "ice-candidate") {
              // `type`, `protocol` and `address` are *parsed* properties of an
              // RTCIceCandidate, not stored fields: toJSON() serialises only
              // { candidate, sdpMid, sdpMLineIndex, usernameFragment }, so they
              // arrive undefined after the trip through Supabase broadcast.
              // Rebuilding a real RTCIceCandidate re-parses them out of the
              // candidate string. Without this the log reads
              // "remote candidate: undefined undefined undefined" and the
              // relay-address comparison below is silently useless.
              const candidate = new RTCIceCandidate(payload.candidate);
              // Logged alongside the local candidates above so one console shows
              // both ends: if both sides are `relay` but the addresses belong to
              // different TURN servers, that mismatch is the connection failure.
              console.log(
                "remote candidate:",
                candidate.type,
                candidate.protocol,
                candidate.address
              );
              if (remoteDescriptionSet) {
                await pc.addIceCandidate(candidate);
              } else {
                // ICE candidates can arrive before setRemoteDescription has run --
                // they're discovered and sent in parallel with the offer/answer
                // exchange, not after it -- and addIceCandidate throws if called
                // too early, so hold onto them until the description is set.
                queuedCandidates.push(candidate);
              }
            }
          } catch (err) {
            console.error("signal handling failed:", payload.type, err);
            setStatus(`error: ${err.message}`);
          }
        },
      });
    }

    start();

    return () => {
      cancelled = true;
      endPeeringSession();
      signalingRef.current?.leave();
      signalingRef.current = null;
    };
  }, [sendMediaState, stopShare]);

  return {
    status,
    cameraOn,
    cameraStarting,
    micOn,
    partnerCameraOn,
    partnerMicOn,
    toggleCamera,
    toggleMic,
    localVideoRef,
    remoteVideoRef,

    sharing,
    shareStarting,
    partnerSharing,
    shareWarnings,
    canShare,
    startShare,
    stopShare,
    localScreenVideoRef,
    remoteScreenVideoRef,
  };
}
