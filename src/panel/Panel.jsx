// Session 1E placeholder. Deliberately imports nothing from src/lib -- this
// session proves the shell loads, nothing more. Session 3E replaces the body of
// this component with the camera tiles and the call hook.

export default function Panel() {
  // Read straight from the manifest rather than hardcoding, so the version on
  // screen can't drift from the version Chrome actually loaded.
  const { name, version } = chrome.runtime.getManifest();

  return (
    <div className="panel">
      <header className="panel__header">
        <h1 className="panel__title">{name}</h1>
        <span className="panel__version">v{version}</span>
      </header>

      <p className="panel__note">
        Scaffold — session 1E. No call, no capture, no chat yet.
      </p>
    </div>
  );
}
