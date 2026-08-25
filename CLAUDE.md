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
- **`replaceTrack` is how you change media *without* renegotiating.** A transceiver is a durable slot in the connection; a track is just what's currently plugged into it. `sender.replaceTrack(x)` swaps the contents without touching offer/answer as long as the kind matches, and `replaceTrack(null)` stops sending with the slot intact. `removeTrack`/`addTrack` fire `negotiationneeded` instead — avoid them while glare is unhandled. The **offerer** reserves both slots with `addTransceiver` at connection time even when there is no track yet, so enabling the camera later can never renegotiate. Capture the sender the moment you create it: `getSenders().find((s) => s.track?.kind === "video")` quietly finds nothing after a `replaceTrack(null)`.
- **Only `addTrack` transceivers get associated with an incoming offer; `addTransceiver` ones do not.** This cost a session. If the *answerer* pre-creates transceivers before `setRemoteDescription(offer)`, they are never adopted: it ends up holding four — two orphans with `mid: null` that never send, plus two `recvonly` ones built from the SDP — while the offerer goes `sendonly`. The answer still carries the right two m-lines and **nothing throws**, so the symptom is one-way video with a black box on the offerer's side and no error anywhere. The rule: **the offerer defines the m-lines, the answerer fills in what the offer created.** The answerer builds its connection with no transceivers, then between `setRemoteDescription` and `createAnswer` walks `getTransceivers()`, `replaceTrack`s its local tracks in, and sets `direction = "sendrecv"` (they arrive `recvonly`). See `attachLocalMediaToAnswer()` in `src/lib/useWatchPartyCall.js`.
- **Never touch a stopped transceiver, and never let the answerer's attach loop throw.** Setting `.direction` or calling `replaceTrack` on a stopped/rejected transceiver throws `InvalidStateError`. In `attachLocalMediaToAnswer()` that is fatal in a non-obvious way: it aborts *before* `createAnswer()`, so no answer is ever sent and the offerer sits at `have-local-offer` forever with healthy ICE and no error on its side. Skip anything whose `direction` or `currentDirection` is `"stopped"`, and skip kinds other than audio/video — an offer can carry sections we didn't ask for.
- **`have-local-offer` + `iceConnectionState: new` means the answer never came back — it is not an ICE or TURN problem.** Relay candidates in the offerer's list prove TURN allocated fine. Look at the *other* device: its status line and console hold the actual failure.
- **An `RTCIceCandidate` does not survive JSON with its useful fields.** `toJSON()` serialises only `candidate`, `sdpMid`, `sdpMLineIndex` and `usernameFragment`; `type`, `protocol` and `address` are *parsed* properties and come out `undefined` on the far side — which is why the remote-candidate log read `undefined undefined undefined` and the relay-address comparison was silently doing nothing. Rebuild with `new RTCIceCandidate(payload.candidate)` before logging or adding it.
- **One Supabase channel name means one global room.** `CHANNEL_NAME` is a constant in `src/lib/signaling.js`, so every tab on every localhost dev server *and* the Vercel deployment all join the same room. Stale tabs show up as extra participants and the offerer election thrashes through them one by one before settling. If `presence sync` reports more than 2, close tabs and kill stray `vite` processes before debugging anything else.
- **Async device work needs a generation counter, not just a state check.** Opening a camera takes ~300ms, so clicking the toggle faster than that leaves several `getUserMedia` calls in flight. A guard that only re-checks `cameraOn` passes for *all* of them once the state has flipped back to on, and each one attaches a track — the stream ends up with two video tracks and the abandoned one **holds the camera device open**, so the light stays lit while the UI says "camera off". Claim an op number at the top of the toggle (`const op = ++cameraOpRef.current`) and discard the result if it no longer matches. Reproduced and fixed 2026-08-24: rapid off/on/off/on left 2 live tracks before, 1 after.
- **`requestVideoFrameCallback` does not fire while the document is hidden.** Chrome suspends video frame callbacks for background tabs, so any "wait until the first frame paints" logic silently degrades into "wait out the whole timeout." Measured: 0ms when guarded with `document.hidden`, 3700ms when not. **This is the normal case from Session 4 onward** — the sharer sits on the content tab with the app tab backgrounded. Guard with `document.hidden` up front, and listen for `visibilitychange` to bail if the tab is backgrounded mid-wait.
- **Releasing the camera is not free, and nothing can make it free.** Camera light off ⟺ device closed ⟺ cold `getUserMedia` on the way back (device power-up plus exposure settling). Every possible latency lever amounts to keeping the device open longer, which means the light stays lit longer. If a toggle ever feels instant *and* the light goes out, something is still holding the camera — check for a second tab.
- **Check the transceivers, not the picture.** One-way video looks identical to a dozen unrelated faults. The cheap, decisive test needs no camera at all: build two `RTCPeerConnection`s in one page, run a full offer/answer, and assert each ends with exactly 2 transceivers, every `mid` non-null, every `currentDirection === "sendrecv"`. Fake tracks from `canvas.captureStream()` and `AudioContext.createMediaStreamDestination()` stand in for real devices. Four transceivers on one side, or any `recvonly`/`sendonly`, is the bug above.
- **Mute is not detectable from the receiving end.** A muted mic sends silence and a stopped camera sends nothing, and neither is distinguishable from a network stall. Device state has to be *told* over the signaling channel (`media-state`), never inferred from the stream.
- **Document PiP API support.** Newer, Chromium-specific. Check current support before building session 3; have a fallback in mind.
- **Audio feedback loops.** Mic + tab audio + speakers can echo badly. Handle echo cancellation explicitly; assume headphones as the fallback.
- **TURN sits silently broken.** It only activates when direct connection fails, so a bad config looks fine until it matters. Test with `iceTransportPolicy: "relay"` to force a TURN-only connection and confirm it works.
- **Measured 2026-08-24, single-machine loopback against ExpressTURN:** allocation and credentials work; a **relay ↔ non-relay** pair connects (selected `relay/62.210.205.50 <-> srflx/140.82.222.1`), which is the case that actually matters — one peer stuck behind symmetric NAT. A **relay ↔ relay** pair *failed*, but both test peers shared one machine and one public IP, so that is hairpinning through a single server and is not conclusive for two real devices on different networks. Resolve it with `?relay=1` on both real devices.
- **Don't over-read a multi-IP TURN host.** An earlier note here claimed that peers allocated on different IPs of `free.expressturn.com` can never relay to each other. That is not how TURN works: a server relays to any peer it has a permission for, regardless of which server that peer used, and extra resolved IPs mean *more* usable candidates, not fewer. In testing both peers landed on the same IP anyway. Don't switch providers on the strength of two different relay addresses in a log.

- **Supabase Realtime has connection/message caps** on the free tier. Fine for two users, but worth knowing they exist.
- **Read `SESSION_2_POSTMORTEM.md`** before debugging any signaling or connection problem. It explains the jargon, walks through all five attempts and why four of them failed, and gives a layer-by-layer diagnostic ladder.
- **Read `SESSION_3_POSTMORTEM.md`** before touching transceivers, tracks, or anything that changes what is being sent. Covers the transceiver/track model, why the answerer must not pre-create transceivers, and — in Part 5 — the loopback test that finds this class of bug in minutes without a camera or a second device.
- **Presence identity must be stable across reloads.** Session 2 burned several rounds on this. Keying presence on a per-load random id makes *every refresh* register a new entry that lingers until its socket times out — two people showed up as five participants, and every downstream heuristic (offerer election, partner selection) failed on the ghosts. Presence is now keyed on a per-tab id in `sessionStorage`. Verify with the `participants` count in the `presence sync` log: it must stay at 2 no matter how often either side reloads.
- **Presence keeps multiple metas per key.** A key groups a participant's connections; it does not replace them. `Object.keys(state).length` is the participant count — flattening the metas counts *connections* and will mislead you. Collapse each key to its newest meta by `joinedAt`.
- **A peer connection belongs to a peering session, not to the page.** When the partner reloads they are a new peer and need a brand-new `RTCPeerConnection`. Reusing a completed one produces `setRemoteDescription ... called in wrong state: stable`, and leaves the partner's frozen last frame on screen looking like a live connection.
- **Signals need `to` / `from` / `session`.** Supabase broadcast reaches every channel member, so without addressing, a third participant's traffic gets processed as if it were the partner's. The `session` check specifically prevents a stale offer from renegotiating a connection that is already up.
- **Use `pagehide`, not `beforeunload`,** to untrack presence on exit — iOS Safari/WebKit frequently doesn't fire `beforeunload`, and the phone is the device most likely to be closed abruptly.
- **Glare is not handled yet.** Conflicting offers are ignored, which is safe only because roles are fixed and deterministic. Session 4 breaks that assumption: adding a screen-share track triggers renegotiation, and V1 wants either person able to share. That is where the W3C "perfect negotiation" pattern (polite/impolite peers, rollback) will be needed.

---

## Current status

**Working on:** Session 4 — screen share + quality tuning (not started). **Read `SESSION_3_POSTMORTEM.md` Part 7 first** — adding a screen-share track forces real renegotiation, which breaks the fixed-role assumption the current design relies on.

**Completed:**
- Session 1 — Vite+React (JS) scaffolded, Supabase client wired (`src/lib/supabaseClient.js`), deployed to Vercel.
- Session 2 — Signaling over Supabase Realtime (`src/lib/signaling.js`) + working two-person WebRTC camera call, verified cross-network (laptop on wifi ↔ iPhone on cellular). Survives either side refreshing independently.
- Session 3 — Camera box UI plus **real** camera and mic controls. The call moved out of `App.jsx` into `src/lib/useWatchPartyCall.js` (App.jsx is now presentational, `CameraBox.jsx` is a dumb tile). The camera opens only once a partner is actually present and is released when they leave — no camera light while you sit alone waiting. Camera off does `replaceTrack(null)` + `track.stop()`, so the device is genuinely released; mic mute does `track.enabled = false`, which is instant and leaves the device open. Both states ride the signaling channel as a `media-state` message, so each tile shows the *other* person's real state. Controls live inside your own tile: clicking anywhere on it (placeholder included) toggles the camera, and the mic button is a circle at bottom-centre that appears on hover — and stays visible while muted. The partner's tile is display-only. Known trade-off: a partner reload is a leave-then-join, so your camera light blinks off and on — add a grace timer if it grates. Document Picture-in-Picture (locked decision #7) still not built; decision unchanged, revisit after Session 4.

**Partly verified:** TURN allocates, and a relay candidate has carried a real connection to a non-relay peer (loopback test, 2026-08-24). Still unverified: **relay on both ends at once**, and the relay path across two genuinely different networks. Load with `?relay=1` on *both* devices to close it out — see "TURN sits silently broken" below.

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