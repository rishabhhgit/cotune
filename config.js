// Your Cotune server (the Cloudflare Worker in ../server). After deploying,
// put its address here, with wss:// instead of https://.
export const SERVER_URL = "wss://cotune.cotune-server.workers.dev";

// If two players are more than this many seconds apart, the others jump to the leader.
export const DRIFT_TOLERANCE_S = 2;

// How often the leader broadcasts its playback position.
export const HEARTBEAT_MS = 4000;
