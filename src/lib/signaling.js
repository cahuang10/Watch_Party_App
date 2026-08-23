import { supabase } from "./supabaseClient";

// Both tabs join this same fixed channel name, so they find each other.
// No auth yet (that's a V2 item), so this is intentionally not scoped to a
// specific pair of users — anyone who loads the deployed app right now joins
// the same signaling channel.
const CHANNEL_NAME = "watch-party-signaling";

// Called once per tab, before the peer connection is set up. `onPeerOnline`
// fires once when the *other* tab's presence is detected (not our own) --
// that's the "safe to start signaling" and "who's the offerer" signal.
// `onSignal` fires for every offer/answer/ice-candidate broadcast from the
// other tab. Returns { clientId, channel } — clientId is this tab's random
// id (used for the offerer tie-break), channel is the raw Supabase channel
// in case callers need to send on it directly.
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
      onSignal(payload);
    })
    .on("presence", { event: "sync" }, () => {
      const state = channel.presenceState();
      const otherIds = Object.keys(state).filter((id) => id !== clientId);

      if (otherIds.length > 0 && !announcedPeer) {
        announcedPeer = true;
        // Lower id acts as the offerer -- arbitrary but deterministic, and
        // both tabs compute it the same way so they agree without talking.
        const isOfferer = clientId < otherIds[0];
        onPeerOnline({ isOfferer });
      }
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({ clientId });
      }
    });

  function sendSignal(payload) {
    channel.send({ type: "broadcast", event: "signal", payload });
  }

  return { clientId, sendSignal, leave: () => supabase.removeChannel(channel) };
}
