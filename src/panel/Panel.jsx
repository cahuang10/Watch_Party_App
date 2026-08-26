import { useEffect, useState } from "react";
import CameraBox from "../components/CameraBox";
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
  } = useWatchPartyCall();

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
    <div className="panel">
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
  );
}
