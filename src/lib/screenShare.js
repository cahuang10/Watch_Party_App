// Everything about capturing and quality-tuning a screen share track. Kept
// separate from useWatchPartyCall.js because none of this is WebRTC negotiation
// -- it's getDisplayMedia and RTCRtpSender configuration, which is a different
// concept worth its own file.

// Locked decision #2 (CLAUDE.md): tab sharing only, never a window or the whole
// screen -- tab AUDIO capture only works reliably for tab shares in Chrome.
// `monitorTypeSurfaces: "exclude"` enforces this in the picker itself by
// removing the "Entire Screen" option, rather than only asking nicely in the
// UI copy. `displaySurface: "browser"` is a *request*, not a filter -- Chrome
// still lets the user pick a window or a screen if the picker offers them, so
// the result has to be checked afterward (see the warnings below), not trusted
// because we asked.
//
// EC/NS/AGC are explicitly OFF here. Those are voice-call processing --
// correct for a microphone, wrong for a shared movie or song, which they would
// visibly mangle. This is a *different* audio constraint object than the mic's
// in useWatchPartyCall.js, and that difference is deliberate, not an oversight.
const DISPLAY_MEDIA_CONSTRAINTS = {
  video: {
    displaySurface: "browser",
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 60 },
  },
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
  // Chrome-specific getDisplayMedia extensions.
  selfBrowserSurface: "exclude", // don't offer "share this app's own tab"
  systemAudio: "exclude", // no "share system audio" checkbox -- tab audio only
  monitorTypeSurfaces: "exclude", // no "Entire Screen" option in the picker
  surfaceSwitching: "include", // lets the user switch which tab is shared mid-share
};

// Starts a screen capture and reports back what actually happened, since the
// constraints above are requests the browser is free to only partly honour.
// Returns { stream, warnings } instead of throwing on a "wrong but not
// broken" pick -- a window instead of a tab is a real capture, just missing
// audio, and the caller should still be able to show it.
export async function captureScreen() {
  const stream = await navigator.mediaDevices.getDisplayMedia(DISPLAY_MEDIA_CONSTRAINTS);
  const warnings = [];

  const videoTrack = stream.getVideoTracks()[0];
  const settings = videoTrack?.getSettings() ?? {};
  // Unrecognised or unhonoured constraint members fail silently -- the browser
  // just ignores them -- so `displaySurface` in the *actual* track settings is
  // the only reliable way to know what the user picked.
  if (settings.displaySurface && settings.displaySurface !== "browser") {
    warnings.push(
      `You shared a ${settings.displaySurface === "monitor" ? "screen" : "window"}, not a tab. ` +
        "Tab audio capture only works for tab shares in Chrome, so your partner won't hear this share's sound."
    );
  }

  if (stream.getAudioTracks().length === 0) {
    warnings.push(
      'No audio track was captured. Make sure "Also share tab audio" is checked in the share picker.'
    );
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
