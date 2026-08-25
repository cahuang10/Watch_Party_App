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

  // One number, two derived widths. The panel and the page must always be
  // complements -- if these drift, the page either overlaps the panel or leaves
  // a dead strip -- so neither is written as a literal.
  const PANEL_PERCENT = 25;
  const PANEL_WIDTH = `${PANEL_PERCENT}%`;
  const PAGE_WIDTH = `${100 - PANEL_PERCENT}%`;

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
      removeSqueeze();
      return;
    }
    document.documentElement.appendChild(createPanel());
    applySqueeze();
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

  // The squeeze is split across TWO elements on purpose -- this is the least
  // obvious thing in this file, so it's worth spelling out.
  //
  // <html> gets the WIDTH. That's what shrinks normal document flow (text,
  // block layout, grids) down to 75%.
  //
  // <body> gets the TRANSFORM, not <html>. A transform makes its element the
  // containing block for every `position: fixed` descendant inside it (per the
  // CSS spec) -- which is what makes YouTube's fixed masthead and player
  // measure themselves against the new 75% box instead of the full viewport.
  // `translateX(0)` moves nothing; it exists purely to trigger this.
  //
  // The panel is a fixed child of <html>, not <body> (see createPanel/
  // togglePanel). If the transform went on <html> instead -- which is what an
  // earlier draft of this recipe in CLAUDE.md said -- <html> would become the
  // containing block for ITS OWN fixed descendants too, including our panel,
  // and `right: 0` would resolve against the squeezed box rather than the
  // viewport. Measured on real youtube.com before writing this: that version
  // squeezes the page correctly but drags the panel to 720-960px (inside the
  // page, 240px wide) instead of 960-1280px (the actual right edge, 320px
  // wide). Putting the transform on <body> instead keeps <html> transform-free,
  // so the panel -- living outside <body> -- still resolves against the real
  // viewport while everything inside <body> gets squeezed.
  //
  // Known limitation, not fixed here: `window.innerWidth` does not change --
  // only element boxes do. A site that computes its own layout from
  // `window.innerWidth` in JS (rather than from CSS) will size itself for the
  // full width regardless of the resize event below. On YouTube's watch page
  // this clips about 48px of the suggested-videos rail under the panel.
  // Cosmetic, not a layout break, and not worth `overflow-x: hidden` on
  // <body> (which risks disabling page scroll) for MVP.
  let savedHtmlWidth = null;
  let savedBodyTransform = null;

  function applySqueeze() {
    const html = document.documentElement;
    const body = document.body;

    savedHtmlWidth = html.style.width;
    savedBodyTransform = body.style.transform;

    html.style.width = PAGE_WIDTH;
    body.style.transform = "translateX(0)";

    // Nudges any site JS listening for resize (ResizeObserver, window.onresize
    // handlers) to recompute against the new box sizes. Does not change
    // window.innerWidth itself -- see the limitation noted above.
    window.dispatchEvent(new Event("resize"));
  }

  function removeSqueeze() {
    const html = document.documentElement;
    const body = document.body;

    // Restore exactly what was there before, not just "". A page (or its own
    // JS) may have set an inline width/transform of its own before we ever
    // ran; blanking unconditionally would erase that instead of the squeeze.
    html.style.width = savedHtmlWidth;
    body.style.transform = savedBodyTransform;
    savedHtmlWidth = null;
    savedBodyTransform = null;

    window.dispatchEvent(new Event("resize"));
  }
})();
