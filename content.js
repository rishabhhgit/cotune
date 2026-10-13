// Runs in every frame (including cross-origin player iframes).
// - Frames that contain a <video>: report its state and apply sync commands.
// - The top frame: hosts the Cotune panel iframe.
(() => {
  if (window.__cotuneLoaded) return;
  window.__cotuneLoaded = true;

  const isTop = window === window.top;

  // ---------------------------------------------------------------- video ---

  const TICK_MS = 2000;
  // After applying a remote command we ignore the events it causes, so they
  // are not broadcast back to the room as if the user did them.
  const EXPECT_WINDOW_MS = 3000;

  let video = null;
  let port = null;
  let expected = null; // { action, time, until }

  // Ads are usually short; the movie is the longest video in the frame.
  function pickVideo() {
    let best = null;
    let bestScore = -1;
    for (const v of document.querySelectorAll("video")) {
      const duration = Number.isFinite(v.duration) ? v.duration : 0;
      const rect = v.getBoundingClientRect();
      const score = duration * 1e6 + rect.width * rect.height;
      if (score > bestScore) {
        best = v;
        bestScore = score;
      }
    }
    return best;
  }

  function connect() {
    if (port) return port;
    try {
      port = chrome.runtime.connect({ name: "video" });
    } catch {
      return null; // extension was reloaded; this script is orphaned
    }
    port.onMessage.addListener(onCommand);
    port.onDisconnect.addListener(() => {
      port = null;
    });
    return port;
  }

  function send(event, extra = {}) {
    if (!video) return;
    const p = connect();
    if (!p) return;
    try {
      p.postMessage({
        type: "state",
        event,
        user: !isExpected(event),
        time: video.currentTime,
        playing: !video.paused,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        ...extra,
      });
    } catch {
      port = null;
    }
  }

  function isExpected(event) {
    if (!expected || Date.now() > expected.until) return false;
    if (event === "play") return expected.action === "play";
    if (event === "pause") return expected.action === "pause";
    if (event === "seeked") {
      return expected.time != null && Math.abs(video.currentTime - expected.time) < 1.5;
    }
    return false;
  }

  function onCommand(msg) {
    if (msg.type !== "cmd" || !video) return;
    expected = { action: msg.action, time: msg.time, until: Date.now() + EXPECT_WINDOW_MS };
    if (msg.time != null && Math.abs(video.currentTime - msg.time) > 0.75) {
      video.currentTime = msg.time;
    }
    if (msg.action === "play" && video.paused) {
      video.play().catch(() => send("blocked"));
    } else if (msg.action === "pause" && !video.paused) {
      video.pause();
    }
  }

  const handlers = {
    play: () => send("play"),
    pause: () => send("pause"),
    seeked: () => send("seeked"),
    loadedmetadata: () => send("loaded"),
  };

  function attach(v) {
    if (video === v) return;
    if (video) {
      for (const [name, fn] of Object.entries(handlers)) video.removeEventListener(name, fn);
    }
    video = v;
    if (video) {
      for (const [name, fn] of Object.entries(handlers)) video.addEventListener(name, fn);
      send("loaded");
    }
  }

  setInterval(() => {
    attach(pickVideo());
    if (video) send("tick");
  }, TICK_MS);
  attach(pickVideo());

  // ---------------------------------------------------------------- panel ---

  if (!isTop) return;

  const PANEL_WIDTH = 360;
  let panel = null;

  async function openPanel(joinCode) {
    if (panel) {
      panel.style.display = "block";
      document.documentElement.style.marginRight = PANEL_WIDTH + "px";
      return;
    }
    const tabId = await chrome.runtime.sendMessage({ type: "whoami" });
    const url = new URL(chrome.runtime.getURL("panel.html"));
    url.searchParams.set("tab", tabId);
    url.searchParams.set("page", stripInvite(location.href));
    if (joinCode) url.searchParams.set("join", joinCode);

    panel = document.createElement("iframe");
    panel.src = url.href;
    panel.allow = "camera; microphone; autoplay; clipboard-write";
    Object.assign(panel.style, {
      position: "fixed",
      top: "0",
      right: "0",
      width: PANEL_WIDTH + "px",
      height: "100vh",
      border: "none",
      borderLeft: "1px solid #2a2a33",
      zIndex: "2147483647",
      background: "#121216",
      colorScheme: "normal",
    });
    document.documentElement.appendChild(panel);
    document.documentElement.style.marginRight = PANEL_WIDTH + "px";
  }

  function hidePanel() {
    if (!panel) return;
    panel.style.display = "none";
    document.documentElement.style.marginRight = "";
  }

  function stripInvite(href) {
    const u = new URL(href);
    u.hash = u.hash.replace(/[#&]?cotune=[a-z0-9-]+/i, "");
    return u.href;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "toggle-panel") {
      if (panel && panel.style.display !== "none") hidePanel();
      else openPanel();
    } else if (msg.type === "hide-panel") {
      hidePanel();
    }
  });

  // Invite links look like <movie page>#cotune=<room code>.
  const invite = location.hash.match(/cotune=([a-z0-9-]+)/i);
  if (invite) openPanel(invite[1]);
})();
