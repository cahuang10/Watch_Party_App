// The four-slot model that lets screen share avoid renegotiation entirely.
//
// Session 3 reserved one transceiver slot per kind (audio, video) at connection
// time, so turning the camera on/off later is just `replaceTrack` into an
// existing slot -- no new offer/answer round. Screen share is "more of the same
// idea, one step earlier": reserve TWO more slots up front (screen audio, screen
// video) so starting a share is *also* just a replaceTrack.
//
// This only works if both sides agree on which m-line is which, in order, every
// time. SLOT_ORDER is that agreement -- the single source of truth for what the
// offerer's addTransceiver calls create and what the answerer's resolveSlots()
// reads back.
//
// Verified against a real Chrome before this was built (see the loopback test
// in loopbackTest.js): a 4-section offer negotiates cleanly, both sides land on
// 4 transceivers all `sendrecv`, and replaceTrack-ing a screen track into its
// reserved slot fires `negotiationneeded` zero times on both peers.
export const SLOT_ORDER = [
  { role: "mic", kind: "audio" },
  { role: "camera", kind: "video" },
  { role: "screenAudio", kind: "audio" },
  { role: "screenVideo", kind: "video" },
];

// Maps a connection's transceivers back to roles, BY INDEX -- the order the
// offerer created them in, which is also the m-line order in the SDP both sides
// negotiated. Called from two places in useWatchPartyCall.js: once by the
// answerer, between setRemoteDescription(offer) and createAnswer() --
// setRemoteDescription is what builds these transceivers from the offer's
// m-lines in the first place (CLAUDE.md: "only addTrack transceivers get
// associated with an incoming offer" -- these come from the offer itself,
// which is the case that DOES adopt) -- and repeatedly from `ontrack`
// (wireRemoteStreams), on both roles, to route each incoming track into the
// right remote stream.
//
// Deliberately returns whatever it can resolve rather than throwing on a
// mismatch. Throwing here is not a cosmetic failure: this runs inside
// attachLocalMediaToAnswer(), *before* createAnswer(), so a thrown error means
// no answer is ever sent and the offerer sits at `have-local-offer` forever
// with no error on its own side (SESSION_3_POSTMORTEM 3.4). An unrecognised
// section is logged loudly and skipped instead -- exactly the same posture the
// stopped-transceiver check next to this already takes.
export function resolveSlots(transceivers) {
  const slots = {};
  const problems = [];

  transceivers.forEach((transceiver, index) => {
    // A rejected or stopped m-line must not be touched -- both `replaceTrack`
    // and setting `.direction` on one throw InvalidStateError, and that throw
    // is the fatal kind described above.
    if (transceiver.direction === "stopped" || transceiver.currentDirection === "stopped") {
      problems.push(`index ${index}: stopped, skipping`);
      return;
    }

    const expected = SLOT_ORDER[index];
    if (!expected) {
      problems.push(`index ${index}: no slot defined for this section (offer carried more m-lines than expected)`);
      return;
    }

    const actualKind = transceiver.receiver.track.kind;
    if (actualKind !== expected.kind) {
      problems.push(
        `index ${index}: expected ${expected.role} (${expected.kind}), SDP section is ${actualKind} -- offer/slot order mismatch`
      );
      return;
    }

    slots[expected.role] = transceiver;
  });

  if (problems.length > 0) {
    console.warn("resolveSlots: unexpected transceiver layout —", problems.join("; "));
  }

  return slots;
}
