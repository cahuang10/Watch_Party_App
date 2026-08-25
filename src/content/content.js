// The content script. Runs in the HOST PAGE's world -- YouTube's JS and CSS can
// see and touch anything this file puts in the DOM, so everything it creates is
// namespaced and styled inline rather than through a stylesheet the page could
// override.
//
// Its only job in Session 1E is mounting and unmounting the panel iframe.
// It deliberately does NOT hold the peer connection: this world dies on
// navigation and a MediaStream can't cross documents anyway (locked decision
// #3). The panel iframe is where the real work happens.
//
// Errors from this file appear in the HOST PAGE's DevTools console.
//
// Built by pass B of the build as a single IIFE with no imports, because MV3
// content scripts cannot be ES modules.

(() => {
  // chrome.scripting.executeScript can land on a tab that already has this
  // script from the declarative `content_scripts` entry -- the service worker
  // has no reliable way to know. Without this guard we'd register a second
  // onMessage listener and every click would toggle the panel twice, i.e. do
  // nothing visible at all.
  if (window.__watchPartyContentLoaded) return;
  window.__watchPartyContentLoaded = true;

  const PANEL_ID = "watch-party-panel";
  const PANEL_WIDTH = "25%";

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "watchparty:toggle-panel") return;

    togglePanel();

    // Answering is what makes the service worker's `sendMessage` promise
    // resolve. Without a response it rejects with "message port closed", which
    // the worker would read as "no content script here" and react by injecting
    // a second copy.
    sendResponse({ ok: true });
  });

  function togglePanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) {
      existing.remove();
      return;
    }
    document.documentElement.appendChild(createPanel());
  }

  function createPanel() {
    const iframe = document.createElement("iframe");
    iframe.id = PANEL_ID;

    // chrome-extension:// URL, so the panel runs at the EXTENSION's origin, not
    // the page's. That's what makes one camera permission work on every site.
    // Loading it from a page requires "panel.html" to be listed in
    // web_accessible_resources -- without that the frame silently stays blank.
    iframe.src = chrome.runtime.getURL("panel.html");

    // Permissions-Policy delegation. A cross-origin iframe is denied camera and
    // mic by default, and the resulting getUserMedia failure is a
    // NotAllowedError -- indistinguishable from the user clicking "Block".
    // Nothing needs media until Session 3E; setting it now costs a line and
    // saves an afternoon.
    iframe.allow = "camera; microphone";

    // Inline styles, not a stylesheet: the page can't out-specify what's in the
    // style attribute without !important, and this needs no build-time CSS.
    Object.assign(iframe.style, {
      position: "fixed",
      top: "0",
      right: "0",
      width: PANEL_WIDTH,
      height: "100vh",
      border: "none",
      // Above essentially anything a site sets. Not a guarantee -- z-index only
      // compares within a stacking context -- but it wins in the common case.
      zIndex: "2147483647",
      colorScheme: "normal",
    });

    return iframe;
  }

  // Session 2E adds the page squeeze here: a width, a transform so
  // fixed-position descendants are squeezed too, and a dispatched resize event
  // so the site re-lays-out. Until then the panel simply overlaps the page.
  // That is expected for this session, not a bug.
  //
  // One thing 2E has to resolve, noted here so it isn't a surprise: the panel
  // is appended to <html> (rather than <body>, which SPAs sometimes replace
  // wholesale). CLAUDE.md's squeeze recipe puts the transform on <html> -- but a
  // transformed <html> becomes the containing block for its own fixed
  // descendants, including this panel, so `right: 0` would resolve against the
  // squeezed 75% box and slide the panel inward with the page. Whichever
  // element gets the transform, the panel has to sit outside it.
})();
