// The technique from SESSION_3_POSTMORTEM.md Part 5, promoted from a markdown
// code block to a real file so it imports the actual SLOT_ORDER / resolveSlots
// and can't quietly drift out of sync with the app it's testing.
//
// The idea: build two RTCPeerConnections in one tab, wire their ICE candidates
// straight to each other (no signaling server needed), and run a full
// offer/answer with fake media. No camera, no permission prompt, no second
// device, no network. This is the fast, decisive way to catch the one-way-video
// class of bug -- SESSION_3_POSTMORTEM 3.3 was found this way in minutes after
// eyeballing got nowhere.
//
// The rule it's built around: assert on transceiver COUNT, every `mid`, and
// every `currentDirection`. Never assert on whether video "looks right" --
// a broken connection and a working one can look identical to the eye.
import { SLOT_ORDER, resolveSlots } from "./mediaSlots";

function fakeVideoTrack() {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  canvas.getContext("2d").fillRect(0, 0, 320, 180);
  return canvas.captureStream(5).getVideoTracks()[0];
}

function fakeAudioTrack() {
  const audioContext = new AudioContext();
  const oscillator = audioContext.createOscillator();
  const destination = audioContext.createMediaStreamDestination();
  oscillator.connect(destination);
  oscillator.start();
  return destination.stream.getAudioTracks()[0];
}

function transceiverTable(pc) {
  return pc.getTransceivers().map((t) => ({
    mid: t.mid,
    kind: t.receiver.track.kind,
    currentDirection: t.currentDirection,
    sending: Boolean(t.sender.track),
  }));
}

function healthy(pc) {
  const transceivers = pc.getTransceivers();
  return (
    transceivers.length === SLOT_ORDER.length &&
    transceivers.every((t) => t.mid !== null) &&
    transceivers.every((t) => t.currentDirection === "sendrecv")
  );
}

// Runs the full test and returns a report. Logs a human-readable summary as it
// goes, and console.table's the transceiver layout for both peers so a failure
// is diagnosable straight from the console, not just "pass"/"fail".
export async function runLoopbackTest() {
  const offererConnection = new RTCPeerConnection();
  const answererConnection = new RTCPeerConnection();
  offererConnection.onicecandidate = (e) => e.candidate && answererConnection.addIceCandidate(e.candidate);
  answererConnection.onicecandidate = (e) => e.candidate && offererConnection.addIceCandidate(e.candidate);

  let negotiationsAfterConnect = 0;
  // Counted separately from "before connect" negotiationneeded firings --
  // those are expected (every addTransceiver can fire one before the first
  // offer is even sent). What must stay at zero is negotiationneeded firing
  // AFTER the slots are reserved, i.e. while a share is starting.
  let countNegotiations = false;
  offererConnection.onnegotiationneeded = () => {
    if (countNegotiations) negotiationsAfterConnect += 1;
  };

  // --- offerer: reserve all four slots up front, exactly like createPeerConnection() ---
  const localAudio = fakeAudioTrack();
  const localVideo = fakeVideoTrack();
  const offererStream = new MediaStream([localAudio, localVideo]);
  const offererTransceivers = SLOT_ORDER.map(({ role, kind }) => {
    const track = role === "mic" ? localAudio : role === "camera" ? localVideo : null;
    return offererConnection.addTransceiver(track ?? kind, {
      direction: "sendrecv",
      streams: [offererStream],
    });
  });
  const offererSlots = resolveSlots(offererTransceivers);

  const offer = await offererConnection.createOffer();
  await offererConnection.setLocalDescription(offer);
  const offerSections = (offer.sdp.match(/^m=.*/gm) || []).length;

  // --- answerer: pre-create nothing, fill in what the offer created ---
  await answererConnection.setRemoteDescription(offererConnection.localDescription);
  const answererSlots = resolveSlots(answererConnection.getTransceivers());
  const remoteAudio = fakeAudioTrack();
  const remoteVideo = fakeVideoTrack();
  if (answererSlots.mic) await answererSlots.mic.sender.replaceTrack(remoteAudio);
  if (answererSlots.camera) await answererSlots.camera.sender.replaceTrack(remoteVideo);
  answererConnection.getTransceivers().forEach((t) => {
    if (t.direction !== "stopped") t.direction = "sendrecv";
  });

  const answer = await answererConnection.createAnswer();
  await answererConnection.setLocalDescription(answer);
  await offererConnection.setRemoteDescription(answererConnection.localDescription);

  const connectDeadline = Date.now() + 5000;
  while (offererConnection.connectionState !== "connected" && Date.now() < connectDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const beforeShare = {
    offerer: transceiverTable(offererConnection),
    answerer: transceiverTable(answererConnection),
    offererHealthy: healthy(offererConnection),
    answererHealthy: healthy(answererConnection),
  };

  // --- the actual thing being tested: starting a share must not renegotiate ---
  countNegotiations = true;
  const screenVideo = fakeVideoTrack();
  const screenAudio = fakeAudioTrack();
  await offererSlots.screenVideo.sender.replaceTrack(screenVideo);
  await offererSlots.screenAudio.sender.replaceTrack(screenAudio);
  // Give any negotiationneeded event a moment to fire before checking the count.
  await new Promise((resolve) => setTimeout(resolve, 200));

  const afterShare = {
    offerer: transceiverTable(offererConnection),
    answerer: transceiverTable(answererConnection),
    signalingStates: [offererConnection.signalingState, answererConnection.signalingState],
  };

  const report = {
    offerSections,
    connectionState: offererConnection.connectionState,
    beforeShare,
    afterShare,
    negotiationsDuringShare: negotiationsAfterConnect,
    pass:
      offerSections === SLOT_ORDER.length &&
      beforeShare.offererHealthy &&
      beforeShare.answererHealthy &&
      negotiationsAfterConnect === 0 &&
      afterShare.signalingStates.every((s) => s === "stable"),
  };

  console.log(report.pass ? "%cloopback test: PASS" : "%cloopback test: FAIL", `color: ${report.pass ? "green" : "red"}; font-weight: bold`);
  console.table(beforeShare.offerer);
  console.table(beforeShare.answerer);
  console.log("negotiationneeded fired during share start:", negotiationsAfterConnect, "(want 0)");
  console.log("signalingState after share start:", afterShare.signalingStates, "(want both 'stable')");

  offererConnection.close();
  answererConnection.close();

  return report;
}
