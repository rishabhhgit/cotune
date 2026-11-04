# Cotune Watch Party 🍿

Watch any HTML5 video in sync with friends, with built-in text chat, video calls, and screen sharing.

---

## Features

- **Synced Video Playback**: Automatically detects and synchronizes HTML5 video playback, pause, and seeking across all viewers in the room with leader heartbeat drift correction.
- **Built-in Video & Audio Calls**: WebRTC mesh peer-to-peer audio and video calls directly within the extension panel.
- **Crystal Clear Screen Sharing**: 
  - 1080p @ 60fps screen sharing.
  - Native browser audio capture (share tab or system audio alongside video).
  - One-click source switching without interrupting viewers.
  - Seamless stall recovery and keyframe refresh.
- **Full-Screen Viewer & Mini-Tiles**:
  - Expand any shared screen to full-screen.
  - Keep seeing all participants' cameras with floating mini-tiles in the top corner.
  - Floating controls to easily mute/unmute, toggle camera, or stop sharing while viewing in full-screen.
- **Seamless Page Persistence**:
  - The call and party session stick to the browser tab.
  - If you click or change links, Cotune automatically reconnects to the room without dropping the call.
- **Smart Mic**:
  - Automatically mute your microphone when the video is playing, and unmute when it pauses to chat.
- **Theater & Fullscreen Overlay**:
  - Redirects player fullscreen so call controls and video tiles remain accessible as a clean overlay.

---

## Installation

### Load as an Unpacked Extension in Chrome / Chromium browsers:

1. Clone or download this repository:
   ```bash
   git clone https://github.com/rishabhhgit/cotune.git
   ```
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle switch in the top right corner).
4. Click **Load unpacked** and select the `cotune` directory.
5. Pin the Cotune extension icon to your toolbar for easy access!

---

## How to Use

1. **Start a Party**:
   - Open any website with a video (YouTube, Netflix, Anime streaming sites, etc.).
   - Click the Cotune icon to open the side panel.
   - Enter your name and click **Start a party**.
2. **Invite Friends**:
   - Copy the invite link from the panel and share it with your friends.
   - When friends open the link with Cotune installed, they will automatically join your room.
3. **Join Calls & Share Screen**:
   - Click **Join call** to enable camera and mic.
   - Click **Share screen** to present your screen or tabs with audio.
   - Click **Expand** on any screen share tile to enter theater full-screen view.

---

## Tech Stack

- **Manifest V3** Chrome Extension
- **WebRTC** mesh architecture with STUN/TURN support
- **WebSocket** signaling and state sync via Cloudflare Durable Objects
- **Pure JavaScript, HTML5, CSS** (Zero heavy dependencies or external UI libraries)

---

## License

MIT License. See [LICENSE](LICENSE) for details.
