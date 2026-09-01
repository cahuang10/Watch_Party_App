// The service worker. Its ONLY job is brokering (SPEC.md section 1): it owns no
// UI, holds no media, and stores no state.
//
// MV3 service workers are killed after ~30s idle and restarted on the next
// event, so nothing may live in module scope across events -- anything assigned
// at the top level of this file is gone by the time the next click arrives.
// Every listener below has to work from a cold start.
//
// Errors from this file appear on the extension's card at chrome://extensions,
// NOT in any page's DevTools. See the three-consoles table in workflow.md.

const TOGGLE_PANEL = { type: "watchparty:toggle-panel" };

// Path is relative to dist/, because that's the extension root once built.
// Pass B of the build (vite.config.content.js) is what guarantees this file
// exists at exactly this name.
const CONTENT_SCRIPT_FILE = "content.js";

// Fires only because manifest.json declares `"action": {}` with no
// `default_popup`. The moment a popup is added, Chrome opens the popup instead
// and this listener stops firing -- silently, with no error anywhere.
chrome.action.onClicked.addListener((tab) => {
  // The listener itself can't be async: returning a promise from an action
  // handler means nothing to Chrome, and an unhandled rejection here surfaces
  // as a red error on the extension card with no useful stack.
  togglePanelInTab(tab).catch((error) => {
    console.error("[watch party] toggle failed:", error);
  });
});

async function togglePanelInTab(tab) {
  // Tabs that aren't real web content (the New Tab page in some states, tabs
  // still being created) can arrive without an id.
  if (!tab?.id) {
    console.warn("[watch party] no tab id on the clicked tab; nothing to do.");
    return;
  }

  // Try talking to the content script that manifest.json should already have
  // injected declaratively.
  if (await sendToggle(tab.id)) return;

  // We get here when there is no content script listening in that tab. The
  // failure looks like:
  //
  //   "Could not establish connection. Receiving end does not exist."
  //
  // which is NOT a bug -- content scripts are not injected retroactively, so
  // every tab that was already open when the extension was installed or
  // reloaded has none. Injecting on demand is the documented fix, and it needs
  // both the "scripting" permission and host permission for the tab (hence
  // "<all_urls>" in host_permissions).
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [CONTENT_SCRIPT_FILE],
    });
  } catch (error) {
    // Expected and unavoidable on pages Chrome protects: chrome:// pages, the
    // Chrome Web Store, other extensions' pages, view-source:, and the built-in
    // PDF viewer. No extension can inject there. Say so plainly rather than
    // letting it look like a bug in our code.
    console.warn(
      `[watch party] can't inject into ${tab.url ?? "this tab"} -- ` +
        "Chrome blocks extensions on browser-internal pages. Reason:",
      error.message
    );
    return;
  }

  // The script is in now, so the same message must land this time. If it
  // doesn't, that IS a real bug (a syntax error in content.js would do it), so
  // let this one surface instead of swallowing it.
  if (!(await sendToggle(tab.id))) {
    console.error(
      "[watch party] content.js was injected but still isn't answering. " +
        "Check the page's DevTools console for an error inside content.js."
    );
  }
}

// Returns true if the message was delivered, false if nobody was listening.
// Separated out because we send the identical message twice and only the first
// failure is routine.
async function sendToggle(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, TOGGLE_PANEL);
    return true;
  } catch {
    return false;
  }
}

// --- tab capture brokering (Session 4E) -----------------------------------
//
// Why the service worker does this at all, when the panel is the document that
// actually consumes the stream: `chrome.tabCapture.getMediaStreamId()` has a
// documented list of contexts it may be called from -- the service worker, a
// top-level extension page, and a popup. An extension-origin iframe embedded
// in a web page (our panel) is not on that list.
//
// And why the request arrives via the CONTENT SCRIPT rather than straight from
// the panel: this handler's entire security model is `sender.tab.id`. The docs
// guarantee that field "when the connection was opened from a tab (including
// content scripts)" but say nothing definitive about an embedded extension
// iframe, so relying on it there would be building on an unverified promise.
// A content script is unambiguous. The panel therefore postMessages its
// request to the content script, which relays it here.
//
// The stream ID is a string, which is exactly why this indirection is possible
// at all -- IDs cross contexts freely, MediaStreams never do (locked decision
// #3, and the reason an offscreen document doesn't solve the panel's problem).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "watchparty:request-tab-capture-id") return;

  const tabId = sender.tab?.id;
  if (!tabId) {
    // Means the message did NOT come from a content script. Refuse rather than
    // guessing a tab -- capturing the wrong tab would be worse than failing.
    sendResponse({ ok: false, error: "no tab id on sender; request must come via the content script" });
    return; // synchronous response, no need to hold the channel open
  }

  chrome.tabCapture
    // targetTabId and consumerTabId are the SAME tab here, and that's the
    // documented case rather than a trick: consumerTabId exists so that a
    // frame inside tab X may consume a capture of tab X. Omitting it would
    // restrict the id to the caller's own render process -- the service
    // worker's -- which the panel is not in, so it must always be passed.
    .getMediaStreamId({ targetTabId: tabId, consumerTabId: tabId })
    .then((streamId) => sendResponse({ ok: true, streamId }))
    .catch((error) => {
      console.error("[watch party] getMediaStreamId failed:", error);
      sendResponse({ ok: false, error: error.message });
    });

  // Required: without it the channel closes before the promise above settles
  // and the caller's sendMessage rejects with "message port closed".
  return true;
});
