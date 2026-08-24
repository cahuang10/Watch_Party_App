import { supabase } from "./supabaseClient";

// Both tabs join this same fixed channel name, so they find each other.
// No auth yet (that's a V2 item), so this is intentionally not scoped to a
// specific pair of users — anyone who loads the deployed app right now joins
// the same signaling channel.
const CHANNEL_NAME = "watch-party-signaling";

// Called once per tab, before the peer connection is set up. `onPeerOnline`
// fires when the *other* tab's presence is detected (not our own) -- that's the
// "safe to start signaling" and "who's the offerer" signal. `onSignal` fires for
// every offer/answer/ice-candidate broadcast from the other tab. Returns
// { clientId, sendSignal, leave } — clientId is this tab's random id, which the
// caller needs for the offer tie-break.
export function joinSignalingChannel({ onPeerOnline, onSignal }) {
  const clientId = crypto.randomUUID();
  let announcedPeer = false;

  const channel = supabase.channel(CHANNEL_NAME, {
    config: {
      // We don't want to receive our own broadcasts back.
      broadcast: { self: false },
      presence: { key: clientId },
    },
  });

  channel
    .on("broadcast", { event: "signal" }, ({ payload }) => {
      console.log("signal in  <-", payload.type);
      onSignal(payload);
    })
    .on("presence", { event: "sync" }, () => {
      const state = channel.presenceState();
      const allIds = Object.keys(state);
      const otherIds = allIds.filter((id) => id !== clientId);

      // Worth logging loudly: every page load mints a new clientId and a new
      // presence entry, and entries linger until the socket actually times out
      // (30s+, and longer on a phone that backgrounded or changed networks). So
      // a "peer" here may be a ghost of an earlier reload rather than the live
      // partner, and that is enough to break the offerer election below.
      console.log("presence sync:", { me: clientId, all: allIds, others: otherIds });

      if (otherIds.length === 0) {
        // Peer left. Re-arm so they get a fresh handshake if they come back,
        // instead of the connection being permanently one-shot.
        announcedPeer = false;
        return;
      }
      if (announcedPeer) return;
      announcedPeer = true;

      // Lowest id in the whole channel is the offerer -- arbitrary but
      // deterministic, and both sides compute it identically without having to
      // negotiate. Compared against *every* id rather than one arbitrary array
      // slot, so an extra entry can't flip one side's answer without flipping
      // the other's. A stale ghost holding the lowest id can still leave both
      // real peers as answerers; App.jsx's need-offer nudge is the safety net.
      const isOfferer = allIds.slice().sort()[0] === clientId;
      console.log(`role: ${isOfferer ? "OFFERER" : "answerer"}`);
      onPeerOnline({ isOfferer });
    })
    .subscribe(async (status) => {
      console.log("signaling channel:", status);
      if (status === "SUBSCRIBED") {
        await channel.track({ clientId });
      }
    });

  function sendSignal(payload) {
    console.log("signal out ->", payload.type);
    channel.send({ type: "broadcast", event: "signal", payload });
  }

  return { clientId, sendSignal, leave: () => supabase.removeChannel(channel) };
}
