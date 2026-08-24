import { supabase } from "./supabaseClient";

// Both tabs join this same fixed channel name, so they find each other.
// No auth yet (that's a V2 item), so this is intentionally not scoped to a
// specific pair of users — anyone who loads the deployed app right now joins
// the same signaling channel.
const CHANNEL_NAME = "watch-party-signaling";
const TAB_ID_KEY = "watch-party-tab-id";

// A stable id for this *tab*, kept across reloads. The per-load `clientId` below
// changes every time the page loads, which means our own earlier loads linger in
// presence looking like a stranger -- presence entries survive until the socket
// actually times out (30s+, longer on a phone that backgrounded or changed
// networks), so we need some way to recognise our own ghosts.
//
// sessionStorage, not localStorage, and the distinction matters: sessionStorage
// survives a reload but is scoped to one tab. localStorage would be shared by
// every tab in the browser, so two tabs on the same machine would each filter the
// other out as "my own ghost" and never connect -- which is exactly how this gets
// tested locally.
function getTabId() {
  let id = sessionStorage.getItem(TAB_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(TAB_ID_KEY, id);
  }
  return id;
}

// Called once per tab, after the camera is ready. `onPeerOnline` fires whenever
// we start a *new peering session* — either the partner just appeared, or they
// reloaded and came back as a different peer. `onPeerLeft` fires when they go
// away. `onSignal` fires for every offer/answer/ice-candidate from the current
// partner. Returns { clientId, sendSignal, leave }.
export function joinSignalingChannel({ onPeerOnline, onPeerLeft, onSignal }) {
  const clientId = crypto.randomUUID();
  const tabId = getTabId();
  const joinedAt = Date.now();

  // clientId of the peer we're currently negotiating with. Doubles as the way we
  // notice our partner was replaced: same person, new page load, new clientId.
  let partnerClientId = null;

  const channel = supabase.channel(CHANNEL_NAME, {
    config: {
      // We don't want to receive our own broadcasts back.
      broadcast: { self: false },
      presence: { key: clientId },
    },
  });

  channel
    .on("broadcast", { event: "signal" }, ({ payload }) => {
      // A ghost's late broadcast must not be able to disturb a live negotiation.
      // If we haven't identified a partner yet we accept anyway -- dropping a
      // valid early offer would be worse than processing a stray one.
      if (partnerClientId && payload.from && payload.from !== partnerClientId) {
        console.warn("ignoring signal from non-partner:", payload.type);
        return;
      }
      console.log("signal in  <-", payload.type);
      onSignal(payload);
    })
    .on("presence", { event: "sync" }, () => {
      const entries = Object.values(channel.presenceState()).flat();

      // Drop ghosts of our own earlier page loads -- same tab, different
      // clientId. These used to be indistinguishable from a real partner, which
      // is what deadlocked the offerer election.
      const others = entries.filter((entry) => entry.tabId !== tabId);

      // Whatever is left, the newest entry is the live partner; anything older is
      // a ghost of a previous load on their side.
      const partner = others.sort((a, b) => b.joinedAt - a.joinedAt)[0];

      console.log("presence sync:", {
        entries: entries.length,
        others: others.length,
        partner: partner?.clientId ?? null,
      });

      if (!partner) {
        if (partnerClientId) {
          partnerClientId = null;
          onPeerLeft();
        }
        return;
      }

      // Same peer we're already talking to — nothing to do.
      if (partner.clientId === partnerClientId) return;

      // Either our first partner, or they reloaded and are now a different peer.
      // Either way this is a brand new peering session.
      partnerClientId = partner.clientId;

      // Lower id offers -- arbitrary but deterministic, and both sides compute it
      // identically without having to negotiate. Compared against the identified
      // partner rather than a sorted list a ghost could sit at the front of.
      const isOfferer = clientId < partner.clientId;
      console.log(`new peering session — role: ${isOfferer ? "OFFERER" : "answerer"}`);
      onPeerOnline({ isOfferer, peerId: partner.clientId });
    })
    .subscribe(async (status) => {
      console.log("signaling channel:", status);
      if (status === "SUBSCRIBED") {
        await channel.track({ clientId, tabId, joinedAt });
      }
    });

  // Every signal carries who sent it, so the receiver can filter out ghosts.
  function sendSignal(payload) {
    console.log("signal out ->", payload.type);
    channel.send({
      type: "broadcast",
      event: "signal",
      payload: { ...payload, from: clientId },
    });
  }

  return { clientId, sendSignal, leave: () => supabase.removeChannel(channel) };
}
