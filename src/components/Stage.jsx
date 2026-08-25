import "./Stage.css";

// The shared-content surface -- Session 4's addition. Both video elements are
// ALWAYS mounted, same reasoning as CameraBox's single <video>: the hook sets
// srcObject on these refs imperatively, and an unmounted element would go
// stale and never reattach when a share starts. Which one is visible is a CSS
// question, driven by `sharing` / `partnerSharing`, not a mount/unmount one.
function Stage({
  localScreenVideoRef,
  remoteScreenVideoRef,
  sharing,
  shareStarting,
  partnerSharing,
  shareWarnings,
  canShare,
  onStartShare,
  onStopShare,
}) {
  const idle = !sharing && !partnerSharing;

  return (
    <div className="stage">
      {/* Our own capture. Muted: we're already hearing this tab's audio from
          the tab itself, so playing our own captured copy on top of it would
          be a second, out-of-sync copy of the same sound. */}
      <video
        ref={localScreenVideoRef}
        autoPlay
        playsInline
        muted
        className={`stage__video${sharing ? " stage__video--visible" : ""}`}
      />
      {/* The partner's capture. NOT muted -- this is the one and only place
          their shared tab's audio plays. */}
      <video
        ref={remoteScreenVideoRef}
        autoPlay
        playsInline
        className={`stage__video${partnerSharing ? " stage__video--visible" : ""}`}
      />

      {idle && (
        <div className="stage__placeholder">
          <span className="stage__emoji">🖥️</span>
          {canShare ? (
            <>
              <button type="button" className="stage__share-button" onClick={onStartShare}>
                Share your screen
              </button>
              {/* Locked decision #2, stated where it actually matters -- right
                  before the browser's tab picker opens. */}
              <p className="stage__hint">
                Share a <strong>tab</strong>, not a window or your whole screen —
                tab audio only comes through for tab shares in Chrome.
              </p>
            </>
          ) : (
            <p className="stage__hint">
              This browser can't share a screen. Share from the other device instead.
            </p>
          )}
        </div>
      )}

      {sharing && (
        <div className="stage__banner">
          <span>{shareStarting ? "starting share…" : "You're sharing"}</span>
          <button type="button" className="stage__stop-button" onClick={onStopShare}>
            Stop sharing
          </button>
        </div>
      )}

      {partnerSharing && !sharing && (
        <div className="stage__banner">
          <span>Partner is sharing</span>
        </div>
      )}

      {sharing && shareWarnings.length > 0 && (
        <div className="stage__warnings">
          {shareWarnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}
    </div>
  );
}

export default Stage;
