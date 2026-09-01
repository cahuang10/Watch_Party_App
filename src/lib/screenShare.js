// Everything about capturing and quality-tuning a tab share. Kept separate from
// useWatchPartyCall.js because none of this is WebRTC negotiation -- it's
// capture and RTCRtpSender configuration, which is a different concept worth
// its own file.
//
// Session 4E replaced the capture half of this file. It used to call
// getDisplayMedia and open Chrome's tab picker; it now goes through
// chrome.tabCapture, which needs no picker because the extension already has
// permission for the tab. applyScreenQuality and preferVideoCodecs below are
// UNCHANGED -- they were always about configuring the sender, not about how the
// pixels were acquired, which is exactly why a capture-source rewrite leaves
// them alone.

// How long to wait for the content script to come back with a stream id. The
// round trip is panel -> content script -> service worker and back, and a
// sleeping MV3 worker has to spin up somewhere in the middle, so this is not
// instant. It still needs a ceiling: a stream id expires quickly if unused, so
// a request that hangs must FAIL rather than eventually resolve into an id
// that is already dead by the time getUserMedia sees it.
const STREAM_ID_TIMEOUT_MS = 3000;

let nextRequestId = 1;

// Ask the content script for a tab-capture stream id.
//
// The panel cannot call chrome.tabCapture.getMediaStreamId() itself -- an
// extension-origin iframe embedded in a web page is not one of the documented
// calling contexts (service worker, top-level extension page, popup). And the
// service worker cannot trust the panel to say which tab it lives in. So the
// request goes out through the content script, which the worker sees as
// unambiguously tab-scoped. See content.js and background.js for the other two
// legs.
//
// A MediaStream could never make this trip. A stream ID is a string, and that
// is the entire reason this architecture works at all.
function requestTabCaptureStreamId() {
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId++;

    const onMessage = (event) => {
      // The panel's parent is the host page, so this listener sees every
      // postMessage on the page. Match on our own message type AND our own
      // request id -- the id also stops a late reply from a superseded request
      // resolving a newer one.
      const data = event.data;
      if (data?.type !== "watchparty:tab-capture-id-result") return;
      if (data.requestId !== requestId) return;

      cleanup();
      if (data.ok) resolve(data.streamId);
      else reject(new Error(data.error ?? "tab capture was refused"));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for a tab capture stream id"));
    }, STREAM_ID_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    }

    window.addEventListener("message", onMessage);
    // targetOrigin "*" is correct here and only here: this message carries no
    // secret (it is a bare request with an id), and the panel genuinely does
    // not know its host page's origin -- it is injected into every site. The
    // REPLY, which carries the capability, is targeted precisely; see
    // replyToPanel in content.js.
    window.parent.postMessage({ type: "watchparty:request-tab-capture-id", requestId }, "*");
  });
}

// Capture the tab this panel is docked in.
//
// Deliberately the same contract captureScreen() had -- returns
// { stream, warnings }, throws on failure -- so useWatchPartyCall's startShare
// needed only an import swap.
//
// The constraints below are the legacy `mandatory` shape, which looks archaic
// next to the rest of this codebase and is nonetheless still required: tab
// capture predates the standard Constraints spec and has never been moved onto
// it. Resolution and framerate go INSIDE the same mandatory object rather than
// alongside it as standard keys -- mixing the two styles in one constraint
// object is how you earn an OverconstrainedError.
export async function captureTab() {
  const streamId = await requestTabCaptureStreamId();

  const stream = await navigator.mediaDevices.getUserMedia({
    // Audio processing is explicitly OFF, and this is the single most
    // important thing in this object.
    //
    // Echo cancellation, noise suppression and automatic gain control are
    // VOICE-CALL processing: correct for a microphone, actively destructive on
    // a shared movie or song, which they mangle. AGC in particular pumps the
    // level up and down chasing a "voice" that is really a soundtrack.
    //
    // This existed in the getDisplayMedia version as three standard
    // constraints, was dropped in the 4E rewrite, and the result was audio the
    // partner described as "a chainsaw running". Restored here in the legacy
    // `goog` spelling because tab capture uses the legacy `mandatory` dict --
    // the standard names are not honoured inside it, and mixing the two styles
    // in one constraint object earns an OverconstrainedError.
    //
    // The mic's constraints in useWatchPartyCall.js turn these same three ON,
    // for the opposite and equally deliberate reason. If you are ever tempted
    // to unify them, don't: they are different sources with opposite needs.
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        googEchoCancellation: false,
        googAutoGainControl: false,
        googNoiseSuppression: false,
        googHighpassFilter: false,
      },
    },
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30,
      },
    },
  });

  const warnings = [];
  // The old "you shared a window, not a tab" warning is gone: there is no
  // picker any more, so there is nothing to mispick. This one survives because
  // it is still reachable -- a tab with no audio playing yields no audio track.
  if (stream.getAudioTracks().length === 0) {
    warnings.push("No audio track was captured — your partner won't hear this tab.");
  }

  return { stream, warnings };
}

// contentHint tells the encoder what kind of content this is, which changes
// how it trades detail for smoothness under bandwidth pressure. "motion" is
// correct for video playback -- it favours smooth motion over a sharp still
// frame, which is backwards for e.g. sharing a slide deck but right for a
// movie or a game.
//
// The bitrate cap is separate from contentHint: browsers default the encoder's
// target bitrate conservatively (safe on an average connection, wasteful on a
// good one), and 1080p30 needs real headroom to look like anything other than
// a blurry mess. 2.5-4 Mbps is section 3's range; 3 is the middle of it.
// `degradationPreference: "maintain-framerate"` tells the encoder that if it
// has to give something up under pressure, drop resolution before it drops
// smoothness -- motion is what makes it watchable.
export async function applyScreenQuality(sender, track) {
  track.contentHint = "motion";

  const params = sender.getParameters();
  // A sender that has never had setParameters called on it can report an empty
  // encodings array -- there's nothing to constrain yet, so add a slot rather
  // than writing into one that doesn't exist.
  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{}];
  }
  params.encodings[0].maxBitrate = 3_000_000; // 3 Mbps, per SPEC.md section 3
  params.degradationPreference = "maintain-framerate";
  await sender.setParameters(params);
}

// Reorders (never filters) the codec list a transceiver will offer/answer
// with, putting the named codecs first. Filtering instead of reordering would
// mean negotiation fails outright the day one side lacks hardware support for
// the preferred codec; reordering keeps H.264/VP8 in the list as a fallback
// while still asking for the better one first.
//
// Must run before createOffer() (offerer) or createAnswer() (answerer) --
// setCodecPreferences only affects SDP generated *after* it's called.
export function preferVideoCodecs(transceiver, preferredNames) {
  const { codecs } = RTCRtpSender.getCapabilities("video");
  const rank = (codec) => {
    const index = preferredNames.findIndex((name) =>
      codec.mimeType.toLowerCase() === `video/${name.toLowerCase()}`
    );
    return index === -1 ? preferredNames.length : index;
  };
  const ordered = [...codecs].sort((a, b) => rank(a) - rank(b));
  transceiver.setCodecPreferences(ordered);
}
