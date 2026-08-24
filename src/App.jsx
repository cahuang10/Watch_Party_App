import CameraBox from "./components/CameraBox";
import { useWatchPartyCall } from "./lib/useWatchPartyCall";
import "./App.css";

function App() {
  // Everything about the call -- signaling, the peer connection, the devices --
  // lives in the hook. This component is just what it looks like.
  const {
    status,
    cameraOn,
    micOn,
    partnerCameraOn,
    partnerMicOn,
    toggleCamera,
    toggleMic,
    localVideoRef,
    remoteVideoRef,
  } = useWatchPartyCall();

  return (
    <div className="app">
      <h1>Watch Party App</h1>
      {/* Deliberately reads like debug output, because it is. Phone consoles are
          painful to get at, so connection state is surfaced in the UI instead. */}
      <p className="status">{status}</p>

      <div className="videos">
        {/* `muted` on the local box so you don't hear yourself. `mirrored` is
            preview-only -- what gets sent to your partner is unmirrored. */}
        <CameraBox
          videoRef={localVideoRef}
          label="You"
          muted
          mirrored
          cameraOn={cameraOn}
          micOn={micOn}
        />
        {/* Display-only. Its camera/mic state arrives over the signaling channel
            as `media-state`; nothing here can change what the partner sends. */}
        <CameraBox
          videoRef={remoteVideoRef}
          label="Partner"
          cameraOn={partnerCameraOn}
          micOn={partnerMicOn}
        />
      </div>

      {/* These act on *your* devices only, and your partner sees the result. */}
      <div className="controls">
        <button
          type="button"
          className={`control${cameraOn ? "" : " control--off"}`}
          onClick={toggleCamera}
          aria-pressed={!cameraOn}
        >
          {cameraOn ? "Camera on" : "Camera off"}
        </button>
        <button
          type="button"
          className={`control${micOn ? "" : " control--off"}`}
          onClick={toggleMic}
          aria-pressed={!micOn}
        >
          {micOn ? "Mic on" : "Mic muted"}
        </button>
      </div>
    </div>
  );
}

export default App;
