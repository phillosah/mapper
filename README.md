# Mapper

Real-time phone location tracker displayed on an OpenStreetMap web interface. Supports Android (GPSLogger) and iOS (OwnTracks).

## How it works

```
Android Phone (GPSLogger)  ──── HTTP GET /location ────►
                                                         Node.js Server (port 3000)
iOS/Android Phone (OwnTracks) ── HTTP POST /owntracks ──►        │  WebSocket broadcast
                                                                  ▼
                                                         Browser (Leaflet.js map)
```

Each phone sends GPS coordinates to the server at a configurable interval. The server stores the latest position for each device and broadcasts updates to all connected browsers via WebSocket. The browser displays a live marker per device on an OpenStreetMap map.

## Requirements

- Node.js 16+
- **Android:** [GPSLogger](https://gpslogger.app/) (free, Play Store / F-Droid)
- **iOS:** [OwnTracks](https://owntracks.org/) (free, App Store)
- Phone and PC on the same network (or server exposed publicly — see [Remote Access](#remote-access))

## Setup

### 1. Install and start the server

```bash
npm install
node server.js
```

Server starts at `http://localhost:3000`.

### 2a. Configure GPSLogger on Android

1. Open GPSLogger → hamburger menu → **Logging Details**
2. Tap **Log to custom URL** and enable it
3. Set the following:

| Field    | Value |
|----------|-------|
| URL      | `http://YOUR_PC_IP:3000/location?lat=%LAT&lon=%LON&device=%SER&acc=%ACC&batt=%BTT&spd=%SPD&alt=%ALT` |
| Method   | GET |
| Interval | 10–30 seconds |

4. Replace `YOUR_PC_IP` with your PC's local IP address (find it by running `ipconfig` on Windows and looking for the IPv4 address on your Wi-Fi adapter, e.g. `192.168.1.42`)

5. Start logging — your device will appear on the map within one interval

Multiple phones can be tracked simultaneously; each appears as a separate marker identified by the device serial number (`%SER`).

### 2b. Configure OwnTracks on iOS (or Android)

1. Install [OwnTracks](https://owntracks.org/) from the App Store
2. Open the app → tap the (i) icon → **Settings**
3. Set **Mode** to `HTTP`
4. Set **URL** to `http://YOUR_PC_IP:3000/owntracks`
5. Set **Tracker ID** (tid) to a short label for the device (e.g. `Ph`)
6. Tap **Done** — OwnTracks will begin sending location updates

The Tracker ID is what appears as the device name on the map.

### 3. Open the map

Navigate to `http://localhost:3000` in any browser on your network.

## Testing without a phone

Send a test location by visiting this URL in your browser (adjust coordinates as needed):

```
http://localhost:3000/location?lat=51.5074&lon=-0.1278&device=test1&acc=5&batt=80&spd=0&alt=10
```

A marker labelled `test1` will appear on the map at London.

## API endpoints

### `GET /location` — GPSLogger (Android)

| Parameter | GPSLogger token | Description          |
|-----------|-----------------|----------------------|
| `lat`     | `%LAT`          | Latitude (required)  |
| `lon`     | `%LON`          | Longitude (required) |
| `device`  | `%SER`          | Device identifier    |
| `acc`     | `%ACC`          | Accuracy in metres   |
| `batt`    | `%BTT`          | Battery percentage   |
| `spd`     | `%SPD`          | Speed in m/s         |
| `alt`     | `%ALT`          | Altitude in metres   |

### `POST /owntracks` — OwnTracks (iOS / Android)

Accepts the standard [OwnTracks HTTP payload](https://owntracks.org/booklet/tech/http/). The server reads `lat`, `lon`, `tid` (used as the device name), `batt`, `vel` (km/h, converted to m/s internally), `acc`, and `alt`. All other fields are ignored. Returns `[]` as required by the OwnTracks protocol.

## Remote access

To track phones outside your local network, expose the server publicly. The simplest option is [ngrok](https://ngrok.com/):

```bash
ngrok http 3000
```

Use the `https://...ngrok.io` URL in GPSLogger instead of the local IP. Note that free ngrok URLs change each session.

For a permanent setup, deploy the server to a VPS or cloud host and use its public IP/domain.

## File structure

```
Mapper/
├── package.json      # Dependencies: express, ws
├── server.js         # HTTP + WebSocket server
├── mapper.log        # Device update log (created automatically on first update)
└── public/
    └── index.html    # Map frontend (Leaflet.js)
```

## Map interface

- **Markers** — one per device, update position in real-time without page refresh
- **Popups** — click a marker to see coordinates, accuracy, battery, speed, altitude, and last-seen time
- **Sidebar** — lists all tracked devices with their latest stats; click a device to pan the map to it
- **Log bar** — full-width panel at the bottom of the page showing the last 10 device updates
- **Auto-reconnect** — browser WebSocket reconnects automatically if the connection drops

## Device update log

Every location update is appended to `mapper.log` in the project root:

```
[2026-04-16 14:23:45] device1 → 51.50123, -0.12345 batt=85% spd=12.3km/h acc=±5m alt=32m
```

The log bar at the bottom of the browser UI shows the last 10 lines and is populated immediately on page load by replaying recent entries from the server's in-memory buffer.
