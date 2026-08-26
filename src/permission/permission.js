// A one-time permission bootstrap, and the reason it has to exist as its own
// top-level page rather than happening inside the panel.
//
// --- the problem ----------------------------------------------------------
// Chrome will not display a camera/microphone permission PROMPT whose
// requesting origin is a chrome-extension:// document embedded as a subframe
// inside a web page. There is nowhere honest to anchor such a prompt: the
// omnibox shows youtube.com, but the origin asking is the extension. Rather
// than show something spoofable, Chrome auto-denies -- getUserMedia rejects
// with NotAllowedError, which is byte-for-byte the same error you get when a
// user clicks "Block". No prompt appears in any of the three consoles.
//
// This is NOT the same problem as Permissions-Policy delegation. That one is
// already solved: content.js sets allow="camera; microphone" on the iframe,
// which is necessary but not sufficient. Delegation says the frame is ALLOWED
// to ask. This page is about there being an existing grant so it doesn't have
// to.
//
// --- the fix --------------------------------------------------------------
// Media permissions are stored per ORIGIN. Ask once from a top-level document
// at the extension's own origin -- this page, opened in a real tab, where the
// omnibox genuinely reads chrome-extension://<id> and the prompt is honest --
// and Chrome records the grant against that origin. The panel iframe shares
// that origin, so from then on its getUserMedia finds an existing grant and
// resolves without needing a prompt it could never have shown.
//
// Once per browser profile, not once per site. That is the entire payoff of
// locked decision #3 putting the peer connection at the extension origin.

import "./permission.css";

const root = document.getElementById("root");

function render({ heading, body, tone }) {
  root.replaceChildren();

  const h1 = document.createElement("h1");
  h1.textContent = heading;
  h1.className = `heading heading--${tone}`;

  const p = document.createElement("p");
  p.className = "body";
  // textContent, not innerHTML: this page has no untrusted input today, but an
  // extension page is exactly where an innerHTML habit turns into a real
  // problem later.
  p.textContent = body;

  root.append(h1, p);
}

async function requestAccess() {
  render({ heading: "Asking for camera and microphone…", body: "Click Allow in the prompt above.", tone: "pending" });

  let stream;
  try {
    // Both, together, in one call -- the panel opens both as one stream too
    // (openDevices in useWatchPartyCall), so granting them separately would
    // leave the panel prompting again for whichever half was missed.
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    if (err.name === "NotAllowedError") {
      render({
        heading: "Blocked",
        body:
          "Chrome has this extension's camera access set to Block. Click the camera icon " +
          "in the address bar, change it to Allow, then reload this page.",
        tone: "bad",
      });
    } else if (err.name === "NotFoundError") {
      render({
        heading: "No camera or microphone found",
        body: `Chrome reported: ${err.name}. Check the device is connected and not in use by another app.`,
        tone: "bad",
      });
    } else {
      render({ heading: "Something went wrong", body: `${err.name}: ${err.message}`, tone: "bad" });
    }
    return;
  }

  // Release immediately. The GRANT is what we came for and it outlives the
  // stream; holding the tracks open here would leave the camera light burning
  // on a tab whose whole job is already done -- the exact failure Session 3
  // spent an evening on, reintroduced in a new place.
  stream.getTracks().forEach((track) => track.stop());

  render({
    heading: "Camera and microphone granted",
    body: "You can close this tab. The Watch Party panel will now open your camera when your partner joins.",
    tone: "good",
  });
}

requestAccess();
