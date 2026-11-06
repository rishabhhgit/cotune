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

  // --------------------------------------------------- fullscreen hook ---

  // fullscreen-hook.js (page world) redirects the player's fullscreen to our
  // theater mode only while <html data-cotune-theater> is set. The top frame
  // tells every frame when that applies.
  if (!isTop) {
    window.addEventListener("message", (e) => {
      if (e.source !== window.top || e.data?.cotune !== "theater-enabled") return;
      document.documentElement.toggleAttribute("data-cotune-theater", !!e.data.on);
    });
    window.top.postMessage({ cotune: "theater-query" }, "*");
    return;
  }

  // ---------------------------------------------------------------- panel ---

  const PANEL_WIDTH = 360;
  const OVERLAY_WIDTH = 300;
  const PANEL_ORIGIN = new URL(chrome.runtime.getURL("")).origin;
  let panel = null;
  let open = false;
  let overlayHeight = 0;
  let panelLoaded = false;
  let expanded = false; // the panel shows a shared screen over the whole page

  // The panel is a popover so it lives in the browser's top layer, above the
  // site's own overlays. In fullscreen it becomes a compact overlay.
  const BASE_STYLE = {
    position: "fixed",
    inset: "auto",
    margin: "0",
    padding: "0",
    border: "none",
    zIndex: "2147483647",
    overflow: "hidden",
  };
  const SIDEBAR_STYLE = {
    top: "0",
    right: "0",
    width: PANEL_WIDTH + "px",
    height: "100vh",
    borderLeft: "1px solid #2a2a33",
    borderRadius: "0",
    background: "#121216",
    colorScheme: "normal",
  };
  const OVERLAY_STYLE = {
    top: "12px",
    right: "12px",
    width: OVERLAY_WIDTH + "px",
    borderLeft: "none",
    borderRadius: "10px",
    background: "transparent",
    // Must match the panel's own color-scheme, or Chrome paints the iframe opaque.
    colorScheme: "dark",
  };

  const EXPANDED_STYLE = {
    top: "0",
    right: "0",
    width: "100vw",
    height: "100vh",
    borderLeft: "none",
    borderRadius: "0",
    background: "#000",
    colorScheme: "normal",
  };

  function layout() {
    if (!panel) return;
    broadcastTheater();
    // Top-layer order is "last shown on top": theater player, then panel.
    if (theater) {
      if (theater.frame.matches(":popover-open")) theater.frame.hidePopover();
      theater.frame.showPopover();
    }
    if (panel.matches(":popover-open")) panel.hidePopover();
    if (!open) {
      expanded = false;
      panel.style.display = "none";
      document.documentElement.style.marginRight = "";
      return;
    }
    const fullscreen = !!document.fullscreenElement;
    panel.style.display = "";
    if (expanded) {
      Object.assign(panel.style, EXPANDED_STYLE);
    } else {
      Object.assign(panel.style, fullscreen ? OVERLAY_STYLE : SIDEBAR_STYLE);
      if (fullscreen) panel.style.height = overlayHeight + "px";
    }
    panel.showPopover();
    document.documentElement.style.marginRight = fullscreen || expanded ? "" : PANEL_WIDTH + "px";
    if (panelLoaded) {
      panel.contentWindow.postMessage(
        { cotune: "layout", overlay: fullscreen && !expanded, expanded },
        PANEL_ORIGIN,
      );
    }
  }

  // Remembers whether the panel is shown, so a new page restores it the same way.
  function notifyOpen() {
    try {
      chrome.runtime.sendMessage({ type: "panel-open", open }).catch(() => {});
    } catch {
      // extension was reloaded; this script is orphaned
    }
  }

  async function openPanel(joinCode, { hidden = false } = {}) {
    open = !hidden;
    notifyOpen();
    if (panel) return layout();

    const tabId = await chrome.runtime.sendMessage({ type: "whoami" });
    const url = new URL(chrome.runtime.getURL("panel.html"));
    url.searchParams.set("tab", tabId);
    url.searchParams.set("page", stripInvite(location.href));
    if (joinCode) url.searchParams.set("join", joinCode);

    panel = document.createElement("iframe");
    panel.src = url.href;
    panel.allow = "camera; microphone; display-capture; autoplay; clipboard-write";
    panel.popover = "manual";
    Object.assign(panel.style, BASE_STYLE);
    panel.addEventListener("load", () => {
      panelLoaded = true;
      layout();
    });
    document.documentElement.appendChild(panel);
    layout();
  }

  function hidePanel() {
    open = false;
    notifyOpen();
    layout();
  }

  // "Theater" fullscreen. If the player fullscreened itself from inside its
  // cross-origin iframe, the browser would show only that iframe and send all
  // clicks to it. Instead, fullscreen-hook.js forwards the request here and
  // we fullscreen the whole page, with the player's iframe stretched over the
  // viewport and the panel on top.
  let theater = null; // { frame, style, popover }

  const THEATER_STYLE = {
    position: "fixed",
    inset: "0",
    width: "100vw",
    height: "100vh",
    maxWidth: "none",
    maxHeight: "none",
    margin: "0",
    padding: "0",
    border: "none",
    transform: "none",
    background: "#000",
    zIndex: "2147483646",
  };

  function startTheater(frame) {
    theater = { frame, style: frame.getAttribute("style"), popover: frame.getAttribute("popover") };
    // A popover escapes ancestors' overflow/transform that would clip it.
    frame.popover = "manual";
    Object.assign(frame.style, THEATER_STYLE);
    frame.showPopover();
  }

  function endTheater() {
    if (!theater) return;
    const { frame, style, popover } = theater;
    theater = null;
    if (frame.matches(":popover-open")) frame.hidePopover();
    if (style == null) frame.removeAttribute("style");
    else frame.setAttribute("style", style);
    if (popover == null) frame.removeAttribute("popover");
    else frame.setAttribute("popover", popover);
  }

  // The <iframe> element in this document that contains window `w`.
  function frameElementFor(w) {
    try {
      while (w && w.parent !== window) {
        if (w === w.parent) return null;
        w = w.parent;
      }
    } catch {
      return null;
    }
    return [...document.querySelectorAll("iframe")].find((f) => f.contentWindow === w) || null;
  }

  async function toggleTheater(source) {
    if (theater) {
      if (document.fullscreenElement) await document.exitFullscreen();
      else endTheater();
      return;
    }
    const frame = frameElementFor(source);
    if (!frame) return;
    startTheater(frame);
    try {
      await document.documentElement.requestFullscreen();
    } catch (err) {
      console.warn("Cotune fullscreen:", err);
      endTheater();
    }
    layout();
  }

  // Tell every (nested, cross-origin) frame whether to redirect fullscreen.
  function broadcastTheater(win = window) {
    for (let i = 0; i < win.frames.length; i++) {
      const child = win.frames[i];
      if (child === panel?.contentWindow) continue;
      child.postMessage({ cotune: "theater-enabled", on: open }, "*");
      broadcastTheater(child);
    }
  }

  window.addEventListener("message", (e) => {
    if (e.data?.cotune === "theater-query") {
      e.source?.postMessage({ cotune: "theater-enabled", on: open }, "*");
    } else if (e.data?.cotune === "fullscreen-request" && open) {
      toggleTheater(e.source);
    }
  });

  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) endTheater();
    // Covers native fullscreen too (e.g. a player in the top page itself):
    // re-showing the popover puts the panel above the fullscreen element.
    layout();
  });

  // The panel reports its content height so the overlay is only as tall as
  // it needs to be (the iframe would otherwise block clicks on the movie).
  // Esc goes back from the shared-screen view to the page.
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && expanded) {
        expanded = false;
        layout();
      }
    },
    true,
  );
  window.addEventListener("message", (e) => {
    if (!panel || e.source !== panel.contentWindow || e.origin !== PANEL_ORIGIN) return;
    if (e.data?.cotune === "expand") {
      expanded = !!e.data.on && open;
      layout();
    } else if (e.data?.cotune === "height") {
      overlayHeight = Math.min(Number(e.data.height) || 0, innerHeight - 24);
      if (open && document.fullscreenElement) panel.style.height = overlayHeight + "px";
    }
  });

  function stripInvite(href) {
    const u = new URL(href);
    u.hash = u.hash.replace(/[#&]?cotune=[a-z0-9-]+/i, "");
    return u.href;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "toggle-panel") {
      if (open) hidePanel();
      else openPanel();
    } else if (msg.type === "hide-panel") {
      hidePanel();
    }
  });

  function teardown() {
    if (panel) {
      try {
        panel.contentWindow?.postMessage({ cotune: "teardown" }, PANEL_ORIGIN);
      } catch {}
      try {
        panel.src = "about:blank";
      } catch {}
      try {
        panel.remove();
      } catch {}
      panel = null;
    }
  }

  window.addEventListener("pagehide", teardown);
  window.addEventListener("beforeunload", teardown);

  // Invite links look like <movie page>#cotune=<room code>.
  const invite = location.hash.match(/cotune=([a-z0-9-]+)/i);
  if (invite) {
    openPanel(invite[1]);
  } else {
    // Same tab, new page: pick the party back up where it was left.
    chrome.runtime
      .sendMessage({ type: "get-session" })
      .then((session) => {
        if (session?.room) openPanel(session.room, { hidden: session.open === false });
      })
      .catch(() => {});
  }
})();
