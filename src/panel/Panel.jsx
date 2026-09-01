import { useEffect, useState } from "react";
import CameraBox from "../components/CameraBox";
import ShareStage from "./ShareStage";
import { useWatchPartyCall } from "../lib/useWatchPartyCall";

// Session 3E: the call itself moved from src/App.jsx (the old web-app entry,
// deleted this session) into this document -- the panel iframe, at the
// extension's chrome-extension:// origin. Locked decision #3: this is the one
// document that can both hold the RTCPeerConnection and render a <video>,
// because a MediaStream cannot cross documents.
//
// Only the camera/mic half of useWatchPartyCall is used here. The hook still
// reserves all four transceiver slots (mic, camera, screenAudio, screenVideo --
// see mediaSlots.js) and still exports startShare/stopShare, but nothing here
// calls them. Screen share is Session 4E's job.

// Watches the camera permission for THIS origin (the extension's). Chrome will
// not show a permission prompt inside an extension iframe embedded in a web
// page, so the panel cannot ask for itself -- see src/permission/permission.js.
// This hook is how the panel finds out it needs to send you somewhere that can
// ask, and finds out again the moment you have.
function useCameraPermission() {
  const [state, setState] = useState("unknown");

  useEffect(() => {
    let cancelled = false;
    let status = null;
    const onChange = () => {
      if (!cancelled && status) setState(status.state);
    };

    navigator.permissions
      .query({ name: "camera" })
      .then((result) => {
        if (cancelled) return;
        status = result;
        setState(result.state);
        // Fires when the grant changes in ANOTHER tab -- which is exactly what
        // the permission page is. Without this the banner would sit there
        // stale until the panel was toggled off and on again.
        result.addEventListener("change", onChange);
      })
      .catch(() => {
        // Permissions.query with name:"camera" is not universally supported.
        // Unknown is treated as "don't nag" below: a missing query API is no
        // evidence of a missing grant, and a banner that can't be dismissed
        // by granting would be worse than no banner.
        if (!cancelled) setState("unknown");
      });

    return () => {
      cancelled = true;
      status?.removeEventListener("change", onChange);
    };
  }, []);

  return state;
}

// Tells the content script how wide to make this iframe. The panel cannot
// resize itself -- it does not own its own frame element -- so width is a
// message, not a style.
//
// Expanded is VIEWER-ONLY, and deliberately so: the sharer is already watching
// the real tab at 75%, and covering it with a redundant preview of itself would
// be strictly worse than leaving it alone.
function usePanelMode(expanded) {
  useEffect(() => {
    // targetOrigin "*" because the panel genuinely does not know its host
    // page's origin -- it is injected into every site. The message carries no
    // secret; content.js authenticates it by checking the sending window is
    // this frame, which a page cannot forge.
    window.parent.postMessage(
      { type: "watchparty:set-panel-mode", mode: expanded ? "expanded" : "docked" },
      "*"
    );
  }, [expanded]);
}

// Fullscreen has to be requested by THIS document on itself, never by the
// content script on the iframe: user activation is per-document, and a click
// inside this frame does not activate the parent. Works because content.js puts
// `fullscreen` in the iframe's allow list.
function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    // Listened for rather than assumed: Escape exits fullscreen without ever
    // going through our button, and a button that then lies about the state is
    // worse than no button.
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggle = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen().catch((err) => {
        console.warn("fullscreen refused:", err.name, err.message);
      });
    }
  };

  return { isFullscreen, toggle };
}

export default function Panel() {
  const { name, version } = chrome.runtime.getManifest();
  const cameraPermission = useCameraPermission();

  const {
    status,
    cameraOn,
    cameraStarting,
    devicesOpen,
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
    localScreenAudioRef,
  } = useWatchPartyCall();

  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen();
  // Only the viewer expands. `sharing` wins the tie so that a simultaneous
  // share (which media-state's tie-break resolves a beat later) never leaves
  // the sharer's own panel covering the tab they are sharing.
  const expanded = partnerSharing && !sharing;
  usePanelMode(expanded);

  // "prompt" counts as needing action, not just "denied". A prompt this
  // document is structurally unable to display is, in practice, a denial --
  // getUserMedia would reject with NotAllowedError and look identical to the
  // user having clicked Block.
  const needsPermission = cameraPermission === "prompt" || cameraPermission === "denied";

  const openPermissionPage = () => {
    // A real top-level tab, not another iframe. The whole point is a document
    // whose omnibox genuinely reads chrome-extension://<id>, which is the only
    // context Chrome will anchor this prompt to.
    chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
  };

  return (
    <div className={`panel${expanded ? " panel--expanded" : ""}`}>
      <header className="panel__header">
        <h1 className="panel__title">{name}</h1>
        <span className="panel__version">v{version}</span>
      </header>

      {/* Deliberately reads like debug output, because it is. Phone consoles
          are painful to get at, and this is the third of three consoles
          (CLAUDE.md) -- easy to forget to select in the DevTools dropdown --
          so connection state is surfaced here instead of only in a log. */}
      <p className="panel__status">{status}</p>

      {needsPermission && (
        <div className="panel__notice">
          <p className="panel__notice-text">
            Chrome can’t show a camera prompt inside this panel. Grant access
            once at the extension’s own origin and it works on every site.
          </p>
          <button type="button" className="panel__notice-button" onClick={openPermissionPage}>
            Grant camera &amp; mic access
          </button>
        </div>
      )}

      <ShareStage
        localScreenVideoRef={localScreenVideoRef}
        remoteScreenVideoRef={remoteScreenVideoRef}
        localScreenAudioRef={localScreenAudioRef}
        sharing={sharing}
        shareStarting={shareStarting}
        partnerSharing={partnerSharing}
        shareWarnings={shareWarnings}
        canShare={canShare}
        onStartShare={startShare}
        onStopShare={stopShare}
        onToggleFullscreen={toggleFullscreen}
        isFullscreen={isFullscreen}
      />

      {/* In expanded mode this becomes a floating rail over the video's
          corner rather than a column -- same components, same order, different
          container. See .panel--expanded in panel.css. */}
      <div className="panel__rail">
        <div className="panel__tiles">
        {/* Your tile carries the controls: click anywhere on it to toggle the
            camera, and the mic button appears on hover. `muted` so you don't
            hear yourself; `mirrored` is preview-only -- what your partner
            receives is unmirrored. `idle` is what stops it rendering a black
            rectangle while there is no call: the devices deliberately stay
            shut until a partner arrives. */}
          <CameraBox
            videoRef={localVideoRef}
            label="You"
            muted
            mirrored
            cameraOn={cameraOn}
            micOn={micOn}
            starting={cameraStarting}
            idle={!devicesOpen}
            interactive
            onToggleCamera={toggleCamera}
            onToggleMic={toggleMic}
          />
          {/* Display-only. Its camera/mic state arrives over the signaling
              channel as `media-state`; nothing here can change what the partner
              sends. Shares the same `devicesOpen` idle signal -- if OUR devices
              aren't open there is no peering session, so there is no partner
              stream either. */}
          <CameraBox
            videoRef={remoteVideoRef}
            label="Partner"
            cameraOn={partnerCameraOn}
            micOn={partnerMicOn}
            idle={!devicesOpen}
          />
        </div>

        {/* Placeholder for Session 5E. Reserving the space now means chat lands
            in the panel's remaining height instead of reshuffling this layout
            later. */}
        <div className="panel__chat-placeholder">chat — coming in session 5</div>
      </div>
    </div>
  );
}
