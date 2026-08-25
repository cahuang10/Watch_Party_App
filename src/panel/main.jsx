import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Panel from "./Panel.jsx";
import "./panel.css";

// This document is loaded in an iframe at the chrome-extension:// origin, so
// from Session 3E onward it is where the RTCPeerConnection and every <video>
// element live (locked decision #3). Its errors do NOT appear in the host
// page's console -- pick the panel.html context in the DevTools dropdown.

// Exposes window.__loopbackTest() -- the first thing to run when a connection
// looks wrong, since it needs no camera, no permission, and no second device.
// See SESSION_3_POSTMORTEM.md Part 5.
//
// NOTE: `import.meta.env.DEV` is false in a `vite build`, and this panel is
// ONLY ever loaded from a build -- there is no dev server in the extension
// architecture. So this helper is currently never present. Session 3E should
// drop the gate (or swap it for an explicit flag) when it starts needing the
// test; the import is kept here so the wiring isn't forgotten.
if (import.meta.env.DEV) {
  import("../lib/loopbackTest").then(({ runLoopbackTest }) => {
    window.__loopbackTest = runLoopbackTest;
    console.log("dev helper ready: window.__loopbackTest()");
  });
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Panel />
  </StrictMode>
);
