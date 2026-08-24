import { useCallback, useEffect, useRef, useState } from "react";
import { iceServers } from "./iceServers";
import { joinSignalingChannel } from "./signaling";

// If we believe we're the answerer but no offer shows up in this long, assume the
// offerer election picked wrong (a stale presence entry is the usual cause) and
// ask for one explicitly rather than waiting forever.
const OFFER_TIMEOUT_MS = 3000;

// The whole call lives here: signaling, the peer connection, and the camera/mic
// controls. It's a hook rather than code inside App because the toggle buttons
// need to reach the peer connection's senders and the local stream, and those
// used to be closure variables locked inside a useEffect.
//
// --- the idea the media controls rest on ---------------------------------
// A *transceiver* is a durable slot in the connection; a *track* is just what's
// currently plugged into that slot. `sender.replaceTrack(x)` swaps what flows
// through the slot without renegotiating, as long as the kind matches, and
// `replaceTrack(null)` stops sending with the slot left intact.
//
// That is what lets us physically stop the camera -- light off -- and re-acquire
// it later without ever touching offer/answer. The alternative, removeTrack /
// addTrack, fires `negotiationneeded` and needs a fresh offer, which is exactly
// the path CLAUDE.md warns about while glare is still unhandled.
export function useWatchPartyCall() {
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  const [status, setStatus] = useState("waiting for partner...");
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [partnerCameraOn, setPartnerCameraOn] = useState(true);
  const [partnerMicOn, setPartnerMicOn] = useState(true);

  // Same two values as state, mirrored into refs. The effect below runs once and
  // its callbacks would otherwise close over the values from the first render
  // forever; async code reads the refs to get the *current* intent.
  const cameraOnRef = useRef(true);
  const micOnRef = useRef(true);

  // Everything that belongs to one peering session. Refs, not state: none of it
  // is render data, and rebuilding a peer connection must not re-render the UI.
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const videoSenderRef = useRef(null);
  const audioSenderRef = useRef(null);
  const signalingRef = useRef(null);
  // Bumped on every camera toggle. Opening a camera is slow (~300ms) and
  // toggleCamera is async, so clicking faster than that leaves more than one
  // getUserMedia in flight at once. Only the newest may keep its track; without
  // this the earlier ones each add a live track to the stream and the *device*
  // stays open behind them -- the camera light stays on with the UI showing
  // "camera off", which is exactly the failure that looks like a lie.
  const cameraOpRef = useRef(0);
  // Bumped every time a peering session is torn down, so async work started by
  // the old session can notice it has been outlived. See onPeerOnline.
  const peeringTokenRef = useRef(0);

  // Tell the partner what our devices are doing. They cannot work this out from
  // the stream itself: a muted mic sends silence and a stopped camera sends
  // nothing, and neither is distinguishable from a network stall. So we say it.
  const sendMediaState = useCallback(() => {
    signalingRef.current?.sendSignal({
      type: "media-state",
      camera: cameraOnRef.current,
      mic: micOnRef.current,
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

  const toggleCamera = useCallback(async () => {
    const next = !cameraOnRef.current;
    cameraOnRef.current = next;
    setCameraOn(next);
    // Claim this toggle. Any acquisition still in flight from an earlier click
    // is now stale and must throw its track away rather than attach it.
    const op = ++cameraOpRef.current;

    const stream = localStreamRef.current;
    const sender = videoSenderRef.current;

    if (!next) {
      // Off: unplug the track from the sender first, then stop the device. The
      // sender -- the slot -- stays in place, so nothing renegotiates, but the
      // camera is genuinely released and the light goes off.
      await sender?.replaceTrack(null);
      stream?.getVideoTracks().forEach((track) => {
        track.stop();
        stream.removeTrack(track);
      });
    } else if (stream) {
      // On: fetch a fresh track and plug it into the same slot. `stop()` is
      // permanent -- a stopped track can never be restarted -- so coming back
      // always means a new getUserMedia, and that's the ~300ms light-blink.
      const cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
      const videoTrack = cameraStream.getVideoTracks()[0];
      if (op !== cameraOpRef.current || !cameraOnRef.current || localStreamRef.current !== stream) {
        // Superseded by a later toggle, toggled off again, or the peering
        // session was rebuilt while the device was opening. Whoever superseded
        // us sends their own state. Stopping the track here is the whole point:
        // an abandoned track holds the camera open forever.
        videoTrack.stop();
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
    }
    // No stream at all means no partner yet, so there is nothing to do to the
    // hardware -- the flag above is pre-arm intent, honoured by openDevices().

    // Re-assign so the element picks up the changed track set.
    if (localVideoRef.current) localVideoRef.current.srcObject = stream ?? null;
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
        audio: true,
      });
      // The mic track always exists -- muting it is `enabled = false`, which
      // needs a track to be there in the first place.
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) audioTrack.enabled = micOnRef.current;
      return stream;
    }

    // `isOfferer` decides how our own media gets attached, and the two roles are
    // genuinely different -- see the transceiver block at the bottom.
    function createPeerConnection(isOfferer) {
      const connection = new RTCPeerConnection({
        iceServers,
        ...(forceRelay ? { iceTransportPolicy: "relay" } : {}),
      });

      connection.ontrack = (event) => {
        // Fires once per remote track (audio, then video). We collect them into
        // a stream we own rather than trusting `event.streams[0]`: a transceiver
        // reserved before its track exists has no stream to advertise, so
        // `event.streams` can legitimately be empty.
        if (!remoteStreamRef.current) remoteStreamRef.current = new MediaStream();
        remoteStreamRef.current.addTrack(event.track);
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = remoteStreamRef.current;
        }
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
          // Send our camera/mic state here rather than when the peering session
          // starts. signaling.js drops any message whose `session` the receiver
          // hasn't computed yet, and at session start that's a genuine race --
          // by the time the connection is up, both sides provably agree on it.
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
      // The offerer defines the m-lines, so it reserves one slot per kind here,
      // whether or not there's a track to put in it yet. That's what makes
      // turning the camera on later a plain replaceTrack into an existing slot
      // instead of a renegotiation.
      //
      // The ANSWERER must not do this. setRemoteDescription(offer) builds its
      // own transceivers from the offer's m-lines, and it will NOT adopt ones
      // made by addTransceiver -- only addTrack-created transceivers are
      // eligible for that. Pre-creating them here leaves the answerer holding
      // four: two orphans with `mid: null` that never send, plus two recvonly
      // ones from the SDP. The answer still has the right two m-lines and
      // nothing throws, so the failure is silent: media flows offerer ->
      // answerer only, and the offerer sits looking at a black box. That was
      // the one-way-video bug. The answerer fills in its tracks after
      // setRemoteDescription instead -- see attachLocalMediaToAnswer().
      if (isOfferer) {
        const stream = localStreamRef.current;
        const audioTrack = stream?.getAudioTracks()[0] ?? null;
        const videoTrack = stream?.getVideoTracks()[0] ?? null;
        const audioTransceiver = connection.addTransceiver(audioTrack ?? "audio", {
          direction: "sendrecv",
          streams: stream ? [stream] : [],
        });
        const videoTransceiver = connection.addTransceiver(videoTrack ?? "video", {
          direction: "sendrecv",
          streams: stream ? [stream] : [],
        });
        // Capture the senders now. Looking them up later with
        // getSenders().find(s => s.track?.kind === "video") breaks the moment we
        // replaceTrack(null): the sender is still there, but its track is null,
        // so the search quietly finds nothing.
        audioSenderRef.current = audioTransceiver.sender;
        videoSenderRef.current = videoTransceiver.sender;
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

      for (const transceiver of transceivers) {
        // A transceiver from a rejected or stopped m-line must be left alone:
        // both `replaceTrack` and setting `.direction` on one throw
        // InvalidStateError. Throwing here is not a cosmetic failure -- it
        // aborts before createAnswer(), so no answer is ever sent and the
        // offerer sits at `have-local-offer` forever with no clue why. An offer
        // can legitimately carry sections we don't recognise, so skip anything
        // that isn't a live audio or video slot rather than assuming.
        if (transceiver.direction === "stopped" || transceiver.currentDirection === "stopped") {
          console.warn("skipping stopped transceiver, mid", transceiver.mid);
          continue;
        }
        const kind = transceiver.receiver.track.kind;
        if (kind !== "audio" && kind !== "video") {
          console.warn("skipping transceiver of unexpected kind:", kind);
          continue;
        }

        const track = kind === "audio"
          ? stream?.getAudioTracks()[0]
          : stream?.getVideoTracks()[0];
        // A missing track is fine and expected -- it's the camera being off.
        // The slot still exists, which is the whole point.
        if (track) await transceiver.sender.replaceTrack(track);
        // Without this the transceiver stays `recvonly` (it was built from an
        // offer at a moment when we had nothing attached) and we never send.
        transceiver.direction = "sendrecv";
        // First slot of each kind wins: if an offer somehow carries two video
        // sections, the controls must drive the one we actually attached to.
        if (kind === "audio") audioSenderRef.current ??= transceiver.sender;
        else videoSenderRef.current ??= transceiver.sender;
      }
    }

    // Throw away the current peering session, devices included.
    function endPeeringSession() {
      clearTimeout(offerTimer);
      // Anything async still in flight for the session we're tearing down must
      // not be able to wire itself into the next one.
      peeringTokenRef.current += 1;

      pcRef.current?.close();
      pcRef.current = null;
      videoSenderRef.current = null;
      audioSenderRef.current = null;
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

      // Without this the partner's frozen last frame stays on screen, looking
      // exactly like a live connection.
      remoteStreamRef.current = null;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;

      // We know nothing about the next partner's devices until they tell us.
      setPartnerCameraOn(true);
      setPartnerMicOn(true);
    }

    async function applyRemoteDescription(description) {
      await pcRef.current.setRemoteDescription(description);
      remoteDescriptionSet = true;
      for (const candidate of queuedCandidates.splice(0)) {
        await pcRef.current.addIceCandidate(candidate);
      }
    }

    // How many m= sections a description carries. Two (audio + video) is what
    // this app should ever produce; anything else means something added a
    // section we didn't ask for, and that's worth seeing in the log.
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
            const stream = await openDevices();
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
              console.log("partner media-state:", payload.camera, payload.mic);
              setPartnerCameraOn(payload.camera);
              setPartnerMicOn(payload.mic);
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
              // Anything else means glare -- both sides offered at once.
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
  }, [sendMediaState]);

  return {
    status,
    cameraOn,
    micOn,
    partnerCameraOn,
    partnerMicOn,
    toggleCamera,
    toggleMic,
    localVideoRef,
    remoteVideoRef,
  };
}
