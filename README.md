# Portable Kart

Play **Mario Kart Wii** on a laptop (Mac or Windows) with **iPhones as Wii Remotes**. Up to 4 players: scan a QR code and steer by tilting.

## How it works

```
 iPhone (browser)                      Laptop
┌──────────────────┐   Wi-Fi    ┌─────────────────────────────┐
│ Wii Remote page  │  WebSocket │ Portable Kart               │
│  • buttons       │ ─────────► │  ├─ phone server (HTTPS)    │
│  • tilt (motion) │            │  ├─ player slots 1–4        │
└──────────────────┘            │  └─ DSU server (UDP) ───────┼──► Dolphin → Mario Kart Wii
                                └─────────────────────────────┘
```

1. **Phone → laptop.** Each phone opens a web page served by the laptop over Wi-Fi. No app is needed. The page reads the buttons and motion sensors and streams them about 60 times a second.
2. **Laptop → Dolphin.** The [Dolphin](https://dolphin-emu.org) emulator has a built-in client for the DSU controller protocol. Portable Kart acts as a DSU server, so each phone becomes an emulated Wii Remote with real tilt steering. It needs no drivers, on Mac or Windows.
3. **Automatic setup.** Portable Kart starts Dolphin with its own settings folder and controller profile, so your existing Dolphin setup is never touched.

## Setup

1. Install [Node.js](https://nodejs.org) (LTS) and [Dolphin](https://dolphin-emu.org/download/).
2. Get your own copy of Mario Kart Wii (see [dumping your disc](https://dolphin-emu.org/docs/guides/ripping-games/)). Portable Kart doesn't include any games.
3. In this folder, run:
   ```bash
   npm install
   npm start
   ```
4. A dashboard opens in your browser. Choose your game file (**Find it for me** searches Downloads, Desktop, Documents and Games) and check that Dolphin was found.
5. On each iPhone, on the **same Wi-Fi**:
   1. Scan the QR code with the Camera.
   2. At *"This connection is not private"*, tap **Show Details** → **visit this website**. You only do this once per phone.
   3. Tap **Join game**, then **Allow** motion access.
   4. Hold the phone sideways with the **D-pad on the left**.
6. Click **Play**.

If your computer asks whether to allow incoming network connections, click **Allow**.
