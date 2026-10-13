// The Cotune panel: room (PeerJS), playback sync, chat and video call.
//
// Room topology is a star: the host's peer id is the room code, guests
// connect to the host, and the host relays messages to everyone else.
// Calls are a mesh: everyone in the call connects directly to everyone else.

import { ICE_SERVERS, DRIFT_TOLERANCE_S, HEARTBEAT_MS } from "./config.js";

const params = new URLSearchParams(location.search);
const TAB_ID = Number(params.get("tab"));
const PAGE_URL = params.get("page") || "";
const JOIN_CODE = params.get("join");

// After any sync action, ignore the host heartbeat for a moment so an
// in-flight heartbeat can't undo the action.
const SYNC_SETTLE_MS = 3000;

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------- state ---

let myName = "";
let peer = null;
let isHost = false;
let hostConn = null; // guest -> host
const conns = new Map(); // host: peerId -> DataConnection
let roster = []; // [{ id, name, inCall }]

let video = null; // { time, playing, duration, at }
let pendingSync = null; // sync received before our video was found
let lastSyncAt = 0;

let localStream = null;
const calls = new Map(); // peerId -> MediaConnection
let micOn = true;
let camOn = true;

// ------------------------------------------------- bridge to the video ---

let bg = null;

function connectBackground() {
  bg = chrome.runtime.connect({ name: `panel:${TAB_ID}` });
  bg.onMessage.addListener(onVideoMessage);
  bg.onDisconnect.addListener(() => {
    bg = null;
    setTimeout(connectBackground, 500);
  });
}

function command(action, time) {
  bg?.postMessage({ type: "cmd", action, time });
}

function currentTime() {
  if (!video) return 0;
  return video.time + (video.playing ? (Date.now() - video.at) / 1000 : 0);
}

function onVideoMessage(msg) {
  if (msg.type !== "video") return;

  if (msg.event === "blocked") {
    system("Your browser blocked playback. Click play on the video once, then sync will work.");
    return;
  }

  video = { time: msg.time, playing: msg.playing, duration: msg.duration, at: Date.now() };
  renderVideoStatus();
  applySmartMic();

  if (pendingSync) {
    const s = pendingSync;
    pendingSync = null;
    command(s.playing ? "play" : "pause", s.time);
  }

  if (msg.user && ["play", "pause", "seeked"].includes(msg.event) && peer?.open) {
    lastSyncAt = Date.now();
    broadcast({ t: "sync", playing: msg.playing, time: msg.time, event: msg.event, name: myName });
    system(`You ${describe(msg.event, msg.playing)} at ${fmt(msg.time)}`);
  }
}

function applyRemote({ playing, time }) {
  if (!video) {
    pendingSync = { playing, time };
    return;
  }
  command(playing ? "play" : "pause", time);
}

// -------------------------------------------------------------- room ---

function randomCode() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(6))) s += chars[b % chars.length];
  return `cotune-${s}`;
}

function newPeer(id) {
  // global Peer comes from vendor/peerjs.min.js
  return id ? new Peer(id, { config: { iceServers: ICE_SERVERS } }) : new Peer({ config: { iceServers: ICE_SERVERS } });
}

function requireName() {
  myName = $("name").value.trim();
  if (!myName) {
    lobbyError("Enter your name first.");
    $("name").focus();
    return false;
  }
  chrome.storage.local.set({ name: myName });
  return true;
}

function startParty() {
  if (!requireName()) return;
  const code = randomCode();
  setLobbyBusy(true);
  peer = newPeer(code);
  peer.on("open", () => {
    isHost = true;
    roster = [{ id: peer.id, name: myName, inCall: false }];
    enterRoom();
    system("Party started. Share the link with your friends.");
    setInterval(heartbeat, HEARTBEAT_MS);
  });
  peer.on("connection", acceptGuest);
  peer.on("call", onIncomingCall);
  peer.on("error", onPeerError);
  peer.on("disconnected", () => peer.reconnect());
}

function joinParty(code) {
  if (!requireName()) return;
  code = code.trim().toLowerCase();
  if (!code) return lobbyError("Enter a room code.");
  setLobbyBusy(true);
  peer = newPeer();
  peer.on("open", () => {
    hostConn = peer.connect(code, { reliable: true, metadata: { name: myName } });
    hostConn.on("open", () => {
      enterRoom(code);
      system("Joined the party.");
    });
    hostConn.on("data", (msg) => handle(msg));
    hostConn.on("close", () => {
      system("The host left, so the party has ended.");
      leaveCall();
    });
  });
  peer.on("call", onIncomingCall);
  peer.on("error", onPeerError);
  peer.on("disconnected", () => peer.reconnect());
}

function onPeerError(err) {
  console.warn("Cotune peer error", err);
  if (err.type === "peer-unavailable" && !$("room").hidden) {
    // A call target left; the roster update will clean up.
    return;
  }
  const messages = {
    "peer-unavailable": "Room not found. Check the code; the host must still have the party open.",
    "unavailable-id": "That room code is taken. Try again.",
    network: "Can't reach the connection server. Check your internet.",
    "server-error": "The connection server had a problem. Try again in a minute.",
  };
  if ($("room").hidden) {
    lobbyError(messages[err.type] || `Connection error: ${err.type}`);
    peer?.destroy();
    peer = null;
    setLobbyBusy(false);
  } else {
    system(messages[err.type] || `Connection error: ${err.type}`);
  }
}

// Host only.
function acceptGuest(conn) {
  conn.on("open", () => {
    conns.set(conn.peer, conn);
    const name = String(conn.metadata?.name || "Guest").slice(0, 24);
    roster.push({ id: conn.peer, name, inCall: false });
    conn.send({
      t: "welcome",
      roster,
      page: PAGE_URL,
      state: video ? { playing: video.playing, time: currentTime() } : null,
    });
    broadcast({ t: "roster", roster }, conn.peer);
    renderPeople();
    system(`${name} joined.`);
  });
  conn.on("data", (msg) => {
    // Never trust a guest's claimed identity; stamp it from the connection.
    const from = roster.find((r) => r.id === conn.peer);
    if (!from) return;
    if (msg.t === "call") {
      from.inCall = !!msg.inCall;
      broadcast({ t: "roster", roster });
      renderPeople();
      return;
    }
    if (!["chat", "sync"].includes(msg.t)) return;
    msg.name = from.name;
    handle(msg);
    broadcast(msg, conn.peer);
  });
  conn.on("close", () => {
    conns.delete(conn.peer);
    const who = roster.find((r) => r.id === conn.peer);
    roster = roster.filter((r) => r.id !== conn.peer);
    broadcast({ t: "roster", roster });
    renderPeople();
    dropCall(conn.peer);
    if (who) system(`${who.name} left.`);
  });
}

function broadcast(msg, exceptId) {
  if (isHost) {
    for (const [id, conn] of conns) if (id !== exceptId && conn.open) conn.send(msg);
  } else if (hostConn?.open) {
    hostConn.send(msg);
  }
}

function heartbeat() {
  if (!video || conns.size === 0) return;
  broadcast({ t: "tick", playing: video.playing, time: currentTime() });
}

function handle(msg) {
  switch (msg.t) {
    case "welcome":
      roster = msg.roster;
      renderPeople();
      if (msg.state) applyRemote(msg.state);
      if (msg.page && msg.page !== PAGE_URL) {
        systemLink("The host is on a different page:", msg.page);
      }
      break;
    case "roster":
      roster = msg.roster;
      renderPeople();
      for (const id of calls.keys()) {
        if (!roster.some((r) => r.id === id && r.inCall)) dropCall(id);
      }
      break;
    case "chat":
      chatLine(msg.name, msg.text);
      break;
    case "sync":
      lastSyncAt = Date.now();
      applyRemote(msg);
      system(`${msg.name} ${describe(msg.event, msg.playing)} at ${fmt(msg.time)}`);
      break;
    case "tick": {
      if (Date.now() - lastSyncAt < SYNC_SETTLE_MS) break;
      if (!video) {
        pendingSync = { playing: msg.playing, time: msg.time };
        break;
      }
      const drift = Math.abs(currentTime() - msg.time);
      if (video.playing !== msg.playing || drift > DRIFT_TOLERANCE_S) {
        applyRemote(msg);
      }
      break;
    }
  }
}

// -------------------------------------------------------------- call ---

async function joinCall() {
  $("call-error").hidden = true;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: { width: 320, height: 240, frameRate: 15 },
    });
  } catch (err) {
    showCallError(err);
    return;
  }
  micOn = true;
  camOn = true;
  addTile("me", localStream, `${myName} (you)`, true);
  setInCall(true);
  for (const r of roster) {
    if (r.id !== peer.id && r.inCall) wireCall(peer.call(r.id, localStream));
  }
  renderCallControls();
  applySmartMic();
}

function leaveCall() {
  for (const id of [...calls.keys()]) dropCall(id);
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  removeTile("me");
  if (peer?.open) setInCall(false);
  renderCallControls();
}

function setInCall(inCall) {
  if (isHost) {
    const me = roster.find((r) => r.id === peer.id);
    if (me) me.inCall = inCall;
    broadcast({ t: "roster", roster });
    renderPeople();
  } else {
    hostConn?.open && hostConn.send({ t: "call", inCall });
  }
}

function onIncomingCall(call) {
  if (!localStream) {
    call.close();
    return;
  }
  call.answer(localStream);
  wireCall(call);
}

function wireCall(call) {
  const existing = calls.get(call.peer);
  if (existing && existing !== call) existing.close();
  calls.set(call.peer, call);
  call.on("stream", (stream) => addTile(call.peer, stream, nameOf(call.peer), false));
  const cleanup = () => {
    if (calls.get(call.peer) === call) {
      calls.delete(call.peer);
      removeTile(call.peer);
    }
  };
  call.on("close", cleanup);
  call.on("error", cleanup);
}

function dropCall(id) {
  const call = calls.get(id);
  calls.delete(id);
  call?.close();
  removeTile(id);
}

function showCallError(err) {
  const el = $("call-error");
  el.hidden = false;
  el.textContent = "";
  if (err.name === "NotAllowedError") {
    el.append("Camera/mic permission is needed. ");
    const btn = document.createElement("button");
    btn.textContent = "Grant permission";
    btn.addEventListener("click", () => window.open(chrome.runtime.getURL("permission.html")));
    el.append(btn);
  } else if (err.name === "NotFoundError") {
    el.textContent = "No camera or microphone found.";
  } else {
    el.textContent = `Couldn't start camera/mic: ${err.message || err.name}`;
  }
}

function toggleMic() {
  micOn = !micOn;
  applySmartMic();
  renderCallControls();
}

function toggleCam() {
  camOn = !camOn;
  localStream?.getVideoTracks().forEach((t) => (t.enabled = camOn));
  renderCallControls();
}

// "Smart mic": stay muted while the movie plays, talk when it's paused.
function applySmartMic() {
  if (!localStream) return;
  const smart = $("smart-mic").checked && video?.playing;
  localStream.getAudioTracks().forEach((t) => (t.enabled = micOn && !smart));
}

// ---------------------------------------------------------------- UI ---

function enterRoom(code = peer.id) {
  $("lobby").hidden = true;
  $("room").hidden = false;
  $("chat").hidden = false;
  $("invite").value = inviteLink(code);
  renderPeople();
}

function inviteLink(code) {
  try {
    const u = new URL(PAGE_URL);
    u.hash = (u.hash ? u.hash.slice(1) + "&" : "") + `cotune=${code}`;
    return u.href;
  } catch {
    return code;
  }
}

function renderPeople() {
  const list = $("people");
  list.textContent = "";
  for (const r of roster) {
    const li = document.createElement("li");
    li.textContent = (r.inCall ? "🎥 " : "") + r.name + (r.id === peer?.id ? " (you)" : "");
    list.append(li);
  }
}

function renderVideoStatus() {
  const el = $("video-status");
  if (!video) {
    el.textContent = "Looking for a video… press play on the movie.";
    return;
  }
  const total = video.duration ? ` / ${fmt(video.duration)}` : "";
  el.textContent = `Video found · ${fmt(video.time)}${total} · ${video.playing ? "playing" : "paused"}`;
}

function renderCallControls() {
  const inCall = !!localStream;
  $("call-join").hidden = inCall;
  $("mic").hidden = !inCall;
  $("cam").hidden = !inCall;
  $("call-leave").hidden = !inCall;
  $("smart-mic-row").hidden = !inCall;
  $("mic").textContent = micOn ? "Mute" : "Unmute";
  $("cam").textContent = camOn ? "Camera off" : "Camera on";
}

function addTile(id, stream, label, muted) {
  let tile = document.querySelector(`.tile[data-id="${CSS.escape(id)}"]`);
  if (!tile) {
    tile = document.createElement("div");
    tile.className = "tile";
    tile.dataset.id = id;
    tile.append(document.createElement("video"), document.createElement("span"));
    $("tiles").append(tile);
  }
  const v = tile.querySelector("video");
  v.autoplay = true;
  v.playsInline = true;
  v.muted = muted;
  v.srcObject = stream;
  tile.querySelector("span").textContent = label;
}

function removeTile(id) {
  document.querySelector(`.tile[data-id="${CSS.escape(id)}"]`)?.remove();
}

function nameOf(id) {
  return roster.find((r) => r.id === id)?.name || "Friend";
}

function chatLine(name, text) {
  const li = document.createElement("li");
  const b = document.createElement("b");
  b.textContent = name + ": ";
  li.append(b, String(text));
  appendMessage(li);
}

function system(text) {
  const li = document.createElement("li");
  li.className = "system";
  li.textContent = text;
  appendMessage(li);
}

function systemLink(text, href) {
  const li = document.createElement("li");
  li.className = "system";
  const a = document.createElement("a");
  a.href = href;
  a.target = "_top";
  a.textContent = "open it";
  li.append(text + " ", a);
  appendMessage(li);
}

function appendMessage(li) {
  const list = $("messages");
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.append(li);
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function lobbyError(text) {
  $("lobby-error").hidden = false;
  $("lobby-error").textContent = text;
}

function setLobbyBusy(busy) {
  $("start").disabled = busy;
  $("join").disabled = busy;
  if (busy) $("lobby-error").hidden = true;
}

function describe(event, playing) {
  if (event === "seeked") return "jumped";
  return playing ? "played" : "paused";
}

function fmt(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// ------------------------------------------------------------- wiring ---

$("hide").addEventListener("click", () => {
  chrome.tabs.sendMessage(TAB_ID, { type: "hide-panel" }, { frameId: 0 });
});
$("start").addEventListener("click", startParty);
$("join").addEventListener("click", () => joinParty($("code").value));
$("code").addEventListener("keydown", (e) => e.key === "Enter" && joinParty($("code").value));
$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("invite").value);
  $("copy").textContent = "Copied!";
  setTimeout(() => ($("copy").textContent = "Copy link"), 1500);
});
$("call-join").addEventListener("click", joinCall);
$("call-leave").addEventListener("click", leaveCall);
$("mic").addEventListener("click", toggleMic);
$("cam").addEventListener("click", toggleCam);
$("smart-mic").addEventListener("change", applySmartMic);
$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("chat-input").value.trim();
  if (!text) return;
  $("chat-input").value = "";
  chatLine(myName, text);
  broadcast({ t: "chat", text, name: myName });
});

window.addEventListener("beforeunload", () => {
  leaveCall();
  peer?.destroy();
});

connectBackground();

chrome.storage.local.get("name").then(({ name }) => {
  if (name) $("name").value = name;
  if (JOIN_CODE) {
    $("code").value = JOIN_CODE;
    if (name) joinParty(JOIN_CODE);
    else lobbyError("Enter your name, then press Join.");
  }
});
