# Portable Kart

Play **Mario Kart Wii** on a laptop with **phones as Wii Wheels**. Up to 4 players, no Wii Remotes, no app install on the phone: scan a QR code and steer by tilting.

Works on **macOS and Windows** (Linux too). The game runs in [Dolphin](https://dolphin-emu.org), the open-source GameCube/Wii emulator, using **your own copy** of Mario Kart Wii.

> Portable Kart does not include, download, or link to any game files. Use a backup of a disc you own (Dolphin's site explains how to [dump your own discs](https://dolphin-emu.org/docs/guides/ripping-games/)).

## How it works

```
 iPhone (Safari)                        Laptop
┌───────────────────┐   Wi-Fi    ┌──────────────────────────────┐
│ Controller page   │  WebSocket │  Portable Kart               │
│  • touch buttons  │ ─────────► │   ├─ phone server (HTTPS/WSS)│
│  • accelerometer  │   ~60 Hz   │   ├─ player slots 1-4        │
│  • gyroscope      │            │   └─ DSU server (UDP 26760) ─┼──► Dolphin's built-in
└───────────────────┘            │                              │    DSU client → 4 emulated
                                 │  Dashboard (localhost only)  │    Wii Remotes → Mario Kart Wii
                                 └──────────────────────────────┘
```

1. **Phone → laptop.** The phone opens a web page served by the laptop over your Wi-Fi. It reads touch input and the motion sensors, converts them into the Wii Remote's own coordinate frame, and streams them over a WebSocket about 60 times a second.
2. **Laptop → Dolphin.** Dolphin has a built-in client for the **DSU ("cemuhook") protocol**, which carries buttons, accelerometer and gyroscope data over local UDP. Portable Kart is a DSU server with 4 pad slots, one per phone. This works the same on Windows, macOS and Linux and needs no drivers or virtual-gamepad installs.
3. **Dolphin setup is automatic.** Portable Kart runs Dolphin with its **own user folder** (`--user`), so it never changes your existing Dolphin settings. It writes a controller profile that binds each DSU pad to an emulated Wii Remote, with the phone's accelerometer driving the Wii Remote's accelerometer. Mario Kart Wii's Wii Wheel steering reads that accelerometer.

### Why these choices

| Decision | Why |
|---|---|
| **Dolphin** for emulation | Best-in-class Wii emulator, open source, runs Mario Kart Wii at full speed on most laptops, and ships on Windows, macOS and Linux. |
| **Web page on the phone** (not an app) | Nothing to install, nothing to approve on the App Store, and it works on any phone. iPhone Safari exposes the gyroscope and accelerometer to web pages. |
| **DSU protocol** into Dolphin | Built into Dolphin, cross-platform, and carries real motion data. The alternatives (virtual gamepad drivers, keyboard injection) are per-OS and can't carry tilt. |
| **Local Wi-Fi** | Nothing leaves your network, latency is a few milliseconds, and no accounts are needed. |
| **Self-signed HTTPS** | iOS only gives motion sensors to secure (`https://`) pages. The first time each phone connects, Safari shows a one-time "not private" warning that you tap through. |

## Getting started

> **Coming soon: a double-click app.** The goal is a normal installer (`.dmg` for Mac, `.exe` for Windows) so nobody needs a terminal. Until then, running it takes one command.

1. Install [Node.js](https://nodejs.org) (the LTS version) and [Dolphin](https://dolphin-emu.org/download/).
2. Download this project, then in its folder run:
   ```bash
   npm install
   npm start
   ```
3. A dashboard opens in your browser. It will:
   - **find your Mario Kart Wii file** (`.iso`, `.wbfs`, `.rvz`…) in Downloads, Desktop, Documents or Games,
   - **find Dolphin**, or link you to download it,
   - show a **QR code** for phones.
4. On each iPhone (on the **same Wi-Fi**):
   1. Scan the QR code with the Camera.
   2. Safari says *"This connection is not private."* Tap **Show Details**, then **visit this website**, then **Visit Website**. You only do this once per phone.
   3. Tap **Join game**, then **Allow** motion access.
   4. Turn the phone sideways and hold it like a steering wheel.
5. Click **Play** on the dashboard.

The first time it runs, your computer may ask whether to allow incoming network connections. Click **Allow**, or phones can't connect.

## Controls

Hold the phone sideways like the Wii Wheel, screen facing you.

| Phone | Wii Remote | In Mario Kart Wii |
|---|---|---|
| Tilt left / right | Accelerometer | Steer |
| Flick up | Accelerometer | Trick / wheelie |
| **2 · GAS** (right thumb) | 2 | Accelerate / confirm |
| **1 · BRAKE** (right thumb) | 1 | Brake, reverse / back |
| **B · DRIFT** (left thumb) | B | Drift / hop |
| **ITEM** pad (left thumb) | D-pad | Use item / move in menus |
| A, −, ⌂, + | A, −, Home, + | Menus, pause |

B sits under your left thumb and 2 under your right, so you can drift and accelerate at the same time (a real Wii Wheel uses your index finger for B).

## Troubleshooting

- **Phone can't load the page.** Make sure it's on the same Wi-Fi as the laptop, not cellular. Guest and hotel networks often block devices from talking to each other, so use a phone hotspot or home network. Check that your firewall allowed the connection.
- **Steering doesn't work.** Motion access was denied. Close the Safari tab, scan the code again, and tap **Allow**. Also turn off Rotation Lock so the controller can go sideways.
- **"Game is full".** Four players are already connected.
- **Port already in use.** Portable Kart is probably already running in another window.

## Development

```bash
npm start -- --dev   # also serves the controller at http://localhost:7444 for desktop testing
npm test
```

| Path | What it is |
|---|---|
| `src/dsu-server.js` | DSU/cemuhook UDP server (protocol encoder, client subscriptions) |
| `src/controller-hub.js` | Phone ↔ player slot management and input packet decoding |
| `src/dolphin.js` | Find Dolphin, write its config (DSU server, Wii Remote profiles), launch it |
| `src/games.js` | Find disc images and read their game IDs |
| `src/phone-server.js` | HTTPS + WebSocket server for phones |
| `src/dashboard-server.js` | Localhost-only control panel API |
| `public/phone/` | The controller web page |
| `public/dashboard/` | The laptop dashboard |

**Motion frames.** The phone converts its motion data into Dolphin's Wii Remote frame (+X left, +Y toward the 1/2 end, +Z out of the button face) before sending it. For a remote held like a wheel, that means +X points down the screen, +Y right and +Z toward the player. The Dolphin profile then binds DSU accel `(x, y, z)` to Wii Remote `(x, z, y)`, and gyro `(pitch, yaw, roll)` to `(x, z, y)`.

## Roadmap

- [x] Phone controller, DSU server, Dolphin auto-configuration, dashboard
- [ ] Test on real hardware (iPhone + Dolphin + Mario Kart Wii) and tune steering
- [ ] **Desktop app**: double-click installers for Mac and Windows, native file pickers, optional one-click Dolphin download
- [ ] Phone polish: auto-accelerate option, pointer (IR) for menus via the gyroscope, Add to Home Screen
- [ ] Maybe: a native iPhone app to skip the certificate warning
