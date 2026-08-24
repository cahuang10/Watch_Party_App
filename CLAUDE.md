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
- **Presence identity must be stable across reloads.** Session 2 burned several rounds on this. Keying presence on a per-load random id makes *every refresh* register a new entry that lingers until its socket times out — two people showed up as five participants, and every downstream heuristic (offerer election, partner selection) failed on the ghosts. Presence is now keyed on a per-tab id in `sessionStorage`. Verify with the `participants` count in the `presence sync` log: it must stay at 2 no matter how often either side reloads.
- **Presence keeps multiple metas per key.** A key groups a participant's connections; it does not replace them. `Object.keys(state).length` is the participant count — flattening the metas counts *connections* and will mislead you. Collapse each key to its newest meta by `joinedAt`.
- **A peer connection belongs to a peering session, not to the page.** When the partner reloads they are a new peer and need a brand-new `RTCPeerConnection`. Reusing a completed one produces `setRemoteDescription ... called in wrong state: stable`, and leaves the partner's frozen last frame on screen looking like a live connection.
- **Signals need `to` / `from` / `session`.** Supabase broadcast reaches every channel member, so without addressing, a third participant's traffic gets processed as if it were the partner's. The `session` check specifically prevents a stale offer from renegotiating a connection that is already up.
- **Use `pagehide`, not `beforeunload`,** to untrack presence on exit — iOS Safari/WebKit frequently doesn't fire `beforeunload`, and the phone is the device most likely to be closed abruptly.
- **Glare is not handled yet.** Conflicting offers are ignored, which is safe only because roles are fixed and deterministic. Session 4 breaks that assumption: adding a screen-share track triggers renegotiation, and V1 wants either person able to share. That is where the W3C "perfect negotiation" pattern (polite/impolite peers, rollback) will be needed.

---

## Current status

**Working on:** Session 3 — camera box UI + hide/show toggle (not started)

**Completed:**
- Session 1 — Vite+React (JS) scaffolded, Supabase client wired (`src/lib/supabaseClient.js`), deployed to Vercel.
- Session 2 — Signaling over Supabase Realtime (`src/lib/signaling.js`) + working two-person WebRTC camera call, verified cross-network (laptop on wifi ↔ iPhone on cellular). Survives either side refreshing independently.

**Still unverified:** the TURN-only relay path. Load with `?relay=1` on *both* ends to force it. The working call may have connected directly, which would mean the relay has never actually been exercised — see "TURN sits silently broken" below.

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