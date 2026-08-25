import CameraBox from "./components/CameraBox";
import Stage from "./components/Stage";
import { useWatchPartyCall } from "./lib/useWatchPartyCall";
import "./App.css";

function App() {
  // Everything about the call -- signaling, the peer connection, the devices,
  // and (Session 4) screen share -- lives in the hook. This component is just
  // what it looks like.
  const {
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
  } = useWatchPartyCall();

  return (
    <div className="app">
      <h1>Watch Party App</h1>
      {/* Deliberately reads like debug output, because it is. Phone consoles are
          painful to get at, so connection state is surfaced in the UI instead. */}
      <p className="status">{status}</p>

      {/* Teleparty-style layout: the shared content is the stage, filling most
          of the view. The camera tiles (and, from Session 5, chat) float over
          its top-left corner rather than living in their own row -- this rail
          is deliberately a self-contained block, because it's exactly what
          later lifts out into the Document Picture-in-Picture window (locked
          decision #7). */}
      <div className="stage-area">
        <Stage
          localScreenVideoRef={localScreenVideoRef}
          remoteScreenVideoRef={remoteScreenVideoRef}
          sharing={sharing}
          shareStarting={shareStarting}
          partnerSharing={partnerSharing}
          shareWarnings={shareWarnings}
          canShare={canShare}
          onStartShare={startShare}
          onStopShare={stopShare}
        />

        <div className="camera-rail">
          <div className="camera-rail__tiles">
            {/* Your tile carries the controls: click anywhere on it to toggle
                the camera, and the mic button appears on hover. `muted` so you
                don't hear yourself; `mirrored` is preview-only -- what your
                partner receives is unmirrored. */}
            <CameraBox
              videoRef={localVideoRef}
              label="You"
              muted
              mirrored
              cameraOn={cameraOn}
              micOn={micOn}
              starting={cameraStarting}
              interactive
              onToggleCamera={toggleCamera}
              onToggleMic={toggleMic}
            />
            {/* Display-only. Its camera/mic state arrives over the signaling
                channel as `media-state`; nothing here can change what the
                partner sends. */}
            <CameraBox
              videoRef={remoteVideoRef}
              label="Partner"
              cameraOn={partnerCameraOn}
              micOn={partnerMicOn}
            />
          </div>

          {/* Placeholder for Session 5. Reserving the space now means chat
              lands inside the same corner rail instead of reshuffling this
              layout later. */}
          <div className="camera-rail__chat-placeholder">chat — coming in session 5</div>
        </div>
      </div>
    </div>
  );
}

export default App;
