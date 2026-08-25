# Working with Claude Code — Watch Party extension

Updated for the extension architecture. Keep it open in a second window while you work.

---

## Part 1: Setup

Claude Code is already installed and the repo exists. What changes for the extension:

### No dev server, no deploy

`npm run dev` and Vercel are gone. The loop is:

1. `npm run build` → produces the extension folder (`dist/`)
2. `chrome://extensions` → refresh the extension card
3. Reload the page you're testing on

Slower than Vite's hot reload. That's a real cost of this architecture.

### Loading it the first time

1. `chrome://extensions`
2. **Developer mode** on (top right)
3. **Load unpacked** → select `dist/`
4. Pin the extension so the icon is visible

### Camera permission, once

Extensions have their own origin, so camera permission is granted once and works on every site.

1. Copy the extension ID from `chrome://extensions`
2. Open `chrome-extension://<ID>/panel.html` in a tab
3. Allow camera
4. Close the tab

### Three consoles — know which to check

This is the biggest day-to-day difference from web development.

| Where the code runs | Where errors appear |
|---|---|
| Service worker (`background.js`) | The extension card on `chrome://extensions` |
| Content script (`content.js`) | The host page's DevTools console |
| Panel iframe (`panel.js`, React, WebRTC) | DevTools → context dropdown → select the iframe |

Most of your WebRTC debugging is in the third one, which is the least obvious.

---

## Part 2: How a session works

### Starting

From the project folder. Claude Code reads `CLAUDE.md` automatically.

```
Read CLAUDE.md and SPEC.md. We're doing Session 3E only — rehoming the
existing peer connection into the panel iframe. Walk me through the
approach before writing code.
```

### During

- **Read what it proposes** before approving. Approving blindly is how you end up with code you don't understand.
- **Interrupt freely.** Esc stops it mid-stream.
- **Ask why**, especially on Manifest V3 and WebRTC.
- **Make it tell you what to check**, since it can't see your browser.

### Ending

```
Let's stop here. Summarize what's done, what's left, and anything I
should know before the next session.
```

Then: build, load, actually use it, `git commit`, update the "Current status" lines in `CLAUDE.md`.

---

## Part 3: Session prompts

### Session 1E — Extension scaffold

```
Session 1E only: extension scaffold. Manifest V3, service worker,
content script, panel page, and a Vite multi-entry build that outputs
a loadable extension folder.

Check the current state of @crxjs/vite-plugin before deciding whether
to use it or configure Vite entry points manually — tell me what you
find and let me pick.

Don't port any WebRTC code yet.
```

**Done when:** it loads from `dist/`, the icon toggles an empty panel, and you've done one build-refresh-reload cycle.

### Session 2E — Docked sidebar and page squeeze

The bet. If this can't be made to work on your sites, the architecture is wrong.

```
Session 2E: dock the panel right at 20% and squeeze the page to 80%.

Read the "position: fixed defeats the page squeeze" note in CLAUDE.md
first — the html transform and the resize dispatch are both required.

Test on YouTube, then tell me what else to try before we commit to this.
```

**Done when:** YouTube's header and player respect the squeeze with no overlap. **Then test the other sites you'd actually use, yourself, before moving on.**

### Session 3E — Rehome the peer connection

```
Session 3E: move the existing WebRTC code into the panel iframe.
Signaling, mediaSlots, and the camera/mic control logic all carry over
unchanged — read the "carried over" list in CLAUDE.md.

Run the loopback test first to confirm nothing broke in the move.
Camera permission is at the extension origin.
```

**Done when:** two devices see each other again, and the loopback test still passes.

### Session 4E — Tab capture

```
Session 4E: replace getDisplayMedia with chrome.tabCapture.getMediaStreamId().

Keep the 4-slot transceiver design — the capture source changed, the
negotiation did not. A share is still a replaceTrack.

Handle the muted-tab problem: capturing tab audio mutes it for the
sharer unless we play it back locally.
```

**Done when:** you can capture a tab with audio, your partner sees and hears it, and *you* still hear it too.

### Session 5E and beyond

Chat, pause nudge, reactions, session logging, summaries — same as originally planned, now rendering in the panel.

---

## Part 4: When things go wrong

**"Could not establish connection. Receiving end does not exist."**
No content script in that tab. Pages open before install don't have one, and `chrome://` pages never do. The service worker should catch this and inject via `chrome.scripting.executeScript`.

**"My change didn't do anything."**
Did you rebuild, refresh the card, *and* reload the page? All three. Manifest changes always need the card refresh.

**"The panel is there but the page still overlaps it."**
The `<html>` transform is missing, or the site does something unusual with fixed positioning. See CLAUDE.md.

**"Video is one-way / black box."**
Run `window.__loopbackTest()` first. Check transceivers, not the picture — count, `mid` non-null, `currentDirection === "sendrecv"`. Then read `SESSION_3_POSTMORTEM.md`.

**"Works locally, not between devices."**
NAT/TURN. Load with `?relay=1` on both. `chrome://webrtc-internals` shows the selected candidate pair.

**"I can't find the error anywhere."**
You're in the wrong console. See the table in Part 1.

**"It built three sessions at once."**
Interrupt, `git checkout .`, restart with a narrower prompt.

---

## Part 5: Habits

- **Commit after every session.** It's your undo.
- **Update "Current status" in CLAUDE.md.** Ten seconds, saves re-explaining.
- **Build and actually use it before saying "looks good."**
- **One session at a time.**
- **Test with your partner early** — two real devices on two real networks tells you more than any local testing.
- **Test on real sites, not just YouTube.** The page squeeze is the fragile part.