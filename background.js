// Routes messages between the frame that holds the <video> and the panel,
// per tab. Both sides reconnect if this service worker is restarted.

const tabs = new Map(); // tabId -> { panel: Port | null, videos: Map<frameId, { port, duration }> }

function tabState(tabId) {
  if (!tabs.has(tabId)) tabs.set(tabId, { panel: null, videos: new Map() });
  return tabs.get(tabId);
}

// The movie is the longest video across all frames of the tab.
function mainVideo(state) {
  let best = null;
  for (const [frameId, v] of state.videos) {
    if (!best || v.duration > best.duration) best = { frameId, ...v };
  }
  return best;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "video") {
    const tabId = port.sender.tab?.id;
    const frameId = port.sender.frameId;
    if (tabId == null) return;
    const state = tabState(tabId);
    state.videos.set(frameId, { port, duration: 0 });

    port.onMessage.addListener((msg) => {
      const entry = state.videos.get(frameId);
      if (!entry) return;
      entry.duration = msg.duration || 0;
      if (mainVideo(state)?.frameId === frameId) {
        state.panel?.postMessage({ ...msg, type: "video" });
      }
    });
    port.onDisconnect.addListener(() => {
      if (state.videos.get(frameId)?.port === port) state.videos.delete(frameId);
    });
  } else if (port.name.startsWith("panel:")) {
    const tabId = Number(port.name.slice("panel:".length));
    const state = tabState(tabId);
    state.panel = port;

    port.onMessage.addListener((msg) => {
      if (msg.type === "cmd") mainVideo(state)?.port.postMessage(msg);
    });
    port.onDisconnect.addListener(() => {
      if (state.panel === port) state.panel = null;
    });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "whoami") sendResponse(sender.tab?.id);
});

chrome.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "toggle-panel" }, { frameId: 0 });
  } catch {
    // Tab was open before the extension was installed/reloaded: inject now.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["content.js"],
      });
      await chrome.tabs.sendMessage(tab.id, { type: "toggle-panel" }, { frameId: 0 });
    } catch (err) {
      console.warn("Cotune cannot run on this page:", err);
    }
  }
});
