// The shared-content surface (Session 4E). Replaces the old Stage.jsx, which
// was deleted in 3E because it assumed a full-bleed page layout that a 25%
// sidebar cannot give it.
//
// Both <video> elements are ALWAYS mounted, and that is load-bearing rather
// than tidy: useWatchPartyCall assigns srcObject on these refs imperatively,
// inside startShare and wireRemoteStreams. If they were rendered only while
// `sharing || partnerSharing` were true, the ref could still be null at the
// moment of assignment -- React would not have flushed the mount yet -- and the
// stream would attach to nothing. Which one is VISIBLE is a CSS question; which
// one exists is not.
function ShareStage({
  localScreenVideoRef,
  remoteScreenVideoRef,
  localScreenAudioRef,
  sharing,
  shareStarting,
  partnerSharing,
  shareWarnings,
  canShare,
  onStartShare,
  onStopShare,
  onToggleFullscreen,
  isFullscreen,
}) {
  const idle = !sharing && !partnerSharing;

  return (
    <div className={`stage${idle ? " stage--idle" : ""}`}>
      {/* Our own capture, muted. The sharer already hears this tab through the
          hidden <audio> below; playing it here too would be a second, slightly
          offset copy of the same sound. */}
      <video
        ref={localScreenVideoRef}
        autoPlay
        playsInline
        muted
        className={`stage__video${sharing && !partnerSharing ? " stage__video--visible" : ""}`}
      />
      {/* The partner's capture. NOT muted -- this is the one and only place
          their shared tab's audio plays for us. */}
      <video
        ref={remoteScreenVideoRef}
        autoPlay
        playsInline
        className={`stage__video${partnerSharing ? " stage__video--visible" : ""}`}
      />

      {/* Never displayed, never muted. This is the whole muted-tab fix: Chrome
          stops routing a captured tab to the speakers, so the sharer needs
          their own capture played back or they watch in silence. Separate from
          the video preview above because that element is muted by design and
          may be invisible on the sharer's side. */}
      <audio ref={localScreenAudioRef} autoPlay className="stage__audio-sink" />

      {idle && (
        <div className="stage__placeholder">
          {canShare ? (
            <>
              <button
                type="button"
                className="stage__share-button"
                onClick={onStartShare}
                disabled={shareStarting}
              >
                {shareStarting ? "starting…" : "Share this tab"}
              </button>
              {/* Worth saying plainly, because it is the payoff of the whole
                  extension rewrite and it looks like something is missing. */}
              <p className="stage__hint">
                {shareStarting
                  ? "Requesting tab capture — no picker, so this is the only sign anything is happening."
                  : "No picker — this shares the tab the panel is docked in."}
              </p>
            </>
          ) : (
            <p className="stage__hint">Tab capture isn’t available here.</p>
          )}
        </div>
      )}

      {sharing && (
        <div className="stage__banner">
          <span>{shareStarting ? "starting share…" : "You’re sharing this tab"}</span>
          <button type="button" className="stage__stop-button" onClick={onStopShare}>
            Stop
          </button>
        </div>
      )}

      {partnerSharing && (
        <div className="stage__banner">
          <span>Partner is sharing</span>
          <button type="button" className="stage__stop-button" onClick={onToggleFullscreen}>
            {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          </button>
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

export default ShareStage;
