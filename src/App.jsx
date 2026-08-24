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
    let localStream;
    let cancelled = false;

    // ICE candidates can arrive over signaling before setRemoteDescription
    // has run (they're discovered/sent in parallel with the offer/answer
    // exchange, not after it) -- addIceCandidate throws if called too early,
    // so we hold onto them here until the remote description is set.
    let remoteDescriptionSet = false;
    const queuedCandidates = [];

    async function start() {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      if (cancelled) {
        localStream.getTracks().forEach((track) => track.stop());
        return;
      }
      localVideoRef.current.srcObject = localStream;
      setStatus("waiting for partner...");

      // TURN-only test mode. Load the page with ?relay=1 to throw away every
      // direct candidate (host/srflx) so media *must* go through the TURN relay.
      // TURN normally only kicks in when a direct connection fails, which means a
      // broken relay config looks perfectly fine until the day it matters -- this
      // flag makes verifying it a one-second thing to repeat, rather than a line
      // that gets commented in and out.
      const forceRelay = new URLSearchParams(window.location.search).get("relay") === "1";

      pc = new RTCPeerConnection({
        iceServers,
        ...(forceRelay ? { iceTransportPolicy: "relay" } : {}),
      });
      console.log(forceRelay ? "ICE mode: relay-only (TURN forced)" : "ICE mode: all transports");

      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

      pc.ontrack = (event) => {
        remoteVideoRef.current.srcObject = event.streams[0];
        setStatus("connected");
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          // For a `relay` candidate, `address` is the address the TURN server
          // allocated for us. Logging it matters because most free TURN tiers only
          // relay between their own clients -- if the two peers end up allocated on
          // different servers (our host resolves to more than one IP), every
          // relay-to-relay pair fails while everything else looks healthy.
          console.log("local  candidate:", event.candidate.type, event.candidate.protocol, event.candidate.address);
          signaling.sendSignal({ type: "ice-candidate", candidate: event.candidate });
        }
      };

      pc.onconnectionstatechange = () => {
        console.log("connectionState:", pc.connectionState);
        if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
          setStatus("disconnected");
        }
      };
      pc.oniceconnectionstatechange = () => {
        console.log("iceConnectionState:", pc.iceConnectionState);
      };
      // Fires when a STUN/TURN server rejects us. 401 = bad credentials,
      // 486 = allocation quota reached, 701 = server unreachable.
      pc.onicecandidateerror = (e) => {
        console.warn("icecandidateerror:", e.errorCode, e.errorText, e.url);
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
            // Logged alongside the local candidates above so one console shows both
            // ends: if both sides are `relay` but the addresses belong to different
            // TURN servers, that mismatch is the connection failure.
            console.log(
              "remote candidate:",
              payload.candidate?.type,
              payload.candidate?.protocol,
              payload.candidate?.address
            );
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
      // Stop the tracks via the variable, not via localVideoRef.current -- the
      // ref may already be detached by the time cleanup runs, which would leave
      // the camera light on.
      localStream?.getTracks().forEach((track) => track.stop());
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
