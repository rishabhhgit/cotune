// Servers WebRTC uses to connect browsers for calls and for the room itself.
//
// STUN (Google) handles most home Wi-Fi via NAT hole-punching.
// TURN is a relay used when hole-punching fails (mobile data / CGNAT / strict
// networks). The openrelayproject entries below are Metered's free public TURN
// (no signup, but low bandwidth limit — fine for control messages, tight for
// video calls). For production, replace with your own credentials from
// https://www.metered.ca (free tier: 500 MB/month):
//   { urls: "turn:global.relay.metered.ca:80", username: "...", credential: "..." },
//   { urls: "turn:global.relay.metered.ca:443?transport=tcp", username: "...", credential: "..." },
export const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

// If two players are more than this many seconds apart, the guest jumps to the host.
export const DRIFT_TOLERANCE_S = 2;

// How often the host broadcasts its playback position.
export const HEARTBEAT_MS = 4000;
