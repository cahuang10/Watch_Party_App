import { supabase } from "./supabaseClient";

// Bumped once from "watch-party-signaling" to orphan the pile of ghost presence
// entries the old per-load identity model left behind. Anything still lingering
// in the old channel is now someone else's problem.
const CHANNEL_NAME = "watch-party-signaling-v2";
const TAB_ID_KEY = "watch-party-tab-id";

// A stable id for this tab, surviving reloads. sessionStorage, not localStorage,
// and the distinction matters both ways: it must survive a refresh (so we can
// recognise our own previous load) but must NOT be shared between tabs (or two
// tabs on one machine would each mistake the other for itself and never pair).
function getTabId() {
  let id = sessionStorage.getItem(TAB_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(TAB_ID_KEY, id);
  }
  return id;
}

// Called once per tab, after the camera is ready. `onPeerOnline` fires whenever a
// new peering session starts — the partner appeared, or reloaded and needs a
// fresh connection. `onPeerLeft` fires when they go away. `onSignal` fires only
// for messages addressed to us, from our current partner, in the current session.
export function joinSignalingChannel({ onPeerOnline, onPeerLeft, onSignal }) {
  const tabId = getTabId();
  const joinedAt = Date.now();

  // The partner we're currently paired with, and the id of the peering session
  // we share with them. Both sides derive the same session id from the same two
  // presence entries, which is what lets us drop signals belonging to a session
  // that has already ended.
  let partner = null;
  let sessionId = null;

  const channel = supabase.channel(CHANNEL_NAME, {
    config: {
      // We don't want to receive our own broadcasts back.
      broadcast: { self: false },
      // Keyed on the stable tab id, NOT a per-load value. This is the core fix:
      // reloading now reuses the key, so Supabase replaces our entry instead of
      // appending another one. The old per-load key manufactured a fresh ghost
      // on every single refresh, which is where "5 entries for 2 people" came
      // from and why every downstream heuristic kept failing.
      presence: { key: tabId },
    },
  });

  channel
    .on("broadcast", { event: "signal" }, ({ payload }) => {
      // Supabase broadcast reaches every member of the channel, not just our
      // partner, so each message has to be checked three ways: is it for us, is
      // it from the peer we're paired with, and does it belong to the peering
      // session we're currently in. The third check is what stops a stale offer
      // from renegotiating a connection that is already up and working.
      if (payload.to !== tabId) return;
      if (!partner || payload.from !== partner.tabId) return;
      if (payload.session !== sessionId) {
        console.warn("ignoring signal from a finished session:", payload.type);
        return;
      }
      console.log("signal in  <-", payload.type);
      onSignal(payload);
    })
    .on("presence", { event: "sync" }, () => {
      const state = channel.presenceState();

      // Presence keeps *multiple metas per key*: a reload adds another meta under
      // the same key rather than replacing it, and the old one only disappears
      // once its socket is reaped (immediately, given the pagehide untrack below).
      // So the participant count is the number of KEYS -- flattening the metas
      // counts connections, not people. Collapse each key to its newest meta.
      const newestMeta = (metas) => metas.slice().sort((a, b) => b.joinedAt - a.joinedAt)[0];
      const others = Object.keys(state)
        .filter((key) => key !== tabId)
        .map((key) => newestMeta(state[key]))
        .filter(Boolean);
      const next = others.sort((a, b) => b.joinedAt - a.joinedAt)[0] ?? null;

      // `participants` is the number to watch: with the identity model correct it
      // sits at 2 no matter how many times either side reloads. If it climbs,
      // something is manufacturing ghosts again. `metas` above it is only ever
      // interesting when a socket hasn't been reaped yet.
      console.log("presence sync:", {
        participants: Object.keys(state).length,
        metas: Object.values(state).flat().length,
        partner: next?.tabId ?? null,
      });

      if (!next) {
        if (partner) {
          partner = null;
          sessionId = null;
          onPeerLeft();
        }
        return;
      }

      // Same partner, same page load — nothing has changed.
      if (partner && partner.tabId === next.tabId && partner.joinedAt === next.joinedAt) {
        return;
      }

      // Either a new partner, or the same one after a reload (their joinedAt
      // moved). Both mean any existing connection is dead and a new peering
      // session begins.
      partner = { tabId: next.tabId, joinedAt: next.joinedAt };

      // Both sides compute this identically from the same two presence entries.
      sessionId = [tabId, partner.tabId].sort().join(":") + "@" + Math.max(joinedAt, partner.joinedAt);

      // Lower tab id offers. Deterministic, and stable across reloads -- the old
      // per-load id meant a refresh could silently flip which side offers.
      const isOfferer = tabId < partner.tabId;
      console.log(`new peering session — role: ${isOfferer ? "OFFERER" : "answerer"}`);
      onPeerOnline({ isOfferer, peerId: partner.tabId });
    })
    .subscribe(async (status) => {
      console.log("signaling channel:", status);
      if (status === "SUBSCRIBED") {
        await channel.track({ tabId, joinedAt });
      }
    });

  function sendSignal(payload) {
    if (!partner) {
      console.warn("no partner yet, dropping outgoing", payload.type);
      return;
    }
    console.log("signal out ->", payload.type);
    channel.send({
      type: "broadcast",
      event: "signal",
      payload: { ...payload, from: tabId, to: partner.tabId, session: sessionId },
    });
  }

  // Announce departure rather than letting the socket rot. Without this a closed
  // tab sits in presence for 30-60s until the server notices, and the partner
  // spends that whole time trying to negotiate with something that isn't there.
  // `pagehide` rather than `beforeunload` because iOS Safari/WebKit frequently
  // doesn't fire beforeunload at all -- and the phone is exactly the device most
  // likely to be backgrounded or closed abruptly.
  const handlePageHide = () => {
    channel.untrack();
    supabase.removeChannel(channel);
  };
  window.addEventListener("pagehide", handlePageHide);

  return {
    tabId,
    sendSignal,
    leave: () => {
      window.removeEventListener("pagehide", handlePageHide);
      supabase.removeChannel(channel);
    },
  };
}
