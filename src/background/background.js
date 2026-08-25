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
