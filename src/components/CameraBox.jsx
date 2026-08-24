import "./CameraBox.css";

// Presentational only -- it holds no state and decides nothing.
//
// `cameraOn` / `micOn` are the *real* device states. For "You" they're your own;
// for "Partner" they arrive over the signaling channel as `media-state`
// messages. They can't be inferred from the incoming stream: a muted mic sends
// silence and a stopped camera sends nothing, and neither is distinguishable
// from a network stall. So the state is told, not guessed.
function CameraBox({
  videoRef,
  label,
  muted = false,
  mirrored = false,
  cameraOn = true,
  micOn = true,
}) {
  return (
    <div className="camera-box">
      {/* Always mounted, even with the camera off. useWatchPartyCall sets
          srcObject on this element imperatively -- if it unmounted while the
          camera was off, the ref would go stale and the stream wouldn't
          reattach when it came back. Hiding it is the overlay's job. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className={`camera-box__video${mirrored ? " camera-box__video--mirrored" : ""}`}
      />

      {/* Opaque, so it fully covers whatever frame the video element is holding
          on to underneath. */}
      {!cameraOn && (
        <div className="camera-box__placeholder">
          <span className="camera-box__emoji">🫥</span>
          <span className="camera-box__placeholder-text">camera off</span>
        </div>
      )}

      <div className="camera-box__footer">
        <span className="camera-box__name">{label}</span>
        {!micOn && (
          <span className="camera-box__badge" title={`${label} is muted`}>
            🔇
          </span>
        )}
      </div>
    </div>
  );
}

export default CameraBox;
