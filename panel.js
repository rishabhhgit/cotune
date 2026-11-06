// The Cotune panel: room, playback sync, chat and video call.
//
// The room is a WebSocket to the Cotune server (a Cloudflare Durable Object),
// which relays sync + chat, so it works on any network. Calls are a WebRTC
// mesh (everyone connects to everyone); the server relays the call setup
// messages and hands out TURN relay credentials for networks that block
// direct connections.

import { SERVER_URL, DRIFT_TOLERANCE_S, HEARTBEAT_MS } from "./config.js";

const params = new URLSearchParams(location.search);
const TAB_ID = Number(params.get("tab"));
const PAGE_URL = params.get("page") || "";
const JOIN_CODE = params.get("join");

// After any sync action, ignore the leader's heartbeat for a moment so an
// in-flight heartbeat can't undo the action.
const SYNC_SETTLE_MS = 3000;
const PING_MS = 30000;
const MAX_RECONNECT_DELAY_MS = 10000;

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------- state ---

let myName = "";
let roomCode = null;
let ws = null;
let myId = null;
let leaderId = null;
let roster = []; // [{ id, name, inCall }]
let rtcConfig = { iceServers: [] };
let reconnectDelay = 1000;
let everConnected = false;
let forceRelay = false; // testing: calls only through the TURN relay

let video = null; // { time, playing, duration, at }
let pendingSync = null; // sync received before our video was found
let lastSyncAt = 0;

let localStream = null;
const peers = new Map(); // memberId -> { pc, pendingCandidates }
let micOn = true;
let camOn = true;
let joiningCall = false;
let screenStream = null; // our screen share, while we are sharing
let wantCall = false; // the call was running before the page changed: rejoin it
let resumeState = null; // { micOn, camOn } from before the page changed

// Screen share always uses full HD 60fps high quality preset by default
const SCREEN_CONFIG = { fps: 60, w: 1920, h: 1080, bitrate: 6_000_000, hint: "detail" };
let statsBusy = false;
let expandedId = null; // tile shown in the full-page viewer
let expandedAt = 0;

// ----------------------------------------------------- tab session ---
// A party sticks to its tab. The panel saves where it is (room, in call,
// mic/camera) so that when the tab opens another page, the new panel joins
// the same room again by itself.

const SESSION_KEY = `session:${TAB_ID}`;
const OPEN_KEY = `open:${TAB_ID}`;

function saveSession() {
  if (!roomCode || !Number.isFinite(TAB_ID)) return;
  chrome.storage.session
    ?.set({ [SESSION_KEY]: { room: roomCode, inCall: !!localStream || wantCall, micOn, camOn } })
    .catch(() => {});
}

function clearSession() {
  chrome.storage.session?.remove([SESSION_KEY, OPEN_KEY]).catch(() => {});
}

async function readSession() {
  if (!Number.isFinite(TAB_ID)) return null;
  try {
    return (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY] || null;
  } catch {
    return null;
  }
}

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

  if (msg.user && ["play", "pause", "seeked"].includes(msg.event) && myId) {
    lastSyncAt = Date.now();
    send({ t: "sync", playing: msg.playing, time: msg.time, event: msg.event });
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
  for (const b of crypto.getRandomValues(new Uint8Array(8))) s += chars[b % chars.length];
  return `cotune-${s}`;
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
  joinRoom(randomCode());
}

function joinParty(code) {
  if (!requireName()) return;
  code = code.trim().toLowerCase();
  if (!/^[a-z0-9-]{4,40}$/.test(code)) return lobbyError("That doesn't look like a room code.");
  joinRoom(code);
}

async function joinRoom(code) {
  roomCode = code;
  setLobbyBusy(true);
  // Tests point the extension at a local server; normal installs use config.js.
  const { serverUrl, forceRelay: force } = await chrome.storage.local.get(["serverUrl", "forceRelay"]);
  forceRelay = !!force;
  const base = (serverUrl || SERVER_URL).replace(/\/$/, "");
  ws = new WebSocket(`${base}/room/${encodeURIComponent(code)}?name=${encodeURIComponent(myName)}`);
  const socket = ws;

  socket.addEventListener("message", (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handle(msg);
  });
  socket.addEventListener("close", () => {
    if (ws !== socket) return;
    myId = null;
    for (const id of [...peers.keys()]) dropPeer(id);
    if (!everConnected) {
      lobbyError("Can't reach the Cotune server. Check your internet and try again.");
      setLobbyBusy(false);
      ws = null;
      return;
    }
    system("Connection lost. Reconnecting…");
    setTimeout(() => ws === socket && joinRoom(roomCode), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  });
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handle(msg) {
  switch (msg.t) {
    case "welcome": {
      const rejoin = everConnected;
      everConnected = true;
      reconnectDelay = 1000;
      myId = msg.you;
      leaderId = msg.leader;
      roster = msg.roster;
      rtcConfig = {
        iceServers: msg.ice || [],
        iceTransportPolicy: msg.relayOnly || forceRelay ? "relay" : "all",
      };
      enterRoom();
      saveSession();
      chrome.storage.local.set({ lastRoom: roomCode });
      if (msg.state) applyRemote(msg.state);
      system(rejoin ? "Reconnected." : roster.length > 1 ? "Joined the party." : "Party started. Share the link with your friends.");
      // Back in the call after a reconnect.
      if (localStream) {
        send({ t: "call", inCall: true });
        callEveryone();
      } else if (wantCall) {
        joinCall(); // we were in the call on the previous page
      }
      break;
    }
    case "roster":
      roster = msg.roster;
      leaderId = msg.leader;
      renderPeople();
      for (const id of [...peers.keys()]) {
        if (!roster.some((r) => r.id === id && r.inCall)) dropPeer(id);
      }
      connectMissingPeers();
      break;
    case "system":
      system(msg.text);
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
      if (video.playing !== msg.playing || drift > DRIFT_TOLERANCE_S) applyRemote(msg);
      break;
    }
    case "signal":
      onSignal(msg.from, msg.data);
      break;
  }
}

// The longest-present member sends the playback position so others can
// correct drift.
setInterval(() => {
  if (myId && myId === leaderId && video && roster.length > 1) {
    send({ t: "tick", playing: video.playing, time: currentTime() });
  }
}, HEARTBEAT_MS);

// Keeps the WebSocket from being closed as idle by networks in between.
setInterval(() => send({ t: "ping" }), PING_MS);

// -------------------------------------------------------------- call ---

async function joinCall() {
  if (localStream || joiningCall) return;
  joiningCall = true;
  $("call-error").hidden = true;
  const resume = resumeState;
  resumeState = null;
  wantCall = false;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: { width: 320, height: 240, frameRate: 15 },
    });
  } catch (err) {
    joiningCall = false;
    saveSession();
    showCallError(err);
    return;
  }
  joiningCall = false;
  micOn = resume?.micOn ?? true;
  camOn = resume?.camOn ?? true;
  localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
  addTile("me", localStream, `${myName} (you)`, true);
  send({ t: "call", inCall: true });
  callEveryone();
  renderCallControls();
  applySmartMic();
  saveSession();
}

// The newcomer calls everyone already in the call.
// Two people pressing "Join call" at the same moment can each miss the other's
// roster update, and then nobody calls anybody. Whoever has the higher id fixes it.
function connectMissingPeers() {
  if (!localStream) return;
  for (const r of roster) {
    if (r.id !== myId && r.inCall && !peers.has(r.id) && myId > r.id) startCall(r.id);
  }
}

function callEveryone() {
  for (const r of roster) {
    if (r.id !== myId && r.inCall) startCall(r.id);
  }
}

// persist=false is for teardown (page closing, leaving the party), which must
// not overwrite the saved "in call" state the next page resumes from.
function leaveCall({ persist = true } = {}) {
  stopScreenShare({ notify: false });
  for (const id of [...peers.keys()]) {
    send({ t: "signal", to: id, data: { bye: true } });
    dropPeer(id);
  }
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  removeTile("me");
  send({ t: "call", inCall: false });
  renderCallControls();
  if (persist) {
    wantCall = false;
    saveSession();
  }
}

// Leaves the room for good: nothing is resumed on later pages of this tab.
function leaveParty() {
  leaveCall({ persist: false });
  const socket = ws;
  ws = null;
  socket?.close();
  myId = null;
  leaderId = null;
  roster = [];
  roomCode = null;
  everConnected = false;
  reconnectDelay = 1000;
  pendingSync = null;
  wantCall = false;
  resumeState = null;
  clearSession();
  chrome.storage.local.remove("lastRoom");
  $("messages").textContent = "";
  $("code").value = "";
  $("room").hidden = true;
  $("chat").hidden = true;
  $("lobby").hidden = false;
  setLobbyBusy(false);
  renderPeople();
}

function createPeer(id) {
  dropPeer(id);
  const pc = new RTCPeerConnection(rtcConfig);
  const entry = {
    pc,
    pendingCandidates: [],
    makingOffer: false,
    needsReneg: false,
    camStreamId: null, // the stream that carries their camera and mic
    screenSender: null, // our screen video track on this connection
    screenAudioSender: null, // our screen audio track on this connection
  };
  peers.set(id, entry);
  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  pc.onicecandidate = (e) => {
    if (e.candidate) send({ t: "signal", to: id, data: { candidate: e.candidate.toJSON() } });
  };
  pc.ontrack = (e) => onRemoteTrack(id, entry, e);
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" && peers.get(id)?.pc === pc) {
      system(`The call with ${nameOf(id)} couldn't connect. Retrying…`);
      dropPeer(id);
      setTimeout(connectMissingPeers, 1500);
    }
  };
  return entry;
}

async function startCall(id) {
  const { pc } = createPeer(id);
  await pc.setLocalDescription(await pc.createOffer());
  send({ t: "signal", to: id, data: { description: pc.localDescription.toJSON() } });
}

async function onSignal(from, data) {
  if (!data) return;
  try {
    if (data.bye) {
      dropPeer(from);
    } else if (data.description?.type === "offer") {
      if (!localStream) {
        send({ t: "signal", to: from, data: { bye: true } });
        return;
      }
      const existing = peers.get(from);
      // The same call changing (e.g. they started sharing their screen).
      if (existing && isRenegotiation(existing, data.description)) {
        await answerRenegotiation(from, existing, data.description);
        return;
      }
      // Both called each other at once: the lower id keeps its own offer.
      if (existing?.pc.signalingState === "have-local-offer" && myId < from) return;
      const entry = createPeer(from);
      await entry.pc.setRemoteDescription(data.description);
      await flushCandidates(entry);
      await entry.pc.setLocalDescription(await entry.pc.createAnswer());
      send({ t: "signal", to: from, data: { description: entry.pc.localDescription.toJSON() } });
      addScreenToPeer(from);
      flushRenegotiation(from);
    } else if (data.description?.type === "answer") {
      const entry = peers.get(from);
      if (entry?.pc.signalingState !== "have-local-offer") return;
      await entry.pc.setRemoteDescription(data.description);
      await flushCandidates(entry);
      addScreenToPeer(from);
      flushRenegotiation(from);
    } else if (data.screenRefresh) {
      await refreshScreen(from);
    } else if (data.candidate) {
      const entry = peers.get(from);
      if (!entry) return;
      if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(data.candidate);
      else entry.pendingCandidates.push(data.candidate);
    }
  } catch (err) {
    console.warn("Cotune call signaling:", err);
  }
}

// ---------------------------------------------- renegotiation + screen ---
// Starting or stopping a screen share changes an existing connection, so the
// two sides negotiate again over the same RTCPeerConnection. If both change
// at the same moment, the higher id is "polite" and gives way.

function iceUfrag(sdp) {
  return /a=ice-ufrag:(\S+)/.exec(sdp || "")?.[1] || null;
}

// An offer on the same ICE session as the connection we already have.
function isRenegotiation(entry, description) {
  const current = entry.pc.remoteDescription;
  return !!current && iceUfrag(current.sdp) === iceUfrag(description.sdp);
}

async function renegotiate(id) {
  const entry = peers.get(id);
  if (!entry || entry.pc.signalingState === "closed") return;
  try {
    entry.makingOffer = true;
    await entry.pc.setLocalDescription(await entry.pc.createOffer());
    send({ t: "signal", to: id, data: { description: entry.pc.localDescription.toJSON() } });
  } catch (err) {
    console.warn("Cotune renegotiation:", err);
  } finally {
    entry.makingOffer = false;
  }
}

function queueRenegotiation(id) {
  const entry = peers.get(id);
  if (!entry) return;
  if (entry.pc.signalingState === "stable" && !entry.makingOffer) renegotiate(id);
  else entry.needsReneg = true; // sent as soon as the current exchange settles
}

function flushRenegotiation(id) {
  const entry = peers.get(id);
  if (entry?.needsReneg && entry.pc.signalingState === "stable" && !entry.makingOffer) {
    entry.needsReneg = false;
    renegotiate(id);
  }
}

async function answerRenegotiation(from, entry, description) {
  const polite = myId > from;
  const collision = entry.makingOffer || entry.pc.signalingState !== "stable";
  if (collision && !polite) return; // our offer wins; they will answer it
  // A polite peer rolls its own offer back implicitly here.
  await entry.pc.setRemoteDescription(description);
  await flushCandidates(entry);
  await entry.pc.setLocalDescription(await entry.pc.createAnswer());
  send({ t: "signal", to: from, data: { description: entry.pc.localDescription.toJSON() } });
  if (collision) entry.needsReneg = true; // our rolled-back change still has to go out
  flushRenegotiation(from);
}

// Their camera arrives first; a second stream from the same person is a screen.
function onRemoteTrack(id, entry, e) {
  const stream = e.streams[0];
  if (!stream) return;
  entry.camStreamId ??= stream.id;
  if (stream.id === entry.camStreamId) {
    addTile(id, stream, nameOf(id), false);
    return;
  }
  const tileId = `${id}:screen`;
  if (e.track.kind === "video") {
    entry.screenReceiver = e.receiver;
    entry.lastRecv = null;
    entry.stalls = 0;
  }
  const hasAudio = stream.getAudioTracks().length > 0;
  addTile(tileId, stream, `${nameOf(id)} (screen) · connecting…`, false, true, hasAudio);
  system(`${nameOf(id)} is sharing their screen. Hover the tile and press Expand to watch.`);
  const gone = () => removeTile(tileId, stream);
  stream.addEventListener("removetrack", gone);
  e.track.addEventListener("ended", gone);
}

function addScreenToPeer(id) {
  const entry = peers.get(id);
  if (!entry || !screenStream) return;
  const videoTrack = screenStream.getVideoTracks()[0];
  const audioTrack = screenStream.getAudioTracks()[0];
  let changed = false;

  if (videoTrack && !entry.screenSender) {
    entry.screenSender = entry.pc.addTrack(videoTrack, screenStream);
    changed = true;
  }
  if (audioTrack && !entry.screenAudioSender) {
    entry.screenAudioSender = entry.pc.addTrack(audioTrack, screenStream);
    changed = true;
  }

  if (changed) queueRenegotiation(id);
}

const screenTrack = () => screenStream?.getVideoTracks()[0] || null;

function captureConstraints() {
  return { frameRate: { ideal: SCREEN_CONFIG.fps, max: SCREEN_CONFIG.fps }, width: { max: SCREEN_CONFIG.w }, height: { max: SCREEN_CONFIG.h } };
}

function showScreenError(err) {
  // Closing the picker also lands here as NotAllowedError; that isn't an error.
  if (err.name === "NotAllowedError" && !/policy/i.test(err.message || "")) return;
  const el = $("call-error");
  el.hidden = false;
  el.textContent = `Couldn't share your screen: ${err.message || err.name}`;
}

let screenCheckInterval = null;

function watchScreenStream(stream) {
  if (!stream) return;
  const onEnded = () => {
    if (screenStream === stream) stopScreenShare();
  };
  for (const track of stream.getTracks()) {
    track.addEventListener("ended", onEnded);
    track.onended = onEnded;
  }
  stream.addEventListener("inactive", onEnded);
  stream.oninactive = onEnded;
  stream.addEventListener("removetrack", () => {
    if (
      screenStream === stream &&
      (!stream.getVideoTracks().length ||
        stream.getVideoTracks().every((t) => t.readyState === "ended"))
    ) {
      stopScreenShare();
    }
  });
  stream.addEventListener("addtrack", (e) => {
    e.track.addEventListener("ended", onEnded);
    e.track.onended = onEnded;
  });

  if (!screenCheckInterval) {
    screenCheckInterval = setInterval(() => {
      if (!screenStream) {
        clearInterval(screenCheckInterval);
        screenCheckInterval = null;
        return;
      }
      const vTrack = screenStream.getVideoTracks()[0];
      if (
        !vTrack ||
        vTrack.readyState === "ended" ||
        screenStream.getTracks().every((t) => t.readyState === "ended")
      ) {
        stopScreenShare();
      }
    }, 400);
  }
}

async function startScreenShare() {
  if (!localStream || screenStream) return;
  $("call-error").hidden = true;
  let stream;
  try {
    // Setting audio: true prompts the native browser screen-picker with the "Also share system audio" checkbox
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: captureConstraints(),
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    showScreenError(err);
    return;
  }
  if (!localStream || screenStream) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  screenStream = stream;
  watchScreenStream(screenStream);
  applyScreenSettings();
  addTile("me:screen", stream, `${myName} (screen)`, true, true);
  for (const id of peers.keys()) addScreenToPeer(id);
  renderCallControls();
}

// Switch to another screen/window/tab without stopping: the new track replaces
// the old one on every connection, so nobody needs to renegotiate or reload.
async function switchScreenSource() {
  const old = screenTrack();
  if (!old) return;
  let next;
  try {
    next = await navigator.mediaDevices.getDisplayMedia({
      video: captureConstraints(),
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    showScreenError(err);
    return;
  }
  const track = next.getVideoTracks()[0];
  if (screenTrack() !== old) {
    next.getTracks().forEach((t) => t.stop()); // sharing was stopped while the picker was open
    return;
  }
  watchScreenStream(next);
  for (const entry of peers.values()) {
    await entry.screenSender?.replaceTrack(track).catch(() => {});
  }
  screenStream.removeTrack(old);
  screenStream.addTrack(track);
  old.stop();
  addTile("me:screen", screenStream, `${myName} (screen)`, true, true);

  // Handle audio track replacement/addition if available
  const oldAudio = screenStream.getAudioTracks()[0];
  const nextAudio = next.getAudioTracks()[0];
  if (oldAudio && nextAudio) {
    for (const entry of peers.values()) {
      await entry.screenAudioSender?.replaceTrack(nextAudio).catch(() => {});
    }
    screenStream.removeTrack(oldAudio);
    screenStream.addTrack(nextAudio);
    oldAudio.stop();
  } else if (!oldAudio && nextAudio) {
    screenStream.addTrack(nextAudio);
    for (const id of peers.keys()) addScreenToPeer(id);
  } else if (oldAudio && !nextAudio) {
    screenStream.removeTrack(oldAudio);
    oldAudio.stop();
    for (const [id, entry] of peers) {
      if (entry.screenAudioSender) {
        try {
          entry.pc.removeTrack(entry.screenAudioSender);
        } catch {}
        entry.screenAudioSender = null;
        queueRenegotiation(id);
      }
    }
  }

  watchScreenStream(screenStream);
  applyScreenSettings();
}

function stopScreenShare({ notify = true } = {}) {
  if (screenCheckInterval) {
    clearInterval(screenCheckInterval);
    screenCheckInterval = null;
  }
  if (!screenStream) return;
  const stream = screenStream;
  screenStream = null;
  for (const t of stream.getTracks()) {
    try {
      t.stop();
    } catch {}
  }
  const myTile = document.querySelector('.tile[data-id="me:screen"]');
  if (myTile) {
    const v = myTile.querySelector("video");
    if (v) {
      v.srcObject = null;
      try {
        v.load();
      } catch {}
    }
  }
  removeTile("me:screen");
  for (const [id, entry] of peers) {
    if (entry.screenSender) {
      try {
        entry.screenSender.track?.stop();
        entry.pc.removeTrack(entry.screenSender);
      } catch {
        // connection already closed
      }
      entry.screenSender = null;
    }
    if (entry.screenAudioSender) {
      try {
        entry.screenAudioSender.track?.stop();
        entry.pc.removeTrack(entry.screenAudioSender);
      } catch {
        // connection already closed
      }
      entry.screenAudioSender = null;
    }
    entry.screenTuned = false;
    entry.lastSent = null;
    if (notify) queueRenegotiation(id);
  }
  renderCallControls();
}

// ------------------------------------------------ screen quality + stats ---

async function applyScreenSettings() {
  const track = screenTrack();
  if (!track) return;
  track.contentHint = SCREEN_CONFIG.hint; // detail = keep text & media sharp
  try {
    await track.applyConstraints(captureConstraints());
  } catch {
    // some sources can't change on the fly; the sender limits below still apply
  }
  for (const entry of peers.values()) entry.screenTuned = false;
  tuneSenders();
}

// Bitrate and frame-rate caps live on the sender, which only accepts them once
// negotiation is done; the stats loop retries until it sticks.
async function tuneSenders() {
  for (const entry of peers.values()) {
    const sender = entry.screenSender;
    if (!sender || entry.screenTuned || entry.pc.signalingState !== "stable") continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = SCREEN_CONFIG.bitrate;
      params.encodings[0].maxFramerate = SCREEN_CONFIG.fps;
      await sender.setParameters(params);
      entry.screenTuned = true;
    } catch {
      // not negotiated yet
    }
  }
}

const videoStat = (s, type) => s.type === type && (s.kind || s.mediaType) === "video";
const fmtRate = (kbps) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`);

async function senderStats() {
  if (!screenStream) return;
  tuneSenders();
}

function setCaption(tileId, text) {
  const span = document.querySelector(`.tile[data-id="${CSS.escape(tileId)}"] span`);
  if (span) span.textContent = text;
  if (tileId === expandedId) $("viewer-title").textContent = text;
}

// What we receive: show it on the tile, and un-stick it if the video stalls.
async function receiverStats() {
  const now = performance.now();
  for (const [id, entry] of peers) {
    const tileId = `${id}:screen`;
    if (!entry.screenReceiver || !document.querySelector(`.tile[data-id="${CSS.escape(tileId)}"]`)) continue;
    for (const s of (await entry.screenReceiver.getStats()).values()) {
      if (!videoStat(s, "inbound-rtp")) continue;
      const prev = entry.lastRecv;
      entry.lastRecv = { bytes: s.bytesReceived, frames: s.framesDecoded, at: now };
      const kbps = prev ? ((s.bytesReceived - prev.bytes) * 8) / (now - prev.at) : 0;
      entry.stalls = prev && s.framesDecoded === prev.frames ? (entry.stalls || 0) + 1 : 0;
      setCaption(tileId, `${nameOf(id)} (screen)`);
      if (entry.stalls >= 3) recoverScreen(id, entry, tileId, now);
    }
  }
}

// No new frames for ~6 s: re-attach the video, and ask the sharer to kick the
// sender (a fresh frame and keyframe) instead of making everybody reload.
function recoverScreen(id, entry, tileId, now) {
  for (const v of [document.querySelector(`.tile[data-id="${CSS.escape(tileId)}"] video`), tileId === expandedId ? $("viewer-video") : null]) {
    if (!v?.srcObject) continue;
    const stream = v.srcObject;
    v.srcObject = null;
    v.srcObject = stream;
    v.play().catch(() => {});
  }
  if (now - (entry.lastRefreshAsk || 0) > 10000) {
    entry.lastRefreshAsk = now;
    send({ t: "signal", to: id, data: { screenRefresh: true } });
  }
}

async function refreshScreen(from) {
  const sender = peers.get(from)?.screenSender;
  const track = screenTrack();
  if (!sender || !track) return;
  try {
    await sender.replaceTrack(null);
    await sender.replaceTrack(track);
  } catch (err) {
    console.warn("Cotune screen refresh:", err);
  }
}

setInterval(async () => {
  if (statsBusy) return;
  statsBusy = true;
  try {
    await senderStats();
    await receiverStats();
  } catch (err) {
    console.warn("Cotune stats:", err);
  } finally {
    statsBusy = false;
  }
}, 2000);

// --------------------------------------------- watching someone's screen ---

function expandScreen(tileId) {
  const video = document.querySelector(`.tile[data-id="${CSS.escape(tileId)}"] video`);
  if (!video?.srcObject) return;
  expandedId = tileId;
  expandedAt = Date.now();
  const v = $("viewer-video");
  v.srcObject = video.srcObject;
  v.muted = video.muted; // Respect audio on the expanded screen
  v.play().catch(() => {});
  $("viewer-title").textContent = document.querySelector(`.tile[data-id="${CSS.escape(tileId)}"] span`)?.textContent || "";
  $("viewer").hidden = false;
  document.body.classList.add("expanded");
  window.parent.postMessage({ cotune: "expand", on: true }, "*");
  updateViewerParticipants();
  renderCallControls();
}

function collapseScreen(notify = true) {
  if (!expandedId) return;
  expandedId = null;
  $("viewer-video").srcObject = null;
  $("viewer").hidden = true;
  document.body.classList.remove("expanded");
  if (notify) window.parent.postMessage({ cotune: "expand", on: false }, "*");
  updateViewerParticipants();
  renderCallControls();
}

async function popOut(video) {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await video.requestPictureInPicture();
  } catch (err) {
    system(`Pop-out isn't available here: ${err.message || err.name}`);
  }
}

async function flushCandidates(entry) {
  for (const c of entry.pendingCandidates.splice(0)) await entry.pc.addIceCandidate(c);
}

function dropPeer(id) {
  const entry = peers.get(id);
  if (!entry) return;
  peers.delete(id);
  entry.pc.close();
  removeTile(id);
  removeTile(`${id}:screen`);
  updateViewerParticipants();
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
  saveSession();
}

function toggleCam() {
  camOn = !camOn;
  localStream?.getVideoTracks().forEach((t) => (t.enabled = camOn));
  renderCallControls();
  saveSession();
}

// "Smart mic": stay muted while the movie plays, talk when it's paused.
function applySmartMic() {
  if (!localStream) return;
  const smart = $("smart-mic").checked && video?.playing;
  localStream.getAudioTracks().forEach((t) => (t.enabled = micOn && !smart));
}

// ---------------------------------------------------------------- UI ---

function enterRoom() {
  $("lobby").hidden = true;
  $("room").hidden = false;
  $("chat").hidden = false;
  $("invite").value = inviteLink(roomCode);
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
    li.textContent = (r.inCall ? "🎥 " : "") + r.name + (r.id === myId ? " (you)" : "");
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
  $("screen").hidden = !inCall;
  $("screen-tools").hidden = !screenStream;
  $("call-leave").hidden = !inCall;
  $("smart-mic-row").hidden = !inCall;
  $("mic").textContent = micOn ? "Mute" : "Unmute";
  $("cam").textContent = camOn ? "Camera off" : "Camera on";
  $("screen").textContent = screenStream ? "Stop sharing" : "Share screen";

  // Sync controls in the full-screen / expanded viewer overlay
  const viewerControls = $("viewer-controls");
  if (viewerControls) {
    viewerControls.hidden = !inCall || !expandedId;
    $("viewer-mic").textContent = micOn ? "Mute" : "Unmute";
    $("viewer-cam").textContent = camOn ? "Camera off" : "Camera on";
    $("viewer-screen").hidden = !screenStream;
  }
}

function updateViewerParticipants() {
  const container = $("viewer-participants");
  if (!container) return;
  if (!expandedId) {
    container.innerHTML = "";
    return;
  }

  // Find all video tiles except the expanded screen tile
  const activeTiles = Array.from(document.querySelectorAll("#tiles .tile")).filter(
    (tile) => tile.dataset.id !== expandedId
  );

  const activeIds = new Set(activeTiles.map((t) => t.dataset.id));

  // Remove mini-tiles that are no longer active
  Array.from(container.children).forEach((mini) => {
    if (!activeIds.has(mini.dataset.id)) mini.remove();
  });

  // Add or update mini-tiles
  for (const tile of activeTiles) {
    const id = tile.dataset.id;
    const origVideo = tile.querySelector("video");
    const labelText = tile.querySelector("span")?.textContent || "";
    let mini = container.querySelector(`.mini-tile[data-id="${CSS.escape(id)}"]`);
    if (!mini) {
      mini = document.createElement("div");
      mini.className = "mini-tile";
      mini.dataset.id = id;
      const v = document.createElement("video");
      v.autoplay = true;
      v.playsInline = true;
      v.muted = true; // Always muted for PIP mini-tiles to prevent audio duplication
      const span = document.createElement("span");
      mini.append(v, span);
      container.append(mini);
    }
    const miniVideo = mini.querySelector("video");
    if (miniVideo && origVideo?.srcObject && miniVideo.srcObject !== origVideo.srcObject) {
      miniVideo.srcObject = origVideo.srcObject;
      miniVideo.play().catch(() => {});
    }
    const miniSpan = mini.querySelector("span");
    if (miniSpan) miniSpan.textContent = labelText;
  }
}

function addTile(id, stream, label, muted, screen = false, hasAudio = false) {
  let tile = document.querySelector(`.tile[data-id="${CSS.escape(id)}"]`);
  if (!tile) {
    tile = document.createElement("div");
    tile.className = "tile";
    tile.dataset.id = id;
    tile.append(document.createElement("video"), document.createElement("span"));
    $("tiles").append(tile);
  }
  tile.classList.toggle("screen", screen);
  const v = tile.querySelector("video");
  v.autoplay = true;
  v.playsInline = true;
  v.muted = muted || (screen && !hasAudio);
  v.srcObject = stream;
  v.play().catch(() => {});
  tile.querySelector("span").textContent = label;
  if (screen && !tile.querySelector(".tile-actions")) {
    const actions = document.createElement("div");
    actions.className = "tile-actions";
    actions.innerHTML = '<button data-act="expand">Expand</button><button data-act="pip">Pop out</button>';
    tile.append(actions);
  }
  updateViewerParticipants();
}

// With onlyStream, the tile is removed only if it still shows that stream.
function removeTile(id, onlyStream) {
  const tile = document.querySelector(`.tile[data-id="${CSS.escape(id)}"]`);
  if (!tile) return;
  if (onlyStream && tile.querySelector("video")?.srcObject !== onlyStream) return;
  if (id === expandedId) collapseScreen();
  const v = tile.querySelector("video");
  if (v) {
    v.srcObject = null;
    try {
      v.load();
    } catch {}
  }
  tile.remove();
  updateViewerParticipants();
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
$("screen").addEventListener("click", () => (screenStream ? stopScreenShare() : startScreenShare()));
$("party-leave").addEventListener("click", leaveParty);
$("screen-switch").addEventListener("click", switchScreenSource);
$("tiles").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-act]");
  const tile = button?.closest(".tile");
  if (!tile) return;
  if (button.dataset.act === "expand") expandScreen(tile.dataset.id);
  else if (button.dataset.act === "pip") popOut(tile.querySelector("video"));
});
$("viewer-back").addEventListener("click", () => collapseScreen());
$("viewer-pip").addEventListener("click", () => popOut($("viewer-video")));
$("viewer-mic")?.addEventListener("click", toggleMic);
$("viewer-cam")?.addEventListener("click", toggleCam);
$("viewer-screen")?.addEventListener("click", () => stopScreenShare());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") collapseScreen();
});
$("smart-mic").addEventListener("change", applySmartMic);
$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("chat-input").value.trim();
  if (!text) return;
  $("chat-input").value = "";
  chatLine(myName, text);
  send({ t: "chat", text });
});

$("chat-toggle").addEventListener("click", () => {
  const hidden = document.body.classList.toggle("chat-hidden");
  $("chat-toggle").textContent = hidden ? "Show chat" : "Hide chat";
});

// The content script tells us when the movie goes fullscreen; we switch to a
// compact overlay and report our height so it can size the iframe to fit.
window.addEventListener("message", (e) => {
  if (e.source !== window.parent || e.data?.cotune !== "layout") return;
  document.body.classList.toggle("overlay", !!e.data.overlay);
  // The page gave the panel back its sidebar (e.g. Esc): close the viewer too.
  if (!e.data.expanded && expandedId && Date.now() - expandedAt > 500) collapseScreen(false);
});
new ResizeObserver(() => {
  if (!document.body.classList.contains("overlay")) return;
  window.parent.postMessage({ cotune: "height", height: Math.ceil(document.body.scrollHeight) }, "*");
}).observe(document.body);

function teardown() {
  // Tear down local media tracks and peer connections without broadcasting
  // "bye" / "inCall: false" so the tab session persists across page transitions.
  stopScreenShare({ notify: false });
  for (const id of [...peers.keys()]) {
    dropPeer(id);
  }
  localStream?.getTracks().forEach((t) => {
    try {
      t.stop();
    } catch {}
  });
  localStream = null;
  const socket = ws;
  ws = null;
  try {
    socket?.close();
  } catch {}
}

window.addEventListener("message", (e) => {
  if (e.data?.cotune === "teardown") teardown();
});
window.addEventListener("beforeunload", teardown);
window.addEventListener("pagehide", teardown);
window.addEventListener("unload", teardown);

connectBackground();

(async () => {
  const { name, lastRoom } = await chrome.storage.local.get(["name", "lastRoom"]);
  if (name) $("name").value = name;
  if (JOIN_CODE) {
    $("code").value = JOIN_CODE;
    // Same room as before the page changed: come back into the call too.
    const saved = await readSession();
    if (saved?.room === JOIN_CODE) {
      wantCall = !!saved.inCall;
      resumeState = { micOn: saved.micOn, camOn: saved.camOn };
    }
    if (name) joinParty(JOIN_CODE);
    else lobbyError("Enter your name, then press Join.");
  } else if (lastRoom) {
    $("code").value = lastRoom; // handy in a new tab: just press Join
  }
})();
