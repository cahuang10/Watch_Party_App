# Session 3 Postmortem — Real Camera and Mic Controls

Session 2's postmortem was about a bug that *announced itself* — nothing connected,
and the console was full of errors pointing at the problem. Session 3's hardest bug
was the opposite: **everything looked healthy and media only flowed one way.** No
error, no warning, a valid SDP on both sides.

The short version of the lesson:

> Session 2's rule was *fix the model, not the symptom.* Session 3's rule is
> **verify the model, don't eyeball the symptom.** One-way video looks identical to
> a dozen unrelated faults. The thing that actually found it was a 30-line test that
> printed a table of transceivers.

The other thing worth carrying forward: two of the bugs here were **mine**,
introduced while fixing something else. That is normal, and it is exactly why the
verification technique in Part 5 matters more than any individual fix.

---

## Part 1 — Jargon

Session 2 covered signaling, offer/answer, ICE, and candidate types. This session
turned on a different set of terms.

### Transceivers, senders, and m-lines

**m-line** — a line in the SDP beginning with `m=`, describing one media stream.
`m=audio ...`, `m=video ...`. An offer with two m-lines is proposing two streams.
Counting them is a fast sanity check: this app should always produce exactly 2.

**Transceiver** — the object pairing one sender and one receiver, corresponding to
one m-line. **This is the mental model that makes everything else make sense:**

> A transceiver is a durable **slot** in the connection.
> A track is just **what's currently plugged into that slot.**

The slot is negotiated once and stays put. What flows through it can change freely.

**Sender (`RTCRtpSender`)** — the sending half of a transceiver. `sender.track` is
what it's transmitting, or `null`.

**`mid`** — the id tying a transceiver to an m-line in the SDP. `mid: null` means
**this transceiver was never negotiated** — it exists in your JavaScript and the
other side has no idea it's there. A `mid: null` transceiver never sends anything.
This one field is the tell for the main bug below.

**`direction` vs `currentDirection`** — `direction` is what you *want*
(`sendrecv`, `sendonly`, `recvonly`, `inactive`). `currentDirection` is what was
actually *negotiated*. They differ, and the second is the one that tells the truth.
For a healthy two-way call both peers should show `currentDirection: "sendrecv"` on
every transceiver.

### Changing media without renegotiating

**`replaceTrack(track)`** — swaps what a sender transmits, **without touching
offer/answer**, as long as the kind matches (video→video). `replaceTrack(null)`
stops sending with the slot left intact.

**`addTrack()` / `removeTrack()`** — the alternative, and the trap. Both fire
`negotiationneeded` and require a fresh offer/answer round. This project has no
glare handling, so an unplanned renegotiation is genuinely dangerous.

That difference is the whole basis of the camera control: we can physically
`stop()` the camera and re-acquire it later, and the negotiation layer never
notices.

### Mute vs release

**`track.enabled = false`** — mute. The track stays live, the device stays open,
and it transmits black frames or silence. Instant, reversible, invisible to the
connection.

**`track.stop()`** — release. The device is handed back to the OS and the camera
light goes off. **Permanent** — a stopped track can never be restarted, so coming
back always means a fresh `getUserMedia`.

The app deliberately uses a different one for each:

| Control | Mechanism | Why |
|---|---|---|
| Camera | `replaceTrack(null)` + `stop()` | Privacy is the point; the light must go off |
| Mic | `enabled = false` | Instant unmute matters mid-sentence; no visible indicator to worry about |

### `media-state`

Our own signal type, not part of WebRTC. **The receiving end cannot detect that you
muted.** A muted mic sends silence and a stopped camera sends nothing, and neither
is distinguishable from a network stall. So device state is *told*, never inferred:
`{ type: "media-state", camera, mic }` over the existing Supabase channel.

---

## Part 2 — What was wrong with Session 3's first attempt

The original build made the whole camera tile a `<button>`. Clicking it shrank the
tile to a 72px circle with an emoji. Local-only — it never touched the
`MediaStreamTrack`, so it changed nothing about what the other person received.

The verdict was blunt and correct: **the toggle does nothing real.** The control
anyone actually wants in a two-person call is *turn my camera off so my partner
can't see me*. There was also no mic control at all, despite `getUserMedia` already
requesting audio.

Two structural problems came with it:

- **The whole tile being a `<button>` was a dead end.** Sessions 4–7 add screen
  share, chat, reactions, and the pause nudge. A `<button>` nested inside a
  `<button>` is invalid HTML and the inner one stops receiving clicks.
- **The camera opened at page load**, so the light burned the entire time you sat
  alone waiting for someone to join.

Decisions that came out of it:

1. Camera off **fully releases the device**; mic mute uses `enabled`.
2. Both states are **signaled**, so each tile shows the other person's real state.
3. The camera opens **when a partner arrives**, not at page load.
4. Controls live **inside your own tile** — click anywhere to toggle the camera, and
   the mic button is a circle at bottom-centre that appears on hover.

---

## Part 3 — The failures, in the order they were found

### 3.1 — The camera opened at page load

**Symptom.** Camera light on while sitting alone in an empty room.

**Cause.** `getUserMedia` was called in the mount effect, before anyone else existed.

**Fix.** Moved into `onPeerOnline`, awaited **before** `createPeerConnection()` — so
the first offer already carries the tracks and nothing has to renegotiate later.
`endPeeringSession()` now also stops the tracks, so leaving turns the camera off.

**The bit that needed care.** Adding an `await` inside `onPeerOnline` created a race:
the partner can reload while `getUserMedia` is still pending, firing `onPeerOnline`
again. Without a guard, the stale stream gets wired into the new connection. Fixed
with a token counter bumped in `endPeeringSession()`; after the await, bail if it
moved. This is the same class of bug that ate Session 2 — **state belonging to a
peering session outliving that session.**

---

### 3.2 — The camera boxes were squashed on the phone

**Symptom.** On the iPhone, boxes rendered as narrow portrait slivers with heavily
cropped video.

**Cause.** The CSS set `width: 320px`, `height: 240px`, `max-width: 40vw`, **and**
`aspect-ratio: 4/3`. `aspect-ratio` only applies when at least one dimension is
`auto`; with both definite it is **inert**. On a 375px-wide phone `max-width`
clamped the width to ~150px while the height stayed 240px.

**Fix.** `flex: 1 1 280px; max-width: 420px; aspect-ratio: 16 / 9`, height left auto.

**Verified.** Measured in a 375px viewport: **349 × 196 = 1.778**, exactly 16:9, and
the boxes stack instead of crushing.

**Lesson.** `aspect-ratio` silently does nothing if you also set both dimensions.
Measure the rendered box; don't trust the stylesheet to mean what it says.

---

### 3.3 — One-way video (the big one, and self-inflicted)

**Symptom.** One device showed both cameras. The other showed only its own, with the
partner's tile black. **No error on either side.**

**Cause.** While building the camera control I switched both peers to pre-create
their transceivers with `addTransceiver`, so a video slot would exist even when the
camera started off.

On the **answerer** that is wrong. `setRemoteDescription(offer)` builds its *own*
transceivers from the offer's m-lines, and **it will not adopt ones created by
`addTransceiver`** — only `addTrack`-created transceivers are eligible for that
association. So the answerer ended up holding four:

| transceiver | `mid` | `currentDirection` |
|---|---|---|
| its own pre-created audio | `null` | `null` — orphaned, never sends |
| its own pre-created video | `null` | `null` — orphaned, never sends |
| audio from `setRemoteDescription` | `0` | `recvonly` |
| video from `setRemoteDescription` | `1` | `recvonly` |

The offerer correspondingly went `sendonly` on both.

**Why it was silent.** The answer still carried the correct **two** m-lines. The
answerer's orphaned transceivers simply weren't represented in it. Nothing threw,
nothing warned. Media flowed offerer → answerer and stopped.

Session 2's `addTrack` version never had this problem, which is why it appeared now
and looked like a mystery.

**Fix.** `attachLocalMediaToAnswer()`. The rule:

> **The offerer defines the m-lines. The answerer fills in what the offer created.**

- **Offerer** — keeps `addTransceiver(track ?? kind, { direction: "sendrecv" })`,
  reserving the video slot even with no camera track.
- **Answerer** — builds the connection with **no transceivers at all**. Then,
  between `setRemoteDescription` and `createAnswer`, walks `getTransceivers()`,
  `replaceTrack`s its local tracks in, and sets `direction = "sendrecv"`.

That last step is easy to miss: the transceivers arrive as `recvonly`, because they
were built from an offer at a moment when the answerer had nothing attached. Leaving
them that way is the same bug wearing a different hat.

**Verified** across all four camera on/off combinations: 2 m-lines every time, 2
transceivers per peer, every `mid` set, every `currentDirection` `sendrecv` — and
the video slot present with `sender.track === null` on whichever side had its camera
off, proving camera-off-at-join still leaves something to `replaceTrack` into.

---

### 3.4 — Then no answer came back at all

**Symptom.** Offerer stuck at `have-local-offer`. `iceConnectionState: new`. No
candidate pair. Healthy relay candidates in the list.

That combination **looks exactly like a TURN failure**, and isn't. It means the
offer went out and nothing came back.

**Cause.** `attachLocalMediaToAnswer` set `.direction = "sendrecv"` on every
transceiver. Setting `.direction` — or calling `replaceTrack` — on a **stopped**
transceiver throws `InvalidStateError`. That throw happened *before* `createAnswer()`,
so the answerer never replied. The offerer waited forever, looking perfectly healthy.

**The nasty shape of it:** the broken side is the quiet one. All the visible evidence
was on the machine that was working correctly.

**Fix.** Skip anything whose `direction` or `currentDirection` is `"stopped"`, and
skip kinds other than audio/video — an offer can legitimately carry sections we
didn't ask for.

**Lesson.** `have-local-offer` + `iceConnectionState: new` is never an ICE problem.
Go read the *other* device's console.

---

### 3.5 — Rapid toggling leaked camera tracks

**Symptom.** Camera light stayed on after toggling off.

**Cause.** `toggleCamera` is `async` and opening a camera takes ~300ms. Clicking
faster than that leaves several `getUserMedia` calls in flight. The guard only
re-checked `cameraOn` — which is `true` again by the time each one resolves — so
**every one of them passed** and attached a track. The stream ended up with two
video tracks; the orphaned one wasn't in the sender but still **held the camera
device open**.

**Fix.** A generation counter. Claim an op number at the top of the toggle
(`const op = ++cameraOpRef.current`) and discard the result if it no longer matches.

**Verified** by simulating off/on/off/on faster than the fake device could open:
**2 live tracks before the fix, 1 after.**

**Lesson.** A state check is not a race guard. If the state can return to its old
value, every stale continuation passes. Use a monotonic token.

---

### 3.6 — The camera light *still* stayed on

Two separate causes, and the second one was not in the code at all.

**(a) An unguarded `await`.** The off path read:

```js
await sender?.replaceTrack(null);        // if this throws…
stream?.getVideoTracks().forEach(...)    // …this never runs
```

`replaceTrack` throws `InvalidStateError` on a stopped sender — which is what a
sender becomes when its peer connection is closed underneath it, e.g. by presence
churn tearing down a session mid-toggle. One throw and the device was never released.

Fixed by **inverting the order**: release the device first, unconditionally, then
tidy the sender inside a `try/catch`.

> Do the thing the user asked for first. Never let cleanup stand between the user
> and the outcome.

**(b) A second tab.** The decisive clue was that the light went off correctly **on
the phone** but not on the laptop — same code, same build, opposite result. That
rules out the code immediately.

The laptop had a `localhost` tab open alongside the deployed one. Both joined the
same signaling room, both paired, and **each opened its own camera**. Toggling in one
tab cannot touch the other. Closing the stray tab fixed it.

**Lesson.** When the same build behaves differently on two devices, stop reading the
code. The difference is in the environment.

I reached for a code explanation twice before noticing this. The phone-vs-laptop
split was worth more than either guess.

---

### 3.7 — `remote candidate: undefined undefined undefined`

**Symptom.** Every received ICE candidate logged as three `undefined`s.

**Cause.** `RTCIceCandidate.toJSON()` serialises only `candidate`, `sdpMid`,
`sdpMLineIndex` and `usernameFragment`. `type`, `protocol` and `address` are
**parsed** properties, computed from the candidate string — they don't survive the
trip through Supabase broadcast.

**Fix.** Rebuild it: `new RTCIceCandidate(payload.candidate)` re-parses all three.

**Why it mattered.** That log line exists specifically to compare relay addresses
between peers. It had been silently doing nothing since it was written.

**Lesson.** A diagnostic that prints `undefined` is worse than no diagnostic — it
looks like it's working.

---

### 3.8 — A wrong belief in our own documentation

`CLAUDE.md` claimed that peers allocated on different IPs of a multi-IP TURN host
can never relay to each other, and that this makes every relay-to-relay pair fail.

**That is not how TURN works.** A TURN server relays to any peer it holds a
permission for, regardless of which server that peer used. Extra resolved IPs mean
*more* usable candidates, not fewer.

Measured against the real ExpressTURN credentials, forced relay-only:

| Trial | Result |
|---|---|
| relay ↔ non-relay | **connected** — `relay/62.210.205.50 ↔ srflx/140.82.222.1` |
| relay ↔ relay | failed |

The first row is the case that actually matters — one peer behind symmetric NAT,
the other reachable — and it **works**. The second is inconclusive: both test peers
shared one machine and one public IP, which asks the server to hairpin between two
of its own allocations. That says nothing about two devices on different networks.

Both peers landed on the **same** IP anyway, so the scenario the note warned about
didn't even occur.

The note has been corrected. **Don't switch TURN providers on the strength of two
different relay addresses in a log.**

---

### 3.9 — Five participants for two people

`CHANNEL_NAME` in `src/lib/signaling.js` is a constant. Every localhost dev server
**and** the Vercel deployment therefore join the same signaling room.

By the end of the session the console read:

```
presence sync: {participants: 5, metas: 5, ...}
new peering session — role: OFFERER … peering with 8f41808d
new peering session — role: OFFERER … peering with 9e727c60
new peering session — role: OFFERER … peering with 735c54e9
new peering session — role: OFFERER … peering with 7c6d07a1
```

Four dev servers were running and several tabs were open. The offerer election
thrashed through them one at a time, rebuilding the peer connection on each pass,
before eventually settling on a real partner. It also caused 3.6(b).

Session 2's rule still holds and is still the single most useful number on screen:
**`participants` must be 2.** If it isn't, close tabs before debugging anything else.

Not yet fixed — see Part 6.

---

## Part 4 — Process failures worth recording

A postmortem that only lists code bugs is missing half the value.

**Guessing before instrumenting.** The camera light got two confident explanations
from me — first the microphone, then the toggle race — before anyone looked at what
the tab actually held. The real answer (a second tab) was available much earlier from
the phone-vs-laptop asymmetry.

**Leaving the tree broken.** A half-applied rename left `toggleCamera` calling
`applyCameraToggle()` while the function was named `applyCameraToggleImpl` — a
runtime `ReferenceError`. It was uncommitted and never deployed, and `git reset
--hard` cleared it.

**Overstating the breakage.** I described that as "it won't build." It builds fine.
Undefined identifiers are legal JavaScript syntax; they fail at *runtime*. `node
--check` passes and `oxlint` only warns. Being imprecise about a failure mode is its
own small bug.

---

## Part 5 — The technique to reach for first

The single most useful thing to come out of this session.

**Two `RTCPeerConnection`s in one page, doing a full offer/answer, with fake tracks.**
No camera, no second device, no permission prompt, no network:

```js
// Fake media — needs no getUserMedia and no permission.
const canvas = document.createElement("canvas");
canvas.getContext("2d").fillRect(0, 0, 320, 180);
const videoTrack = canvas.captureStream(5).getVideoTracks()[0];
const audioTrack = new AudioContext()
  .createMediaStreamDestination().stream.getAudioTracks()[0];

const pc1 = new RTCPeerConnection();
const pc2 = new RTCPeerConnection();
// …replicate your real setup here, then hand-run the handshake:
await pc1.setLocalDescription(await pc1.createOffer());
await pc2.setRemoteDescription(pc1.localDescription);
await pc2.setLocalDescription(await pc2.createAnswer());
await pc1.setRemoteDescription(pc2.localDescription);

const table = (pc) => pc.getTransceivers().map((t) => ({
  mid: t.mid,
  kind: t.receiver.track.kind,
  cur: t.currentDirection,
  sending: !!t.sender.track,
}));
console.table(table(pc1));
console.table(table(pc2));
```

**The rule it teaches:**

> Assert on `mid`, `currentDirection`, and transceiver **count**.
> Do not assert on whether video appears.

A healthy two-peer connection in this app is, on **both** sides: exactly 2
transceivers, both with a non-null `mid`, both `currentDirection: "sendrecv"`.
Four transceivers on one side, or any `recvonly` / `sendonly`, is bug 3.3.

This found 3.3 in minutes after eyeballing had gotten nowhere, then verified 3.4 and
3.5. It runs in a few seconds and needs nothing but a browser tab.

### The diagnostic ladder for this class of bug

1. **Do both consoles agree a connection exists?** `connectionState: connected` on
   both, or only one?
2. **If one side is stuck at `have-local-offer`** — it is *not* ICE and *not* TURN.
   The answer never came back. Read the other device's console.
3. **If both are connected but video is one-way** — print the transceiver table.
   Count them, check every `mid`, check every `currentDirection`.
4. **If a device won't release** — check whether the *same build* misbehaves on both
   devices. If not, it's the environment: another tab, another app.
5. **Always check `participants` first.** It must be 2.

---

## Part 6 — What's still unproven

- **Relay across two genuinely different networks.** Load `?relay=1` on **both**
  devices — laptop on wifi, phone on cellular. Relay ↔ non-relay is verified working
  in loopback; the real two-network path is not.
- **relay ↔ relay between different networks.** The loopback failure was hairpinning
  and proves nothing.
- **The shared signaling room.** Dev and production still collide. The cheap fix is
  scoping the channel name by `import.meta.env.MODE`; the proper fix is a room id in
  the URL. Neither is done — it's a signaling-layer design change and deserves its
  own decision.
- **Document Picture-in-Picture** (locked decision #7). Untouched; the decision
  stands. Revisit after Session 4, once screen share exists and it's clear whether
  losing sight of each other actually bothers you.

---

## Part 7 — What breaks next

**Session 4 adds a screen-share track, and that means real renegotiation.**

Everything in this session was carefully built to *avoid* renegotiating — that's the
entire reason for `replaceTrack` and for reserving transceiver slots up front.
Adding a **new** track for screen share cannot avoid it: it needs a new m-line, which
means a new offer/answer round on a live connection.

That breaks the assumption holding the current design together. Right now conflicting
offers are simply ignored, which is only safe because roles are fixed and
deterministic — exactly one side ever offers. Once either person can start sharing,
both sides can offer at once. That is **glare**, and it's where the W3C "perfect
negotiation" pattern (polite/impolite peers, rollback) becomes necessary rather than
optional.

Two specific things to watch:

- **`attachLocalMediaToAnswer` currently assumes the offerer's two m-lines.** A third
  section changes what it has to handle. It already skips stopped and unrecognised
  transceivers, which should hold — but verify with the Part 5 test rather than
  assuming.
- **The `sendrecv` assignment is unconditional.** A screen-share m-line probably
  wants `sendonly` from the sharer and `recvonly` from the viewer. Blindly setting
  `sendrecv` on everything will be wrong the moment a third slot exists.

Run the loopback test **before** wiring screen share to a real display. It is much
cheaper than discovering the problem through a black rectangle.
