# Watch Party — Chrome extension

A private, two-person watch-together tool: camera tiles and chat docked beside whatever we're watching. Personal project, not shipped to anyone else.

**Full spec: see `SPEC.md`.** Read it before starting work.

**Architecture changed after Session 4.** This was a React app on Vercel; it is now a Chrome extension. The WebRTC layer survives intact — signaling, transceiver slots, TURN, and both postmortems still apply. Only the shell changed. Read "What changed and why" below before assuming any file is obsolete.

---

## How I want to work

I'm a CS major, new to web development and to WebRTC. I want to **understand** this codebase, not just have it work.

- **Explain before building.** Especially anything WebRTC or Manifest V3.
- **Prefer clarity over cleverness.** Readable and explicit beats terse.
- **Comment non-obvious decisions.**
- **One milestone per session.** Don't jump ahead. If something later would change the current design, flag it and let me decide.
- **Ask before adding dependencies.** Native APIs are intentional.

---

## What changed and why

Sessions 1–4 built a React app on Vercel. It worked. The experience was bad: to watch something the sharer opened an app tab, opened a content tab, clicked share, picked the tab from a browser picker, opened a floating PiP window, and manually resized the content window. A web page structurally cannot do better — the picker is a security requirement and a page can't resize a window it didn't open.

An extension injects UI into the page being watched and docks a sidebar, squeezing the page into the remaining width. No second tab, no floating window, no picker, no resizing.

**Dead:** Vercel, Document Picture-in-Picture, `getDisplayMedia`, the Stage component for the sharer, old locked decision #7.
**Alive and unchanged:** `signaling.js`, the 4-slot transceiver design in `mediaSlots.js`, `loopbackTest.js`, camera/mic control logic, `media-state` messages, quality tuning and codec preference in `screenShare.js`, ExpressTURN config, both postmortems.

---

## Stack

- **Shell:** Chrome extension, Manifest V3
- **Panel UI:** React + Vite, two-pass build (resolved Session 1E — `@crxjs/vite-plugin` checked and declined; see Current status)
- **Signaling / DB:** Supabase — unchanged
- **Media:** native WebRTC + `chrome.tabCapture`
- **TURN:** ExpressTURN (1000GB/mo free, UDP+TCP 3478, also 80/443)
- **Hosting:** none. Extension loads from disk.
- **Summaries (V2):** undecided — see section 7 of SPEC.md. Not relevant until later.

---

## Locked decisions — don't revisit without asking me

1. **Chrome extension, not a web app.** Decided after living with the web-app version. Don't propose going back.
2. **Docked sidebar at 25%, page squeezed to 75%.** Not floating, not draggable, not picture-in-picture.
3. **Peer connection lives in the panel iframe** (`chrome-extension://` origin). Not the service worker (no DOM, sleeps), not a content script (page's world, dies on navigation). A `MediaStream` cannot cross documents, so whichever document holds the connection must render the video.
4. **Tab capture via `chrome.tabCapture.getMediaStreamId()`.** No picker. Stream *ids* can cross contexts; streams cannot.
5. **Viewer cannot pause the sharer's video.** Security boundary, not a missing feature. Solution is a "request pause" nudge.
6. **STUN + TURN from day one.** ~10–20% of connections fail without a relay. Structural, not transient — reloading doesn't fix it.
7. **Chrome desktop only.** No Firefox, no Safari, no mobile sharer.
8. **Two people only.** No SFU. Direct P2P is correct at this scale.
9. **Keep the 4-slot transceiver design.** Changing capture source doesn't change negotiation. A share is still a `replaceTrack` into a pre-reserved slot, never a new offer.

---

## Quality settings for tab capture

Same levers as before, different capture call:

- Request 1080p/30fps explicitly in the constraints alongside `chromeMediaSource: "tab"`
- `contentHint = "motion"` on the video track
- Bitrate cap via `RTCRtpSender.setParameters()` — 2.5–4 Mbps for 1080p30
- Prefer VP9 or AV1 in SDP negotiation

Items 2–4 already exist in `screenShare.js` (`applyScreenQuality`, `preferVideoCodecs`) and carry over. Only capture is rewritten.

---

## Known tricky areas — extension

- **Three consoles.** Service worker errors → the `chrome://extensions` card. Content script errors → the page's DevTools. Panel iframe errors → DevTools with the iframe context selected. Looking in the wrong one wastes hours. This is the single biggest difference from web development.
- **Reload is two steps.** Refresh the extension card, then reload the page. Manifest changes *always* need the card refresh. No hot reload — this loop is meaningfully slower than Vite's and it's a real daily cost.
- **`position: fixed` defeats the page squeeze — and the fix must be split across two elements, not one.** Setting `width: 75%` on `<html>` isn't enough: fixed elements position against the viewport, not their parent, so YouTube's masthead and player span the full screen and slide under the panel. The transform that fixes this must go on **`<body>`, not `<html>`** — measured on real youtube.com, putting it on `<html>` squeezes the page correctly but also captures our own panel (a fixed child of `<html>`) as a containing-block descendant, dragging it from the right edge to inside the squeezed page and shrinking it. Putting the transform on `<body>` instead squeezes everything fixed *inside* the page while leaving `<html>` transform-free, so the panel — living outside `<body>` — still resolves against the real viewport. Then `window.dispatchEvent(new Event('resize'))` so the site re-lays-out. All three required. **This is the most fragile part of the architecture** — verify per site. Implemented in `applySqueeze`/`removeSqueeze` in `content.js`.
- **`window.innerWidth` does not change when the page is squeezed.** Only element boxes shrink (via the `<html>` width and `<body>` transform above) — the browser viewport itself is untouched, so any site that computes its own layout from `window.innerWidth` in JS, rather than from CSS, sizes itself for the full width regardless of the resize event. Measured on YouTube's watch page: `#secondary` (the suggested-videos rail) lands ~48px past the squeeze line and is clipped under the panel. Cosmetic, not a layout break. `overflow-x: hidden` on `<body>` would hide it but risks disabling page scroll (body overflow propagates to the viewport when `<html>` is `visible`) — not worth it for MVP.
- **Tab capture mutes the tab for the sharer** unless the captured audio is explicitly played back locally. Otherwise the sharer watches in silence and it looks like a broken capture.
- **MediaStreams cannot cross documents.** Stream ids can. This is why the peer connection lives in the panel iframe (locked decision #3), and why an offscreen document — which would survive navigation — doesn't help: it can't render into the sidebar.
- **Hard navigation destroys the panel iframe** and drops the call. SPA navigation (YouTube's normal browsing) does not. Accepted for MVP; V2 problem.
- **Content scripts don't retroactively inject.** Pages open before install have none, and `chrome://` pages never do. The service worker must try `sendMessage`, catch the failure, and inject via `chrome.scripting.executeScript`. The bare "Could not establish connection. Receiving end does not exist." error means exactly this.
- **Secrets are baked into the bundle.** Vite inlines env vars at build time, so the Supabase anon key and TURN credentials are readable by anyone with the folder. Fine for two people. Not fine if published.
- **Sites can fight injected UI.** z-index wars, CSP, layout assumptions. YouTube behaves. Test the others before committing.

## Known tricky areas — WebRTC (carried over, all still true)

- **Renegotiation, avoided.** The offerer reserves **four** transceiver slots up front (mic, camera, screen audio, screen video), so starting a share is a `replaceTrack` into an already-negotiated slot, exactly like the camera. See `mediaSlots.js`. Verified with the loopback test: 4 transceivers both sides, every `mid` non-null, every `currentDirection: "sendrecv"`, `negotiationneeded` fires **zero** times when a share starts. Perfect negotiation was deliberately not built — nothing forces a renegotiation yet.
- **`replaceTrack` is how you change media *without* renegotiating.** A transceiver is a durable slot; a track is what's plugged into it. `replaceTrack(x)` swaps contents without touching offer/answer if the kind matches; `replaceTrack(null)` stops sending with the slot intact. `removeTrack`/`addTrack` fire `negotiationneeded` — avoid while glare is unhandled. The **offerer** reserves slots with `addTransceiver` at connection time even with no track yet. Capture the sender when you create it: `getSenders().find(s => s.track?.kind === "video")` quietly finds nothing after `replaceTrack(null)`.
- **Only `addTrack` transceivers get associated with an incoming offer; `addTransceiver` ones do not.** This cost a session. If the *answerer* pre-creates transceivers before `setRemoteDescription(offer)` they're never adopted — orphans with `mid: null` that never send, plus `recvonly` ones from the SDP. Nothing throws; the symptom is one-way video with a black box and no error. **The offerer defines the m-lines, the answerer fills in what the offer created.** The answerer builds with no transceivers, then between `setRemoteDescription` and `createAnswer` walks `getTransceivers()`, `replaceTrack`s local tracks in, and sets `direction = "sendrecv"` (they arrive `recvonly`). See `attachLocalMediaToAnswer()`. Table-driven via `resolveSlots()` since Session 4.
- **Never touch a stopped transceiver, and never let the answerer's attach loop throw.** Setting `.direction` or calling `replaceTrack` on a stopped/rejected transceiver throws `InvalidStateError`, which aborts *before* `createAnswer()` — so no answer is ever sent and the offerer sits at `have-local-offer` forever with healthy ICE and no error on its side. Skip anything `"stopped"`, skip kinds other than audio/video.
- **`have-local-offer` + `iceConnectionState: new` means the answer never came back.** Not an ICE or TURN problem. Relay candidates in the offerer's list prove TURN allocated fine. Look at the *other* device.
- **An `RTCIceCandidate` does not survive JSON with its useful fields.** `toJSON()` serialises only `candidate`, `sdpMid`, `sdpMLineIndex`, `usernameFragment`. `type`, `protocol`, `address` are parsed properties and come out `undefined`. Rebuild with `new RTCIceCandidate(payload.candidate)` before logging.
- **One Supabase channel name means one global room.** `CHANNEL_NAME` is a constant in `signaling.js`, so every dev instance joins the same room. If `presence sync` reports more than 2, close stale tabs before debugging anything else.
- **Async device work needs a generation counter.** Opening a camera takes ~300ms; clicking faster leaves several `getUserMedia` calls in flight, and a guard that only re-checks `cameraOn` passes for all of them. The abandoned track **holds the camera open** — light stays lit while the UI says off. Claim an op number at the top (`const op = ++cameraOpRef.current`) and discard stale results.
- **`requestVideoFrameCallback` does not fire while the document is hidden.** Guard with `document.hidden` and listen for `visibilitychange`. Measured 0ms guarded vs 3700ms not.
- **Releasing the camera is not free, and nothing can make it free.** Light off ⟺ device closed ⟺ cold `getUserMedia` on the way back. If a toggle feels instant *and* the light goes out, something is still holding the camera.
- **Check the transceivers, not the picture.** One-way video looks identical to a dozen unrelated faults. Build two `RTCPeerConnection`s in one page, run a full offer/answer, assert transceiver count, non-null `mid`, `currentDirection === "sendrecv"`. Fake tracks from `canvas.captureStream()` stand in for devices. `loopbackTest.js`, `window.__loopbackTest()`.
- **Mute is not detectable from the receiving end.** A muted mic sends silence, a stopped camera sends nothing, and neither is distinguishable from a network stall. Device state must be *told* over signaling (`media-state`), never inferred.
- **An idle screen-share receiver reports `track.muted === false`.** Because the slots are reserved at connection time, their receivers exist and aren't muted long before anyone shares. "Is my partner sharing" rides the same `media-state` message (`sharing: true/false`).
- **Presence identity must be stable across reloads.** Keying on a per-load random id makes every refresh a new lingering entry — two people showed up as five. Keyed on a per-tab id in `sessionStorage`. Verify: `participants` in `presence sync` stays at 2 no matter how often either side reloads.
- **Presence keeps multiple metas per key.** `Object.keys(state).length` is the participant count; flattening metas counts *connections*. Collapse each key to its newest meta by `joinedAt`.
- **A peer connection belongs to a peering session, not to the page.** When the partner reloads they're a new peer needing a brand-new `RTCPeerConnection`. Reusing a completed one gives `setRemoteDescription ... called in wrong state: stable` and leaves a frozen last frame that looks live.
- **Signals need `to` / `from` / `session`.** Broadcast reaches every channel member. The `session` check prevents a stale offer renegotiating a live connection.
- **Use `pagehide`, not `beforeunload`,** to untrack presence.
- **Glare is not handled, and doesn't need to be yet.** Roles are fixed and deterministic; exactly one side ever offers. Screen share never triggers an offer (4-slot design). This stops being safe the moment something *does* force renegotiation — then implement W3C perfect negotiation.
- **TURN measured 2026-08-24, single-machine loopback against ExpressTURN:** allocation and credentials work; **relay ↔ non-relay** connects (`relay/62.210.205.50 <-> srflx/140.82.222.1`) — the case that matters. **Relay ↔ relay** failed, but both peers shared one machine and one public IP, so that's hairpinning and not conclusive. Resolve with `?relay=1` on both real devices.
- **Don't over-read a multi-IP TURN host.** A server relays to any peer it has a permission for, regardless of which server that peer used. Extra resolved IPs mean more candidates, not fewer. Don't switch providers over two relay addresses in a log.
- **Read `SESSION_2_POSTMORTEM.md`** before debugging signaling or connection problems.
- **Read `SESSION_3_POSTMORTEM.md`** before touching transceivers or tracks. Part 5 has the loopback test.

---

## Current status

**Working on:** Session 3E next — rehome the peer connection into the panel iframe. Sessions 1E and 2E are done.

**Correction:** earlier notes claimed a throwaway prototype in `watchparty-ext/`. It never existed — not on disk, not in any commit. Sessions 1E and 2E were built and verified with no prior reference.

**Session 1E built:**
- `public/manifest.json` — MV3, `<all_urls>`, no `default_popup`, `panel.html` web-accessible
- `src/background/background.js` — toolbar click → `sendMessage`, falling back to `chrome.scripting.executeScript` then retry; quiet warning on `chrome://` pages
- `src/panel/` + `panel.html` — placeholder React panel at the extension origin, `allow="camera; microphone"` already delegated
- **Two-pass build.** `npm run build` = pass A (`panel.html` + `background.js`, ES modules, stable entry filenames) then pass B (`content.js`, IIFE, `emptyOutDir: false`). Two passes because **MV3 content scripts cannot be ES modules** and a module content script fails silently. `@crxjs/vite-plugin` was checked (2.7.1, healthy, vite ^8 ok) and declined in favour of owning the wiring.
- `npm run dev` / `preview` removed — no dev server in this architecture. `.claude/launch.json` still points at the deleted `dev` script.

**Session 2E built:** `src/content/content.js` now squeezes the page — `applySqueeze`/`removeSqueeze`, wired into `togglePanel`. The corrected mechanism (width on `<html>`, transform on `<body>` — **not** both on `<html>` as an earlier draft of this doc said) is in the "Known tricky areas" bullet above. Verified against the actual built `dist/content.js` bundle, not a simulation: real youtube.com (masthead/guide/bottom-bar squeeze correctly, player reflows 880→640px, 3 clean toggle cycles with zero width drift) and real twitch.tv (zero overflow introduced by the squeeze, confirmed via before/after comparison after an initial reading turned out to be a page-still-loading artifact). Collapse-to-thin-strip was deliberately deferred, not built — panel open/closed (via the existing toggle) is the only state.

**Not verified — needs a real loaded extension, not just the browser pane:** fullscreen behavior (reasoned to work — fullscreen promotes to the browser's top layer, above any z-index — but `requestFullscreen()` needs a genuine user gesture automation can't provide), and real cross-device use.

**SPA navigation persistence, confirmed on the real bundle:** clicked a related-video link on a real YouTube watch page (Big Buck Bunny → The Good Dinosaur). Single navigation entry (client-side routing, not a reload) — panel, squeeze, and `window.__watchPartyContentLoaded` all survived untouched. So same-site navigation that doesn't reload the document is already fine today, not something later sessions need to fix. A link to a different site, or anything that forces a real page reload, still tears the panel down — that's the documented hard-navigation gap, deferred to V2.

**Known gap, decide before 4E:** DRM video cannot be captured. Netflix/Disney+/Max/Prime/Hulu render through Widevine's protected path and `chrome.tabCapture` gets a **black frame** (audio usually survives). Was equally true of `getDisplayMedia`, so not a regression — but it splits "watch anything" into streamable (YouTube, Twitch, Vimeo, embeds) vs. black frame. This is why Teleparty syncs playback instead of streaming video.

**Carried over from the web app, working, do not rebuild:**
- Signaling over Supabase Realtime (`signaling.js`), verified cross-network (laptop wifi ↔ iPhone cellular)
- Peer connection, presence, offerer election, survives either side refreshing
- 4-slot transceiver design (`mediaSlots.js`), loopback-verified
- Camera/mic controls with device release and generation counters
- Quality tuning + codec preference (`screenShare.js`) — capture step needs rewriting, rest stands
- `loopbackTest.js`
- STUN + TURN with ExpressTURN

**Never verified against real devices, still open:** measured codec/bitrate via `getStats()` (want VP9, ~3 Mbps), Chrome's stop-sharing behaviour, camera/mic toggles while a share is live, cross-device pass, `?relay=1` on both devices with a real 3 Mbps share.

<!-- Update these lines as you go so context carries between sessions. -->

---

## Session plan (details in SPEC.md)

1. **1E** — Extension scaffold: manifest, service worker, content script, Vite multi-entry build, load/reload loop. **Done.**
2. **2E** — Docked sidebar + page squeeze. **Done** — verified on real YouTube and Twitch. Collapse/expand deferred, still open.
3. **3E** — Rehome the peer connection into the panel iframe; camera call working again ← next
4. **4E** — Tab capture replacing `getDisplayMedia`; handle the muted-tab problem
5. **5E** — Chat (live, then persisted)
6. Request-pause nudge
7. Emoji reactions (overlay on the page — the extension can do this properly now)
8. Session logging
9. Summaries