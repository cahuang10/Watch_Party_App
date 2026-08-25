import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Dev-only: exposes window.__loopbackTest() in the console. See
// SESSION_3_POSTMORTEM.md Part 5 for why this is the first thing to run before
// touching a real camera or display when something about the connection is
// suspected -- it needs no camera, no permission, no second device.
if (import.meta.env.DEV) {
  import('./lib/loopbackTest').then(({ runLoopbackTest }) => {
    window.__loopbackTest = runLoopbackTest;
    console.log("dev helper ready: window.__loopbackTest()");
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
