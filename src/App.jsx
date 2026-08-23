import { useEffect, useRef, useState } from "react";
import { iceServers } from "./lib/iceServers";
import { joinSignalingChannel } from "./lib/signaling";
import "./App.css";

function App() {
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const [status, setStatus] = useState("requesting camera...");

  useEffect(() => {
    let pc;
    let signaling;
    let cancelled = false;

    // ICE candidates can arrive over signaling before setRemoteDescription
    // has run (they're discovered/sent in parallel with the offer/answer
    // exchange, not after it) -- addIceCandidate throws if called too early,
    // so we hold onto them here until the remote description is set.
    let remoteDescriptionSet = false;
    const queuedCandidates = [];

    async function start() {
      const localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      if (cancelled) {
        localStream.getTracks().forEach((track) => track.stop());
        return;
      }
      localVideoRef.current.srcObject = localStream;
      setStatus("waiting for partner...");

      pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: "relay" }); // TEMP: TURN-only test
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

      pc.ontrack = (event) => {
        remoteVideoRef.current.srcObject = event.streams[0];
        setStatus("connected");
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log("local candidate type:", event.candidate.type, event.candidate.protocol); // TEMP debug
          signaling.sendSignal({ type: "ice-candidate", candidate: event.candidate });
        } else {
          console.log("candidate gathering complete"); // TEMP debug
        }
      };

      pc.onconnectionstatechange = () => {
        console.log("connectionState:", pc.connectionState); // TEMP debug
        if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
          setStatus("disconnected");
        }
      };
      pc.oniceconnectionstatechange = () => {
        console.log("iceConnectionState:", pc.iceConnectionState); // TEMP debug
      };
      pc.onicecandidateerror = (e) => {
        console.log("icecandidateerror:", e.errorCode, e.errorText, e.url); // TEMP debug
      };
      pc.onicegatheringstatechange = () => {
        console.log("iceGatheringState:", pc.iceGatheringState); // TEMP debug
      };

      async function applyRemoteDescription(description) {
        await pc.setRemoteDescription(description);
        remoteDescriptionSet = true;
        for (const candidate of queuedCandidates.splice(0)) {
          await pc.addIceCandidate(candidate);
        }
      }

      signaling = joinSignalingChannel({
        onPeerOnline: async ({ isOfferer }) => {
          setStatus("connecting...");
          if (isOfferer) {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            signaling.sendSignal({ type: "offer", description: offer });
          }
        },
        onSignal: async (payload) => {
          if (payload.type === "offer") {
            await applyRemoteDescription(payload.description);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            signaling.sendSignal({ type: "answer", description: answer });
          } else if (payload.type === "answer") {
            await applyRemoteDescription(payload.description);
          } else if (payload.type === "ice-candidate") {
            if (remoteDescriptionSet) {
              await pc.addIceCandidate(payload.candidate);
            } else {
              queuedCandidates.push(payload.candidate);
            }
          }
        },
      });
    }

    start().catch((err) => setStatus(`error: ${err.message}`));

    return () => {
      cancelled = true;
      signaling?.leave();
      pc?.close();
      const stream = localVideoRef.current?.srcObject;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return (
    <div className="app">
      <h1>Watch Party App</h1>
      <p className="status">{status}</p>
      <div className="videos">
        <video ref={localVideoRef} autoPlay playsInline muted className="local" />
        <video ref={remoteVideoRef} autoPlay playsInline className="remote" />
      </div>
    </div>
  );
}

export default App;
