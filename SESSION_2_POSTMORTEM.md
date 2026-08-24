# Session 2 Postmortem — How the Camera Call Actually Got Working

A *postmortem* is the industry term for a written account of a failure after it's
resolved: what broke, what we tried, why each attempt failed, and what to do
differently. This one covers Session 2 — signaling plus the first WebRTC peer
connection — which took five attempts to get right.

The goal is that you could diagnose this class of bug yourself next time. The
short version of the lesson:

> Four of the five attempts fixed a **symptom**. Only the fifth fixed the
> **model**. The first four each made the code more complicated and introduced a
> new failure mode.

---

## Part 1 — Jargon

### The WebRTC handshake

**Signaling** — WebRTC can't introduce two browsers to each other. Something else
has to carry the "here's how to reach me" messages until a direct connection
exists. That's signaling, and it's *your* problem to build. We use Supabase
Realtime. It is not part of WebRTC.

**SDP (Session Description Protocol)** — a blob of text describing "here is the
media I want to send, the codecs I support, and my encryption fingerprint."

**Offer / Answer** — the two-step handshake. One side creates an **offer** (an
SDP), the other replies with an **answer** (another SDP). Exactly one side offers.
Deciding which side is the **offerer election**, and it caused a lot of pain here.

**ICE (Interactive Connectivity Establishment)** — the process of finding a
network path between two browsers that are usually both behind routers. It works
by gathering **candidates** (possible addresses), trading them over signaling, and
then testing every pair to see which actually work.

**Candidate types** — these appear directly in our logs:
- `host` — your machine's own LAN address, e.g. `10.168.0.244`. Works only if both
  peers are on the same network.
- `srflx` ("server reflexive") — your public address as seen from outside,
  discovered via STUN. This is what works for most internet connections.
- `relay` — an address on a TURN server that forwards traffic for you. The
  fallback when no direct path exists.

**STUN** — a tiny service that answers "what does my address look like from the
outside?" Free, cheap, no relaying.

**TURN** — a relay server that forwards your media when a direct path is
impossible (symmetric NAT, UDP-blocking firewalls). Costs bandwidth, so it's a
fallback, not a default. SPEC.md §1 estimates 10–20% of connections need it.

**Trickle ICE** — sending candidates as they're discovered rather than waiting for
all of them. It's why candidates can arrive *before* the offer/answer they belong
to, which is why our code has a `queuedCandidates` array.

### Connection state — three different state machines

These are constantly confused, and telling them apart is most of the diagnostic skill:

**`signalingState`** — where you are in the *offer/answer* handshake.
- `stable` — no negotiation in progress (either not started, or fully finished)
- `have-local-offer` — I sent an offer, waiting for an answer
- `have-remote-offer` — I received an offer, need to answer

**`iceConnectionState`** — whether a *network path* was found.
`new` → `checking` → `connected` / `failed`.
Reaching `checking` proves remote candidates arrived — a very useful signal.

**`connectionState`** — the overall rollup, including **DTLS** (the encryption
handshake that runs after ICE succeeds). You can see
`iceConnectionState: connected` while `connectionState` is still `connecting` —
that means the network path works but encryption hasn't completed.

**Renegotiation** — changing an established connection (e.g. adding a screen-share
track) requires a *second* offer/answer round on the live connection.

**Glare** — both peers send an offer at the same time. Neither can accept the
other's, because accepting requires `signalingState === "stable"`.

**Perfect negotiation** — the W3C-recommended fix for glare: one peer is
designated **polite** and one **impolite**. On collision the polite peer performs a
**rollback** (undoes its own offer and accepts the other's). We have *not* built
this yet — see Part 6.

### Presence — where the real bug lived

**Presence** — Supabase Realtime's "who is currently in this channel" feature.
Built on Phoenix Presence (Elixir). It's how our two tabs discover each other.

**Presence key** — the identifier an entry is filed under. **We chose this value,
and choosing it badly was the root cause of Session 2.**

**Presence meta** — the payload attached to a connection. Critically:

> **A key holds a *list* of metas, not one.** Presence is designed for "user X has
> three devices open." Joining again with the same key **appends** a meta; it does
> not replace one.

So `Object.keys(state).length` counts **people**, while
`Object.values(state).flat().length` counts **connections**. We got this wrong,
twice, in opposite directions.

**Ghost** — our term for a presence entry belonging to a page load that no longer
exists. When you refresh, the old connection's entry doesn't vanish instantly —
the server only removes it when it notices the socket died, which can take 30–60
seconds, and longer on a phone that got backgrounded. Until then, the dead load
still looks like a live participant.

**Broadcast** — Supabase's message-sending API. Two properties that bit us:
1. It's **fire-and-forget** — no delivery guarantee, no retry. A message sent
   before the other side is listening is simply gone.
2. It goes to **every member of the channel**, not just your partner. With ghosts
   or extra tabs around, everyone hears everyone.

**Peering session** — our term for "one connection between one pair of page
loads." The crucial insight of attempt 4: a peer connection belongs to a peering
session, **not to the page**. If your partner refreshes, that is a *different*
peer, and the old connection is dead.

**Seats** — a design we considered and rejected: fix identity in the URL
(`?seat=1` / `?seat=2`) so there's no election and no ghosts by construction. We
chose automatic pairing instead, but the seat idea is worth knowing — it's how a
1:1 call link works.

**SFU (Selective Forwarding Unit)** — a media server in the middle. Google Meet,
Zoom, and Discord all use one. **They don't have our offerer-election problem at
all**, because one end is always the server with a fixed role. Election is a cost
of true peer-to-peer, which is the right architecture for exactly two people.

---

## Part 2 — The five attempts

Each commit maps to one attempt:

```
99e2567  starting state — session 2, mid-debug
9d47da8  attempt 1 + 2  — TURN theory, then the ?relay=1 flag
ec802ad  attempt 3      — handshake instrumentation + election fix + nudge
37ecca2  attempt 4      — peering session lifecycle + ghost filtering
e826eaf  attempt 5      — stable identity model   ← the actual fix
2968a22  session 2 complete
```

### Attempt 1 — "The TURN server is misconfigured"

**Symptom:** The TURN-only test wouldn't connect.

**Hypothesis:** `.env.local` pointed at `free.expressturn.com`, but ExpressTURN's
docs issue credentials against `relay1.expressturn.com`. Wrong host, valid
credentials → failure.

**Why it was wrong:** Your log contained this line:

```
local candidate type: relay udp
```

A **`relay` candidate cannot exist unless the TURN server accepted the
allocation.** Its presence proves the host and credentials were fine. The
hypothesis was dead on arrival.

**What it taught:** *Every log line is a proof of something.* Learn what each one
proves and you can eliminate whole hypotheses without testing them:

| Log line | Proves |
|---|---|
| `relay` candidate gathered | TURN credentials + host are correct |
| `iceConnectionState: checking` | Remote candidates arrived → signaling works |
| Any candidate at all | `setLocalDescription` ran → an offer/answer was created |
| `iceConnectionState: connected` | A network path exists |
| `connectionState` stuck at `connecting` | ICE succeeded, DTLS did not |

### Attempt 2 — "Take off the relay pin"

**The realization:** `App.jsx` still had `iceTransportPolicy: "relay"` hardcoded
from an earlier test. That option **throws away every direct candidate** and
forces traffic through TURN — the artificial worst case. We had been debugging a
test harness, not the feature.

**What changed:** the pin became an opt-in flag, so the TURN test stays repeatable
instead of being a line commented in and out:

```js
// TURN normally only kicks in when a direct connection fails, which means a
// broken relay config looks perfectly fine until the day it matters.
const forceRelay = new URLSearchParams(window.location.search).get("relay") === "1";

pc = new RTCPeerConnection({
  iceServers,
  ...(forceRelay ? { iceTransportPolicy: "relay" } : {}),
});
```

**Why it still failed:** the failure moved *earlier*. Now the log was only:

```
ICE mode: all transports
```

No candidates at all. Since ICE gathering starts on `setLocalDescription`, zero
candidates means **no offer was ever created**. The problem was no longer ICE or
TURN — it was the handshake before them.

**What it taught:** *When a fix makes the failure move, that's progress.* Note
which layer failed. The failure had moved from "ICE can't connect" up to
"signaling never produced an offer."

### Attempt 3 — Instrument the handshake

Two hypotheses fit equally well, and one console couldn't separate them:

- **H1 — election deadlock.** Both peers concluded "I'm the answerer," so nobody
  offered.
- **H2 — a silent exception.** `createOffer()` threw and the error vanished.

H2 was a genuine bug worth showing, because it's a JavaScript trap rather than a
WebRTC one:

```js
// signaling.js — onPeerOnline is async, but is called without await or .catch
onPeerOnline({ isOfferer });
```

```js
// App.jsx — this only catches errors from start() itself
start().catch((err) => setStatus(`error: ${err.message}`));
```

`onPeerOnline` is invoked *by the channel*, not by `start()`. So a rejected
promise inside it became an **unhandled rejection** that never reached the UI. The
app just sat on its last status forever.

**The useful idea from this attempt** — since Chrome on iOS is WebKit underneath
and painful to remote-debug, we put the state machine **on the screen** so each
device self-reports: `answerer · waiting for offer`, `offerer · offer sent`. Read
both screens, know the state. That technique is worth keeping.

**Why it failed:** it *did* connect — but refreshing one device produced:

```
error: Failed to set remote answer sdp: Called in wrong state: stable
```

And the cause was a fix from this very attempt. To handle a dropped offer, we
added a re-send path:

```js
// The bug: "I already sent an offer" was assumed to mean "my offer was lost."
if (offerSent && pc.localDescription) {
  signaling.sendSignal({ type: "offer", description: pc.localDescription });
}
```

But there's a second reason you'd have a completed offer: **the handshake already
finished and your partner was replaced.** After a refresh, the laptop re-sent a
*stale* offer from a completed session; the new phone answered it; the laptop
tried to apply that answer while in `stable` and threw.

**What it taught:** *A guard based on "did I do X?" is weaker than one based on
"what state am I in?"* `offerSent` conflated two very different situations.
`pc.signalingState === "have-local-offer"` distinguishes them.

### Attempt 4 — Peering session lifecycle

**The structural insight**, and the most valuable idea in this whole session:

> The `RTCPeerConnection` was created once per page load. But a peer connection
> belongs to a **peering session** — one pair of page loads. When your partner
> refreshes, that is a new peer, and the old connection is dead.

That explains why refreshing *both* devices was the only reliable path: it's the
one case where both sides get fresh state.

The fix was to make the lifecycle explicit:

```js
function endPeeringSession() {
  clearTimeout(offerTimer);
  pc?.close();
  pc = null;
  offerSent = false;
  nudgeSent = false;
  remoteDescriptionSet = false;
  queuedCandidates = [];
  // Without this the partner's frozen last frame stays on screen, looking
  // exactly like a live connection.
  if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
}
```

Note the local camera stream is deliberately *not* stopped — it belongs to the
page, not the session, and re-acquiring it would re-prompt for permission.

Plus proper state guards, replacing the weak `offerSent` check:

```js
if (payload.type === "offer") {
  // Only a connection with nothing in flight can accept an offer.
  if (pc.signalingState !== "stable") return;
  ...
} else if (payload.type === "answer") {
  // An answer is only meaningful while our own offer is outstanding.
  if (pc.signalingState !== "have-local-offer") return;
  ...
}
```

**Why it still failed.** Ghost filtering was added using a `deviceId` in
`localStorage` — and `localStorage` is **shared across all tabs in a browser**, so
two tabs on one laptop each filtered the *other* out as "my own ghost" and never
paired. That broke the exact scenario SPEC.md §5 defines as Session 2's goal.
Switching to `sessionStorage` (per-tab, survives reload) fixed it.

But the real problem showed up in your next log:

```
presence sync: {entries: 5, others: 4, ...}
```

**Five presence entries for two people.**

**What it taught:** *When each fix requires another fix, stop fixing and question
the model.* Four attempts had all been heuristics for "which of these entries is
my partner?" Nobody had asked why there were so many entries.

### Attempt 5 — Fix the identity model (this one worked)

**The root cause**, present since the very first commit:

```js
const clientId = crypto.randomUUID();   // NEW VALUE ON EVERY PAGE LOAD

const channel = supabase.channel(CHANNEL_NAME, {
  config: { presence: { key: clientId } },   // ← the ghost factory
});
```

Presence was keyed on a value that changed every page load. So **every refresh
registered a brand-new participant** that lingered until its socket timed out.
The ghosts weren't an occasional glitch — the code manufactured one per refresh.

Every downstream heuristic — the election, the tie-break, the nudge, partner
selection — was searching for one real person in a crowd the code itself kept
filling.

**Fix 1 — stable identity.** Key presence on something that survives a reload:

```js
// sessionStorage, not localStorage, and the distinction matters both ways:
// it must survive a refresh (so we recognise our own previous load) but must
// NOT be shared between tabs (or two tabs on one machine would each mistake
// the other for itself and never pair).
function getTabId() {
  let id = sessionStorage.getItem(TAB_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(TAB_ID_KEY, id);
  }
  return id;
}

presence: { key: tabId }
```

This also fixed a subtler bug nobody had noticed: role came from
`clientId < otherIds[0]`, and since `clientId` changed every load, **a refresh
could silently flip which side offers.**

**Fix 2 — count people, not connections.** A scripted test disproved an
assumption I had stated confidently: that a stable key makes a reload *replace*
the entry. It doesn't:

```
participants: 2      ← 2 keys
metas: 5             ← 5 connections under those 2 keys
A_joinedAt: [1000, 3000, 3002, 3001]   ← four metas under ONE key
```

Presence groups connections under a key. So each key must be collapsed to its
newest meta:

```js
const newestMeta = (metas) => metas.slice().sort((a, b) => b.joinedAt - a.joinedAt)[0];
const others = Object.keys(state)
  .filter((key) => key !== tabId)      // everyone who isn't me
  .map((key) => newestMeta(state[key])) // their CURRENT load, not their old ones
  .filter(Boolean);
```

**Fix 3 — address the messages.** Broadcast reaches every channel member, so each
message is checked three ways:

```js
if (payload.to !== tabId) return;                    // is it for me?
if (!partner || payload.from !== partner.tabId) return;  // is it from my partner?
if (payload.session !== sessionId) {                 // is it from THIS session?
  console.warn("ignoring signal from a finished session:", payload.type);
  return;
}
```

The third check is the one that fixed the hardest symptom: a stale offer
renegotiating a connection that was already up and working.

**Fix 4 — detect a reload via `joinedAt`.** Since the key no longer changes, we
need another way to notice your partner restarted:

```js
// Same partner, same page load — nothing has changed.
if (partner && partner.tabId === next.tabId && partner.joinedAt === next.joinedAt) return;

// Either a new partner, or the same one after a reload (their joinedAt moved).
// Both mean any existing connection is dead and a new peering session begins.
partner = { tabId: next.tabId, joinedAt: next.joinedAt };

// Both sides compute this identically from the same two presence entries.
sessionId = [tabId, partner.tabId].sort().join(":") + "@" + Math.max(joinedAt, partner.joinedAt);
```

The `sort()` matters: both peers must derive the *same* session id from the same
two entries, so it can't depend on who is computing it.

**Fix 5 — announce departure.** Don't wait 30–60s for the server to notice a dead
socket:

```js
// `pagehide` rather than `beforeunload` because iOS Safari/WebKit frequently
// doesn't fire beforeunload at all -- and the phone is exactly the device most
// likely to be backgrounded or closed abruptly.
window.addEventListener("pagehide", () => {
  channel.untrack();
  supabase.removeChannel(channel);
});
```

---

## Part 3 — How to debug this yourself next time

### Step 1: Localize the failure to a layer

A call has four layers, and they fail in order. Find the deepest one you reached:

```
1. SIGNALING     do the two peers even see each other?
     ↓           evidence: presence sync shows a partner
2. HANDSHAKE     was an offer created and answered?
     ↓           evidence: any local candidate appears at all
3. ICE           was a network path found?
     ↓           evidence: iceConnectionState reaches connected
4. DTLS          did encryption complete?
                 evidence: connectionState reaches connected
```

Then apply the proof table from Attempt 1. Almost every hypothesis dies instantly
against it, and you avoid testing things that are already proven fine.

### Step 2: Ask what BOTH screens say

Half these bugs were invisible from one device. "Both stuck on `connecting`" and
"one errored, one says answer sent" have completely different causes. Keep the
state machine visible in the UI so the phone can tell you without a debugger.

### Step 3: Watch `participants`, not `metas`

```js
console.log("presence sync:", {
  participants: Object.keys(state).length,   // ← people. Must be 2.
  metas: Object.values(state).flat().length, // ← connections. Briefly higher is fine.
  partner: next?.tabId ?? null,
});
```

If `participants` climbs past 2 while two people are testing, stop. Nothing
downstream can be trusted while identity is wrong. **This single number would have
saved three attempts.**

### Step 4: Notice when you're stacking heuristics

The warning sign: each fix needs another fix, and the code grows guards, retries,
and tie-breaks. That means you're patching symptoms. Ask instead:

- What does this data *actually* represent? (Presence = connections, not people.)
- What lifetime does this object have? (A connection belongs to a peering session,
  not a page.)
- Is my identifier stable over the lifetime I'm using it for?

### Step 5: Verify assumptions instead of asserting them

I stated as fact that a stable key makes a reload replace the entry. It doesn't.
A 20-line script found that in one run. If a claim about a library's behavior is
load-bearing, test it — especially before it costs another round of two-device
testing.

### Useful tools

- **`chrome://webrtc-internals`** — open it *before* loading the page. Shows every
  candidate pair, its state, and both endpoints. Far better than console logs for
  ICE problems.
- **Trickle ICE test page** (`webrtc.github.io/samples/.../trickle-ice/`) — tests
  STUN/TURN credentials with zero app code involved.
- **`?relay=1`** — our own flag; forces TURN-only so the relay can't sit silently
  broken.

---

## Part 4 — Why this is harder than it looks

Worth internalizing: **Google Meet, Zoom, and Discord do not have this problem.**
All three route media through an **SFU** — a server. Each client negotiates with
the server, so one end always has a fixed role. There's no election, and
membership is a fact the server maintains authoritatively.

We're doing true peer-to-peer, which SPEC.md correctly chose — for exactly two
people, direct P2P is the *right* design, not a lesser version of Zoom. But it
means we inherit two problems a server would have solved for us:

1. **Who offers?** No authority, so both sides must derive the same answer
   independently from shared state.
2. **Who's actually here?** Supabase presence is eventually-consistent gossip, not
   an authoritative roster. Ghosts are inherent to that model.

Real apps solve both with **authenticated identity** — a stable user id from a
login. Our `tabId` is a poor man's version of exactly that, and when V2 auth
lands, it simply becomes "which of the two signed-in users you are."

---

## Part 5 — What's still unproven

**The TURN relay path has never actually been exercised.** The working call may
have connected directly. Confirm with `?relay=1` on **both** devices; every
selected candidate pair should be type `relay`. This matters because TURN only
activates when a direct connection fails, so a broken relay config looks perfect
until the day it doesn't — and roughly 10–20% of real connections need it.

---

## Part 6 — What breaks next, and why

**Session 4 (screen share) will reintroduce glare.** Right now, conflicting offers
are simply ignored:

```js
if (pc.signalingState !== "stable") return;   // safe only because roles are fixed
```

That's safe *today* because roles are deterministic and only one side ever offers.
Session 4 breaks both assumptions: adding a screen-share track to a live
connection triggers **renegotiation**, and V1 wants either person able to share.
Two simultaneous offers become genuinely possible.

That's when **perfect negotiation** is needed — designate one peer polite and one
impolite, and on collision the polite one rolls back its own offer and accepts the
other's. `tabId` comparison already gives a stable, symmetric way to assign those
roles.

CLAUDE.md lists renegotiation as the most likely source of "camera worked, then
screen share broke everything." That prediction is correct, and this is the
mechanism.
