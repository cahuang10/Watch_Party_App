# Watch Party — Project Spec

A private, two-person watch-together tool: camera tiles and chat docked beside whatever you're watching, so you and your partner can watch anything together and still see each other. Personal project, no subscription, built to be used — not shipped to strangers.

**Architecture: Chrome extension.** Changed from a web app after Session 4. See section 1.

---

## 1. Foundational Decisions

### Why an extension, not a web app

Sessions 1–4 built this as a React app on Vercel. It worked, and the experience was bad. To watch something, the sharer had to: open the app tab, open a content tab, click share, pick the tab from a browser picker, open a floating picture-in-picture window, and manually resize the content window so the panel had somewhere to sit. Six manual steps, then a permanently sacrificed slice of screen. A browser cannot do better than that — the share picker is a hard security requirement, and a web page cannot resize a window it didn't open.

An extension can. It injects its UI **into the page you're already watching**, docks a sidebar, and squeezes the page into the remaining width — the way Teleparty does. No second tab, no floating window, no picker, no resizing.

**What this costs:** both of you install manually from a folder (or via the Chrome Web Store, $5 one-time). Manifest V3 has real constraints. No hot reload — you hit refresh on the extension card and reload the page. Some sites fight injected UI.

**What it does not cost:** the WebRTC work. Signaling, the transceiver slot design, TURN config, and every lesson in the postmortems carry over unchanged. It's the same peer connection running in a different container.

### Layout: docked sidebar, not floating

Panel docks right at 25% width; the page is squeezed to 75%. Nothing overlaps, nothing needs dragging. (Collapsing to a thin strip is the target design but isn't built yet — Session 2E shipped the squeeze itself; collapse/expand is separate work, still open.)

**The mechanism, because it is not obvious:** setting `width: 75%` on `<html>` is not enough. Sites like YouTube use `position: fixed` for headers and players, and fixed elements position against the viewport, not their parent — so they keep spanning the full screen and slide under the panel. The fix is a `transform` on **`<body>`, not `<html>`** — that makes `<body>` the containing block for fixed descendants inside it, so they get squeezed too. It has to be `<body>` specifically: the panel itself is a fixed-position child of `<html>` (so that it can dock outside the page regardless of what the page does to its own `<body>`), and a transform placed on `<html>` would capture the panel as a containing-block descendant too, dragging it inside the squeezed page instead of leaving it pinned to the real right edge — measured on real youtube.com while building this. Then dispatch a `resize` event so the site re-lays-out. All three steps are required.

This is the fragile part of the whole approach. It works on YouTube. Verify per-site before assuming.

### Content delivery: tab capture

`chrome.tabCapture.getMediaStreamId()` returns a stream id with **no picker** — the extension already has permission for the tab. Pass that id to `getUserMedia` with `chromeMediaSource: "tab"`.

**Known constraints to design around:**
- Capturing tab audio **mutes the tab for the sharer** unless the audio is explicitly played back locally. Handle this or the sharer watches in silence.
- Capture is tied to a specific tab. Navigating away or closing it ends the capture.
- The viewer **cannot** pause the sharer's video — same security boundary as before. Solution unchanged: a "request pause" nudge.
- Chrome desktop only.

### Where the peer connection lives

The single most important structural decision in the extension version.

- **Not the service worker** — no DOM, no media elements, and MV3 workers sleep.
- **Not a content script** — runs in the page's world, dies on navigation, and the page's CSS can reach it.
- **The panel iframe**, pointing at a `chrome-extension://` page. Extension origin, so camera permission is granted once and works on every site. It renders video directly, which matters because **a `MediaStream` cannot be passed between documents** — whichever document holds the connection must be the one showing the picture.

The service worker's only job is brokering: toggle the panel, hand over the tab-capture stream id (ids are strings and *can* cross contexts, unlike streams).

**Consequence to accept:** a hard navigation in the host tab destroys the iframe and drops the call. Soft/SPA navigation (YouTube's normal browsing) does not. An offscreen document would survive both, but cannot render video into the sidebar, so it doesn't solve the problem it appears to solve.

### Connectivity: STUN + TURN — unchanged

- **Signaling:** Supabase Realtime channel. Unchanged from Session 2.
- **STUN:** `stun:stun.l.google.com:19302`.
- **TURN:** ExpressTURN free tier (1000GB/month, TCP+UDP on 3478, plus 80/443 for firewall traversal).

**Why TURN from day one:** ~10–20% of connections can't establish a direct path — symmetric NAT, or a firewall blocking UDP. These are structural network properties; reloading does not fix them. TURN converts "accept an incoming connection" into "make an outbound connection," which every network allows.

**Secrets are baked into the bundle.** Vite inlines env vars at build time, so the Supabase anon key and TURN credentials are readable by anyone holding the extension folder. Acceptable for two people; not acceptable if this is ever published.

### Scope: cut line for MVP

*If this were missing, would we open Teleparty instead?*

| Feature | Verdict |
|---|---|
| Camera tiles in the docked panel | **MVP** |
| Tab capture + viewer playback | **MVP** |
| STUN/TURN connectivity | **MVP** |
| Basic live text chat | **MVP** (no persistence) |
| Page squeeze that survives real sites | **MVP** — the whole reason for the rewrite |
| Emoji reaction overlay | V1 |
| Chat persistence | V1 |
| Session logging | V1 |
| Conversation summaries | V2 |
| Reconnect on navigation | V2 |

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Chrome extension, Manifest V3 | The only way to get docked UI without manual setup |
| Panel UI | React + Vite, multi-entry build | Keeps existing component work; verify the build config early |
| Signaling / DB | Supabase | Unchanged — Realtime for signaling and chat, Postgres for logs |
| Media | Native WebRTC + `chrome.tabCapture` | Same peer connection, different capture source |
| TURN | ExpressTURN | Unchanged |
| Hosting | **None** | Extension loads from disk. Vercel is out of the stack |
| Summaries (V2) | Undecided — see section 7 | Deferred |

**Build note, resolved in Session 1E:** an extension needs specific output files (`manifest.json`, service worker, content script, panel HTML/JS) rather than one bundle. `@crxjs/vite-plugin` (2.7.1, actively maintained) was checked and declined in favor of a manual two-pass Vite build — see `vite.config.js` / `vite.config.content.js`. Content scripts can't be ES modules, so pass B builds `content.js` alone as an IIFE.

---

## 3. Quality Tuning for Tab Capture

Same levers as before; the capture call differs.

1. Request 1080p/30fps explicitly in the `getUserMedia` constraints alongside `chromeMediaSource: "tab"`
2. Set `contentHint = "motion"` on the video track
3. Raise the bitrate cap via `RTCRtpSender.setParameters()` — 2.5–4 Mbps for 1080p30
4. Prefer VP9 or AV1 in SDP negotiation
5. Chrome both ends
6. Same-wifi test first to establish the ceiling

Existing implementations of 2–4 in `screenShare.js` carry over. Only the capture step is rewritten.

---

## 4. Milestones

Sessions 1–4 were built against the web-app architecture. Marked below by what survives.

### Carried over from the web app — do not rebuild
- [x] Signaling over Supabase Realtime (`signaling.js`) — **unchanged**
- [x] Peer connection, offer/answer, presence, offerer election — **unchanged**
- [x] 4-slot transceiver design (`mediaSlots.js`) — no renegotiation on share — **unchanged**
- [x] Camera/mic control logic, `media-state` messages, generation counters — **logic unchanged, UI rehomed**
- [x] Quality tuning + codec preference (`screenShare.js`) — **capture step rewritten, rest unchanged**
- [x] Loopback test (`loopbackTest.js`) — **still the first thing to run when anything looks wrong**
- [x] STUN + TURN config, ExpressTURN credentials

### MVP — extension shell
- [x] Session 1E: extension scaffold — manifest, service worker, content script, panel build pipeline
- [x] Session 2E: docked sidebar that squeezes the page, verified on YouTube **and** other real sites (Twitch) — collapse/expand deferred, see Session Plan below
- [x] Session 3E: existing peer connection running inside the panel iframe; camera tiles live again — verified with a real two-device call on one network
- [ ] Session 4E: `chrome.tabCapture` replacing `getDisplayMedia`, including local audio playback so the sharer isn't muted
- [ ] Session 5E: chat in the panel (live only)
- [ ] Request-pause nudge

### V1
- [ ] Chat persisted to Postgres, restored on reopen
- [ ] Emoji reactions — overlay on the *page*, which the extension can now do properly
- [ ] Session logging: start/end, duration
- [ ] Session history view

### V2
- [ ] Conversation summaries — model choice open, section 7
- [ ] Survive hard navigation (reconnect, or move state to an offscreen document)
- [ ] Auth so it's just the two of you
- [ ] Styling pass

### Later
- [ ] Publish to Chrome Web Store so installs aren't manual
- [ ] Per-site layout fixes as they come up
- [ ] Optional: self-hosted Node signaling server (learning exercise)

### Out of scope
- Scraping or streaming from piracy sites
- Group calls beyond 2 people
- Firefox or Safari
- Monetization, multi-tenancy, public signups

---

## 5. Session Plan

**Session 1E — Extension scaffold**
Manifest V3, service worker, content script, panel page. Get the Vite multi-entry build producing a loadable folder. Verify the load/reload loop before any features.

**Session 2E — Docked sidebar and page squeeze — done**
Delivered: the width/transform split (`<html>` width, `<body>` transform — not both on `<html>`, see section 1), the resize dispatch, verified on real YouTube and Twitch. **Collapse/expand was deliberately scoped out** — it needs panel→content-script messaging (the button lives in the React panel, the squeeze lives in the content script), a separate mechanism from the squeeze itself. Still open for a future session. *This was the whole bet, and it held — the architecture is validated on real sites.*

**Session 3E — Rehome the peer connection — done**
Delivered: the call moved into the panel iframe, the old web-app shell (`App.jsx`, `Stage.jsx`, `main.jsx`, `index.html`) deleted, and a real two-device camera call verified on two machines.

The session's one surprise was camera permission: Chrome **will not display a getUserMedia prompt whose requesting origin is a `chrome-extension://` document embedded as a subframe in a web page** — there is nowhere honest to anchor it, so Chrome auto-denies with `NotAllowedError` and no prompt appears in any console. This is distinct from Permissions-Policy delegation, which the `allow="camera; microphone"` attribute already handled. The fix is `permission.html`, a top-level extension page that asks once; media grants are stored per origin, so the panel iframe inherits it. Once per browser profile, not once per site.

Still open, deliberately not blocking: the `?relay=1` TURN check on two devices.

**Session 4E — Tab capture**
Replace `getDisplayMedia` with `chrome.tabCapture.getMediaStreamId()`. Keep the 4-slot design — capture source changed, negotiation did not. Handle the muted-tab problem.

**Session 5E — Chat**
Live over Supabase Realtime, then persistence.

Then: pause nudge, reactions, session logging, summaries — as originally planned.

---

## 6. Things to Watch For

**New to the extension**
- **Three consoles, not one.** Service worker errors appear on the `chrome://extensions` card. Content script errors appear in the page's DevTools. Panel iframe errors need the iframe context selected in the DevTools dropdown. Looking in the wrong one wastes hours.
- **Reload is two steps.** Refresh the extension card, *then* reload the page. Manifest changes always need the card refresh.
- **`position: fixed` breaks the squeeze** without a transform on the right element — `<body>`, not `<html>`. Putting it on `<html>` squeezes the page but also captures the panel itself, since the panel is a fixed child of `<html>` too. See section 1.
- **A host page's `Permissions-Policy` header can veto the panel's camera and mic**, and the iframe's `allow=` attribute cannot override it — delegation narrows, never widens. claude.ai sends `camera=(),microphone=()`; YouTube doesn't list them, so they default to `self` and delegate fine. Distinct from the 3E prompt problem and not fixable by `permission.html`. See CLAUDE.md for the diagnosis one-liner.
- **Tab capture mutes the tab** for the sharer unless audio is played back locally.
- **MediaStreams can't cross documents.** Stream *ids* can. This constrains where the connection lives.
- **Hard navigation kills the panel iframe** and drops the call. Expected in MVP.
- **Content scripts don't retroactively inject.** Pages open before install have no content script; the service worker must inject on demand via `chrome.scripting.executeScript`.
- **Secrets are readable in the bundle.** Fine for two people, not for publishing.

**Carried over — still true**
- **Audio feedback loops.** Mic + tab audio + speakers echo. Handle echo cancellation; assume headphones.
- **TURN sits silently broken.** Force `iceTransportPolicy: "relay"` on both devices to confirm.
- **Supabase Realtime free-tier caps.** Fine for two users.
- **Read `SESSION_2_POSTMORTEM.md` and `SESSION_3_POSTMORTEM.md`** before debugging signaling or transceivers. Everything in them still applies — the peer connection didn't change, only its container.

---

## 7. Open Question: Summarization Model (V2)

Unchanged from the web-app version, with one difference: **there is no Vercel serverless function anymore**, which removes the main argument for a hosted API. An extension can call `localhost:11434` directly, so a local model via Ollama is now the more natural fit.

Still deferred. The remaining question is whether "summaries only generate when my machine is running Ollama" is acceptable. If yes, local wins on privacy — these are private conversations between two partners, and with a local model the text never leaves the machine. If summaries must exist for every session regardless of device state, hosted wins.

Don't default to a model from memory — check what's current when you get here.