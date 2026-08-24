import { useEffect, useRef, useState } from "react";
import { iceServers } from "./lib/iceServers";
import { joinSignalingChannel } from "./lib/signaling";
import "./App.css";

// If we believe we're the answerer but no offer shows up in this long, assume the
// offerer election picked wrong (a stale presence entry is the usual cause) and
// ask for one explicitly rather than waiting forever.
const OFFER_TIMEOUT_MS = 3000;

function App() {
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const [status, setStatus] = useState("requesting camera...");

  useEffect(() => {
    let pc;
    let signaling;
    let localStream;
    let cancelled = false;

    // Handshake bookkeeping. `offerSent` keeps us from ever sending a second
    // offer mid-negotiation (that would put the connection in an invalid state);
    // `nudgeSent` records that we asked the peer for an offer, which matters for
    // the tie-break below if we both asked at the same time.
    let offerSent = false;
    let nudgeSent = false;
    let offerTimer;

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

      async function createAndSendOffer(reason) {
        if (offerSent) return;
        offerSent = true;
        console.log("creating offer:", reason);
        setStatus("offerer · creating offer");
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        signaling.sendSignal({ type: "offer", description: offer });
        setStatus("offerer · offer sent");
      }

      signaling = joinSignalingChannel({
        onPeerOnline: async ({ isOfferer }) => {
          // Both of these callbacks are invoked by the channel and are not
          // awaited by start(), so start().catch() does not cover them. Without
          // these try/catch blocks a failure here becomes an unhandled rejection
          // and the UI just sits on its last status forever with no clue why.
          try {
            if (isOfferer) {
              await createAndSendOffer("elected offerer");
              return;
            }

            setStatus("answerer · waiting for offer");

            // Safety net: if the election deferred to a stale presence entry then
            // nobody is actually going to offer, and both peers wait forever.
            // After a beat, ask out loud.
            offerTimer = setTimeout(() => {
              if (remoteDescriptionSet) return;
              nudgeSent = true;
              console.warn("no offer after 3s — asking peer to send one");
              setStatus("answerer · no offer yet, nudging peer");
              signaling.sendSignal({ type: "need-offer", from: signaling.clientId });
            }, OFFER_TIMEOUT_MS);
          } catch (err) {
            console.error("handshake failed:", err);
            setStatus(`error: ${err.message}`);
          }
        },
        onSignal: async (payload) => {
          try {
            if (payload.type === "offer") {
              clearTimeout(offerTimer);
              setStatus("answerer · offer received");
              await applyRemoteDescription(payload.description);
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              signaling.sendSignal({ type: "answer", description: answer });
              setStatus("answerer · answer sent");
            } else if (payload.type === "answer") {
              await applyRemoteDescription(payload.description);
              setStatus("offerer · answer received");
            } else if (payload.type === "need-offer") {
              if (offerSent && pc.localDescription) {
                // We already offered, so the broadcast itself must have been
                // dropped -- Supabase broadcast is fire-and-forget with no retry.
                // Re-send the description we already have; creating a second,
                // different offer here would invalidate the first one.
                console.log("re-sending existing offer (peer never got it)");
                signaling.sendSignal({ type: "offer", description: pc.localDescription });
                return;
              }
              // Otherwise the peer gave up waiting. If we nudged too, then we
              // both think we're the answerer -- tie-break on id so exactly one
              // of us takes the offerer role, instead of both offering at once.
              if (nudgeSent && signaling.clientId > payload.from) return;
              await createAndSendOffer("peer asked for one");
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
          } catch (err) {
            console.error("signal handling failed:", payload.type, err);
            setStatus(`error: ${err.message}`);
          }
        },
      });
    }

    start().catch((err) => setStatus(`error: ${err.message}`));

    return () => {
      cancelled = true;
      clearTimeout(offerTimer);
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
