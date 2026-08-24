# Watch Party App — Project Spec

A private, two-person watch-together app: side-by-side camera boxes plus screen sharing, so you and your partner can watch anything together and still see each other. Personal project, no subscription, built to be used — not shipped to strangers.

---

## 1. Foundational Decisions

These three were worked out before any code, and everything below follows from them.

### Content delivery: screen share only

One person shares a browser **tab**; the other watches that video+audio stream over WebRTC. This handles every source identically — YouTube, Netflix, a local file, anything on screen.

**Why not per-service playback sync:** syncing two independent players (e.g. via the YouTube IFrame API) gives better quality and two-way control, but only for YouTube, and it means building and maintaining a second, separate system. Screen share is one system that covers everything. Quality is slightly lower and only the sharer controls playback — accepted tradeoff for a much simpler build.

**Known constraints to design around:**
- Must share a **tab**, not a window or full screen — tab audio capture only works reliably for tab shares in Chrome. Bake this into the UI as an instruction, not an afterthought.
- The viewer **cannot** pause the sharer's video. WebRTC screen share is one-directional by design (security boundary). Solution: a "request pause" nudge — viewer clicks a button, sharer gets an on-screen notification, sharer pauses manually.
- Desktop-to-desktop. iOS Safari doesn't support `getDisplayMedia()` for tab sharing, so phones can't be the sharer.

### Tab flow and the floating camera window

The app is not a single tab that "contains" the content. It's two tabs plus a floating window:

- **App tab**: where the app lives — controls, chat, session logging.
- **Content tab**: an ordinary tab, navigated freely to YouTube, Netflix, anywhere. Nothing about browsing here is restricted or routed through the app.
- **Floating camera window**: both camera boxes (yours and your partner's) rendered side by side inside one small panel, built with the **Document Picture-in-Picture API**. This window floats on top of whichever tab is active, so the content tab can be browsed and shared without losing sight of each other.

To share: click share in the app (or in the PiP window itself), the browser's native tab picker opens, select the content tab. From then on that tab's video/audio streams to the partner while the PiP window stays visible on top for both of you.

**Positioning: draggable, default top-right.** Document Picture-in-Picture windows are draggable by the browser natively — this isn't something to build, it comes for free with the API. No custom drag logic needed. Default spawn position is top-right; the user can drag it anywhere afterward, and the browser remembers position across the session.

### Connectivity: STUN + TURN fallback from day one

- **Signaling** (peers exchanging connection info): Supabase Realtime channel. No custom WebSocket server needed.
- **STUN** (discovering your public address): free public server, e.g. `stun:stun.l.google.com:19302`.
- **TURN** (relay fallback): free tier, included from the start.

**Why TURN from day one:** roughly 10–20% of connections can't establish a direct peer-to-peer path — usually symmetric NAT (router assigns a different external port per destination, so STUN can't discover a usable address) or a firewall blocking UDP. These are structural properties of the network, not transient glitches, so **reloading does not fix them**. Without TURN, those sessions simply never connect, with no useful error. TURN converts the problem from "accept an incoming connection" (which NATs fight) to "make an outbound connection" (which every network allows), so it essentially always works.

**Provider:** using **ExpressTURN** (free tier: 1000GB/month, long-term credentials, TCP+UDP on 3478 plus 80/443 for firewall traversal). Credentials live in `.env.local` as `VITE_TURN_SERVER` / `VITE_TURN_USERNAME` / `VITE_TURN_CREDENTIAL`. Alternatives if more headroom or control is wanted: **Open Relay Project** (no signup, public credentials) or **Metered.ca** (50GB/month free tier) — swapping providers is a config change, not a rearchitecture.

### Scope: cut line for MVP

The test applied to each feature: *if this were missing, would we open Teleparty instead?*

| Feature | Verdict |
|---|---|
| Two camera boxes + hide toggle | **MVP** — the whole point of "feel together" |
| Screen share | **MVP** — the "watch together" half |
| STUN/TURN connectivity | **MVP** — nothing works without it |
| Basic live text chat | **MVP** (no persistence yet) |
| Emoji reaction overlay | V1 — delightful, not functional |
| Chat persistence to cloud | V1 |
| Session date/duration logging | V1 — cheap to build |
| Conversation summaries | V2 |
| UI polish, reconnect handling | V2 |

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + Vite | Fast dev loop, huge amount of learning material |
| Hosting | Vercel | Free tier, GitHub-connected deploys |
| DB + Realtime + Auth | Supabase | Postgres for chat/session logs, Realtime for signaling *and* chat, simple auth — all free tier |
| Video/screen share | Native WebRTC APIs | `RTCPeerConnection`, `getUserMedia`, `getDisplayMedia`. No library needed for 2 peers |
| TURN | ExpressTURN | Free tier, 1000GB/mo, credentials via env vars |
| Summaries (V2) | **Undecided** — hosted API vs local model via Ollama. See section 7. | Deliberately deferred; not needed until V2 |

**Note on architecture:** for exactly two people, direct peer-to-peer is the *correct* design, not a lesser version of what Zoom does. Zoom's SFU (server in the middle) exists to scale to many participants; for a 2-person call it's overhead, not a quality gain. The gap versus Zoom/FaceTime is polish and infrastructure, not architecture.

---

## 3. Quality Tuning for Screen Share

Browser defaults are conservative. These levers materially improve quality and should be applied when the screen-share feature is built:

1. **Request high resolution/framerate explicitly** in `getDisplayMedia()` constraints — 1080p at 30fps (or 60). Biggest single lever.
2. **Set `contentHint = "motion"`** on the video track — tells the encoder to favor smooth motion over static sharpness, correct for movie watching.
3. **Raise the bitrate cap** via `RTCRtpSender.setParameters()` — 2.5–4 Mbps for 1080p30. Browsers default low to be safe on average connections.
4. **Prefer VP9 or AV1** over default H.264 in SDP negotiation — better quality per bit, both supported in Chrome.
5. **Chrome on both ends** — most mature WebRTC implementation, best hardware acceleration.
6. **Test on the same wifi first** — establishes the quality ceiling before introducing internet-distance variables.

Realistic expectation: on decent home internet with these applied, screen share should look genuinely good. The gap versus FaceTime shows up in edge cases — spotty wifi, an older laptop struggling to encode, very asymmetric connection quality.

---

## 4. Milestones

### MVP — "does this even work"
- [x] Vite + React app scaffolded, Supabase wired up, deployed to Vercel
- [x] Signaling over Supabase Realtime channel
- [ ] Two-person WebRTC camera call, side-by-side boxes
- [ ] Hide/show toggle per camera box
- [ ] Camera boxes rendered inside a Document Picture-in-Picture window (native drag, default top-right)
- [x] STUN + TURN configured in `RTCPeerConnection`
- [ ] Screen share (tab), one direction, quality-tuned per section 3
- [ ] Basic live text chat (in-memory, no persistence)
- [ ] "Request pause" nudge button + on-screen notification for sharer

### V1 — "we'd use this daily"
- [ ] Either person can initiate screen share (renegotiation handled)
- [ ] Chat persisted to Supabase Postgres, restored on refresh
- [ ] Emoji reaction dropdown → full-screen overlay animation, broadcast to both
- [ ] Session logging: start/end timestamps, duration, stored in DB
- [ ] Simple session history view

### V2 — polish + smart features
- [ ] Conversation summary generated at session end — **model choice undecided, see section 7**
- [ ] Reconnect handling (network drop doesn't kill the session)
- [ ] Auth so it's just the two of you
- [ ] UI styling pass

### Later / nice-to-have
- [ ] Mobile-friendly layout (viewer only — sharer must stay desktop)
- [ ] Reaction stats ("most used emoji this month")
- [ ] Timestamp bookmarks for highlight moments
- [ ] Optional: add YouTube IFrame sync as a *second* content mode for better YouTube quality and two-way playback control
- [ ] Optional: replace Supabase Realtime signaling with a self-hosted Node + WebSocket server (learning exercise — the signaling module is deliberately abstracted to make this a one-file swap)

### Explicitly out of scope
- Scraping or streaming directly from piracy sites (screen share covers the use case without this)
- Group calls beyond 2 people
- Monetization, multi-tenancy, public signups

---

## 5. Claude Code Session Plan

Break the work into focused sessions rather than handing over the whole spec at once. This keeps each session's context tight and lets you actually read and understand what gets built — especially important for the WebRTC pieces, which are the genuinely new concepts here.

**Session 1 — Scaffold and deploy pipeline**
Vite + React app, Supabase client initialized with env vars, deployed to Vercel showing "hello world." Get deploys working first so every later step is instantly testable in the real environment.

**Session 2 — Signaling + first peer connection**
Supabase Realtime channel for offer/answer/ICE candidate exchange. `RTCPeerConnection` configured with STUN + TURN. Goal: two browser tabs see and hear each other via camera. *Read this code closely — it's the conceptual core of the project.*

**Session 3 — Camera box UI**
Side-by-side layout, hide/show toggle per box, basic responsive behavior.

**Session 4 — Screen share**
`getDisplayMedia()`, adding the track to the existing peer connection, viewer-side `<video>` element. Apply all quality tuning from section 3. Include the tab-not-window instruction in the UI.

**Session 5 — Chat**
Supabase Realtime for live messages first; Postgres persistence second.

**Session 6 — Request-pause nudge**
Button on viewer side, message over the data channel or Realtime, visible notification on sharer side.

**Session 7 — Emoji reactions**
Dropdown, broadcast over existing channel, full-screen overlay animation on both ends.

**Session 8 — Session logging**
Timestamps on connect/disconnect, duration calculation, DB table, simple history view.

**Session 9 — Summaries**
Generate a summary from the stored chat log at session end, saved alongside the session record. **Decide the model approach first — see section 7.**

---

## 6. Things to Watch For

- **Audio feedback loops.** Mic + tab audio + speakers in one session can echo badly. Plan for headphones, and/or handle echo cancellation settings explicitly when building screen share.
- **Renegotiation.** Adding a screen-share track to a live peer connection triggers ICE renegotiation. Expect this to be fiddly — it's the most likely source of "it worked, then I hit share and everything broke."
- **Document PiP API is newer/Chromium-specific.** Confirm current browser support before relying on it, and have a fallback in mind (camera boxes just stay in the app tab) if it's unavailable. Check support at build time — browser API support shifts.
- **Testing TURN specifically.** Since TURN only activates when direct connection fails, it can sit silently broken. Force a TURN-only connection at least once (`iceTransportPolicy: "relay"`) to confirm it actually works before relying on it.
- **Supabase free tier limits.** Generous, but Realtime has connection/message caps. Fine for two people; worth knowing they exist.

---

## 7. Open Question: Summarization Model (V2)

Not decided. Deferred until V2 is actually being built — by then the local model landscape will have moved, and it'll be clearer whether summaries are a feature worth having at all.

### Option A: Local model via Ollama

**For:**
- **Privacy.** Chat logs are private conversations between two partners. With a local model that text never leaves the machine — no third party, no retention question. This is the strongest argument, and it's specific to this app.
- Free, unlimited, no API key management.

**Against:**
- **Architectural constraint.** The app is deployed on Vercel and reachable from anywhere; Ollama runs on one specific machine. A Vercel serverless function cannot reach a local Ollama instance. The workaround is calling `localhost:11434` from the browser, which works — but only for whoever has Ollama installed and running, and only while it's running. No summary if that machine is off.
- Requires ~8GB free RAM for an 8B-class model. Fine on a modern laptop, painful on an older one.
- Both people would need it set up, or summaries only ever generate on one side.

**Model note:** don't default to Llama 3.1 — it dates from mid-2024. Check what's current when actually building. Summarizing a chat log is an easy task; a small modern model is plenty.

### Option B: Hosted API

**For:**
- Reachable from a serverless function regardless of whose device triggered it — no "is my laptop on" dependency.
- No local hardware requirement.
- Better output quality, though summarization is easy enough that this matters less than usual.

**Against:**
- Chat log text goes to a third party.
- Costs money (small at this volume, but nonzero) and needs key management.

### How to decide

The real question is whether "summaries only generate when my machine is running" is acceptable. If yes, local wins on privacy. If summaries should reliably exist for every session regardless of device state, hosted wins.