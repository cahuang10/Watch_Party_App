# Watch Party App

A private, two-person watch-together app: side-by-side camera boxes plus screen sharing, so my partner and I can watch anything together and still see each other. Personal project, not shipped to anyone else.

**Full spec, decisions, and milestone plan: see `SPEC.md`.** Read it before starting work.

---

## How I want to work

I'm a CS major, but new to web development and to WebRTC specifically. I want to **understand** this codebase, not just have it work.

- **Explain before building.** For anything WebRTC-related, walk me through what the step does and why before writing the code. The peer connection, ICE negotiation, and track handling are the parts I most want to actually learn.
- **Prefer clarity over cleverness.** Readable, explicit code beats terse or abstracted code here. Don't optimize prematurely.
- **Comment non-obvious decisions**, especially anything WebRTC or Supabase Realtime related.
- **One milestone per session.** Don't jump ahead to features from later sessions, even if they seem quick. If something later would change the current design, flag it and let me decide.
- **Ask before adding dependencies.** Small surface area is a goal — native WebRTC APIs are intentional, no wrapper library unless we discuss it.

---

## Stack

- **Frontend:** React + Vite
- **Hosting:** Vercel
- **DB / Realtime / Auth:** Supabase (Postgres for chat + session logs, Realtime for both signaling and chat)
- **Video + screen share:** native WebRTC (`RTCPeerConnection`, `getUserMedia`, `getDisplayMedia`) — no library
- **TURN:** ExpressTURN (free tier — 1000GB/mo, UDP+TCP on 3478, also 80/443 for firewall traversal)
- **Summaries (V2 only):** undecided — hosted API vs local model via Ollama. Don't assume either; see section 7 of SPEC.md. Not relevant until session 9.

---

## Locked decisions — don't revisit without asking me

These were worked through deliberately. If you think one is wrong, say so and explain why, but don't quietly design around it.

1. **Screen share only for content.** No per-service playback sync (no YouTube IFrame API) in MVP or V1. One system handles all content sources.
2. **Tab sharing, not window or full screen.** Tab audio capture only works reliably for tab shares in Chrome. The UI should tell the user this explicitly.
3. **Viewer cannot pause the sharer's video.** This is a WebRTC security boundary, not a missing feature. The solution is a "request pause" nudge — viewer sends a message, sharer sees a notification and pauses manually.
4. **STUN + TURN configured from day one.** ~10-20% of connections fail without a TURN relay (symmetric NAT, UDP-blocking firewalls). These are structural network properties — reloading does not fix them.
5. **Chrome desktop only for now.** iOS Safari can't do `getDisplayMedia()` tab sharing, so the sharer must be on desktop.
6. **Two people only.** No SFU, no group call support. Direct P2P is the correct architecture at this scale.
7. **Camera boxes live in a Document Picture-in-Picture window, not the app tab.** Both boxes (yours and partner's) side by side in one small floating panel that stays on top while browsing/sharing the content tab. Default position top-right; draggable — this comes free from the browser API, don't build custom drag logic. Confirm current browser support for Document PiP before relying on it; have a fallback (boxes stay in the app tab) if unavailable.

---

## Screen share quality settings

Browser defaults are conservative. When building or touching screen share, these should be applied:

- Request 1080p / 30fps (or 60) explicitly in `getDisplayMedia()` constraints
- Set `contentHint = "motion"` on the video track (favors smooth motion over static sharpness — correct for movies)
- Raise the bitrate cap via `RTCRtpSender.setParameters()` to 2.5–4 Mbps for 1080p30
- Prefer VP9 or AV1 over default H.264 in SDP negotiation

---

## Known tricky areas

- **Renegotiation.** Adding a screen-share track to a live peer connection triggers ICE renegotiation. Expect this to be the most likely source of "camera worked, then screen share broke everything."
- **Document PiP API support.** Newer, Chromium-specific. Check current support before building session 3; have a fallback in mind.
- **Audio feedback loops.** Mic + tab audio + speakers can echo badly. Handle echo cancellation explicitly; assume headphones as the fallback.
- **TURN sits silently broken.** It only activates when direct connection fails, so a bad config looks fine until it matters. Test with `iceTransportPolicy: "relay"` to force a TURN-only connection and confirm it works.
- **Supabase Realtime has connection/message caps** on the free tier. Fine for two users, but worth knowing they exist.

---

## Current status

**Working on:** Session 2 — signaling + first WebRTC peer connection
**Completed:** Session 1 — Vite+React (JS) app scaffolded, Supabase client wired up (`src/lib/supabaseClient.js`), verified locally. Vercel deploy pending user setup.

<!-- Update these two lines as you go so context carries between sessions. -->

---

## Session plan (short form — details in SPEC.md)

1. Scaffold + Supabase wired up + deployed to Vercel
2. Signaling over Supabase Realtime + first WebRTC peer connection (camera only)
3. Camera box UI + hide/show toggle
4. Screen share + quality tuning
5. Chat (live first, then persisted)
6. Request-pause nudge
7. Emoji reaction overlay
8. Session logging (timestamps, duration, history view)
9. Conversation summaries via Anthropic API