// ICE = Interactive Connectivity Establishment, the process RTCPeerConnection
// uses to find a working network path between two browsers. It needs a list
// of STUN servers (discover your public address, used to try a direct
// connection) and TURN servers (relay media when a direct connection isn't
// possible). See the STUN/TURN explanation in the Session 2 conversation for why
// both are needed.
const turnServer = import.meta.env.VITE_TURN_SERVER;
const turnUsername = import.meta.env.VITE_TURN_USERNAME;
const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL;

if (!turnServer || !turnUsername || !turnCredential) {
  throw new Error(
    "Missing TURN env vars. Set VITE_TURN_SERVER, VITE_TURN_USERNAME, and " +
      "VITE_TURN_CREDENTIAL in .env.local (see .env.example)."
  );
}

export const iceServers = [
  // Public STUN, no auth needed — just for discovering our public address.
  { urls: "stun:stun.l.google.com:19302" },

  // ExpressTURN also serves STUN on the same host.
  { urls: `stun:${turnServer}` },

  // TURN relay, both UDP and TCP variants — offering both lets the browser
  // fall back to TCP if UDP is blocked outright by a restrictive firewall.
  {
    urls: [`turn:${turnServer}?transport=udp`, `turn:${turnServer}?transport=tcp`],
    username: turnUsername,
    credential: turnCredential,
  },
];
