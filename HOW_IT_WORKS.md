# How Mapper Works

## Overview

Mapper is a three-part system: a phone app that sends GPS data, a Node.js server that receives and relays it, and a browser-based map that displays it live. The three parts communicate over standard HTTP and WebSocket connections.

Two phone clients are supported:

- **GPSLogger** (Android) — sends a GET request with coordinates as query parameters
- **OwnTracks** (iOS and Android) — sends a POST request with a JSON body

```
┌─────────────────────┐   HTTP GET /location    ┌─────────────────────┐
│   Android Phone     │ ──────────────────────► │   Node.js Server    │
│   (GPSLogger)       │  ?lat=&lon=&device=...  │   (server.js)       │
└─────────────────────┘                         └─────────┬───────────┘
                                                          │ WebSocket
┌─────────────────────┐   HTTP POST /owntracks            │ broadcast
│   iOS/Android Phone │ ──────────────────────►           │
│   (OwnTracks)       │  { _type, lat, lon, tid, ... }   │
└─────────────────────┘                         ┌─────────▼───────────┐
                                                 │   Browser           │
                                                 │   (index.html)      │
                                                 │   Leaflet.js map    │
                                                 └─────────────────────┘
```

---

## Part 1 — The Phone

Two apps are supported, each using a different protocol.

### GPSLogger (Android)

GPSLogger is a free Android app that reads the phone's GPS sensor and reports the position via HTTP. Mapper uses its **Custom URL** option, which sends a GET request to a URL you specify on each logging interval.

In GPSLogger's settings you enter a URL template containing placeholder tokens:

```
http://192.168.1.42:3000/location?lat=%LAT&lon=%LON&device=%SER&acc=%ACC&batt=%BTT&spd=%SPD&alt=%ALT
```

Before sending, GPSLogger replaces each `%TOKEN` with the real sensor value:

| Token  | Replaced with                           |
|--------|-----------------------------------------|
| `%LAT` | Latitude (decimal degrees)              |
| `%LON` | Longitude (decimal degrees)             |
| `%SER` | Device serial number (unique per phone) |
| `%ACC` | GPS accuracy radius in metres           |
| `%BTT` | Battery level as a percentage           |
| `%SPD` | Speed in metres per second              |
| `%ALT` | Altitude in metres above sea level      |

So the actual request looks like:

```
GET /location?lat=51.50740&lon=-0.12780&device=RF8N12345AB&acc=4.2&batt=73&spd=0.3&alt=11
```

### OwnTracks (iOS and Android)

OwnTracks is a free, open-source app available on both iOS (App Store) and Android. Mapper uses its **HTTP mode**, which sends a JSON POST request after each position fix.

The request body follows the [OwnTracks location payload](https://owntracks.org/booklet/tech/http/) format:

```json
POST /owntracks
{
  "_type": "location",
  "lat": 51.50740,
  "lon": -0.12780,
  "tid": "Ph",
  "batt": 73,
  "vel": 1,
  "acc": 4,
  "alt": 11
}
```

The `tid` field (Tracker ID) is a short label you configure in the app and is used as the device name on the map. OwnTracks sends speed (`vel`) in km/h; the server converts it to m/s to match the GPSLogger format.

### Timing

Both apps send updates on a configurable interval (e.g. every 10–30 seconds). A shorter interval means more up-to-date positions on the map at the cost of higher battery and data usage.

---

## Part 2 — The Node.js Server (server.js)

The server is the central hub. It receives position data from phones and delivers it to browsers.

### HTTP and WebSocket on one port

The server uses Node's built-in `http` module to create a single server that handles two different protocols on the same port (3000):

- **HTTP** — serves the web page and receives location updates from phones
- **WebSocket** — maintains persistent connections with browsers for real-time push

```
port 3000
  ├── HTTP  GET  /            → serves public/index.html
  ├── HTTP  GET  /location    → receives GPS data from GPSLogger
  ├── HTTP  POST /owntracks   → receives GPS data from OwnTracks
  └── WS         /ws          → real-time channel to browsers
```

### Receiving a location update

Both endpoints validate, normalise, store, and broadcast data in the same way. The difference is where the values come from.

**`GET /location` (GPSLogger):**

1. **Validates** that `lat` and `lon` query parameters are present.
2. **Parses** all values from strings to numbers. Optional fields are stored as `null` when absent.
3. **Stores** the location in a `Map` keyed by `deviceId` (the `device` query param, falling back to the request IP).
4. **Broadcasts** the data to every connected browser.
5. **Responds** `200 OK`.

**`POST /owntracks` (OwnTracks):**

1. **Ignores** non-location payloads (`_type !== 'location'`) — OwnTracks also posts waypoints, transitions, etc.
2. **Validates** that `lat` and `lon` are present in the JSON body.
3. **Normalises** fields to the same shape: `tid` → `deviceId`, `vel` (km/h) ÷ 3.6 → `spd` (m/s).
4. **Stores**, **broadcasts**, and **responds** the same as the GPSLogger endpoint, except the response body is `[]` (required by the OwnTracks protocol).

```
Phone request (either endpoint)
        │
        ▼
  validate lat/lon
        │
        ▼
  normalise to common data shape
        │
        ├──► devices.set(deviceId, data)   ← update in-memory store
        │
        ├──► broadcast(data)               ← push to all browsers
        │
        └──► res.send(...)                 ← acknowledge to phone
```

### Broadcasting to browsers

The `broadcast` function iterates over all connected WebSocket clients and sends each one a JSON string. It checks `client.readyState === WebSocket.OPEN` before sending to skip clients that are mid-disconnect.

```javascript
// JSON sent to every browser on each phone update:
{
  "type": "location",
  "deviceId": "RF8N12345AB",
  "lat": 51.50740,
  "lon": -0.12780,
  "acc": 4.2,
  "batt": 73,
  "spd": 0.3,
  "alt": 11,
  "timestamp": 1711234567890
}
```

### Catching up new browser connections

When a browser opens the page for the first time, it connects to the WebSocket server. At that moment the server immediately sends the current stored position for every known device. This means the browser gets a complete picture of all tracked phones right away, without waiting for the next GPSLogger ping from each one.

---

## Part 3 — The Browser (public/index.html)

The browser page is a single HTML file. It has no build step or framework — just Leaflet.js (loaded from CDN) and plain JavaScript.

### Page layout

The page is split into two side-by-side panels using CSS flexbox:

```
┌──────────────┬──────────────────────────────────────┐
│   Sidebar    │                                      │
│  (260px)     │           Map (fills rest)           │
│              │                                      │
│ Device list  │       OpenStreetMap tiles            │
│              │       + markers                      │
│ [status bar] │                                      │
└──────────────┴──────────────────────────────────────┘
```

### The map

Leaflet.js initialises a map in the `#map` div, centred at latitude 20, longitude 0 (roughly the middle of the world) at zoom level 2. OpenStreetMap tiles are loaded from `tile.openstreetmap.org` — these are free raster image tiles that Leaflet stitches together into a scrollable, zoomable map.

### WebSocket connection

On page load, `connect()` opens a WebSocket to `ws://[same host]/ws`. The protocol is automatically switched to `wss://` (encrypted) when the page is served over HTTPS, so the app works securely without code changes.

If the connection drops (server restart, network glitch), the `onclose` handler waits 3 seconds and calls `connect()` again. Existing markers remain visible on the map during this gap — only new updates are missed.

### Handling location messages

Each WebSocket message contains a JSON location object (see the example above). The `onLocation` function processes it:

**First time a device is seen:**
```
create L.marker at [lat, lon]
bind a popup with device details
add marker to the map
if this is the very first device → pan map to it at zoom 14
```

**Device already has a marker:**
```
call marker.setLatLng([lat, lon])  ← moves the marker smoothly, no flicker
if popup is open → refresh its content with the latest values
```

This move-not-recreate approach is important. Removing and re-adding a marker would cause a visible flicker and lose the open/closed state of its popup.

### Two parallel data stores

The frontend maintains two separate objects:

| Object      | What it holds                          | Used for                        |
|-------------|----------------------------------------|---------------------------------|
| `markers`   | Leaflet marker instances, keyed by ID  | Moving dots on the map          |
| `deviceData`| Latest raw location data, keyed by ID  | Rendering the sidebar text      |

They are kept separate because the map and the sidebar need different things from the same data.

### The sidebar

`updateSidebar()` is called after every location update. It re-renders the entire device list from the current `deviceData` state. Each card shows:

- Device ID (phone serial number)
- Coordinates to 5 decimal places (~1 metre precision)
- Battery percentage, speed (converted from m/s to km/h), GPS accuracy
- Time of the last received update

Clicking a card calls `focusDevice(id)`, which pans and zooms the map to that device's last known position.

---

## Data flow: end to end

Here is the complete journey of a single location update, shown for both clients:

**GPSLogger (Android):**
```
1. GPSLogger timer fires on the phone
        │
2. GPS sensor reads lat/lon/acc/alt/spd
        │
3. GPSLogger substitutes tokens and sends:
   GET /location?lat=51.5&lon=-0.1&device=RF8N1234&...
        │
4. server.js /location handler
   - parses query params
   - updates devices Map
   - calls broadcast()
        │  (continues below)
```

**OwnTracks (iOS/Android):**
```
1. OwnTracks timer fires on the phone
        │
2. GPS sensor reads position and metadata
        │
3. OwnTracks sends:
   POST /owntracks  { "_type":"location", "lat":51.5, "lon":-0.1, "tid":"Ph", ... }
        │
4. server.js /owntracks handler
   - ignores non-location payloads
   - normalises tid→deviceId, vel→spd (km/h to m/s)
   - updates devices Map
   - calls broadcast()
        │  (continues below)
```

**Common path after broadcast:**
```
5. broadcast() sends JSON to all open WebSocket clients
        │
6. Browser WebSocket receives the message
   - onmessage fires
   - JSON.parse() decodes it
   - onLocation() is called
        │
7. onLocation()
   - updates deviceData[id]
   - moves or creates the Leaflet marker
   - calls updateSidebar()
        │
8. Map marker moves to new position
   Sidebar card updates with new values
   (all within ~100ms of the GPS reading)
```

---

## What happens when you open the page mid-session

If phones have been reporting for a while before you open the browser:

1. Browser loads `index.html` from the server
2. `connect()` opens a WebSocket to `/ws`
3. Server's `connection` handler immediately sends one message per known device
4. Browser processes each message and places a marker for every device
5. The map is fully populated before the next GPSLogger ping arrives

---

## Limitations

| Limitation | Detail |
|---|---|
| No history | Only the latest position per device is stored. Closing the server loses all data. |
| No authentication | Any device that can reach port 3000 can post a location. Suitable for trusted local networks only. |
| No persistence | Restarting the server clears all device positions. |
| Local network by default | Phones must be on the same network as the server, or the server must be exposed publicly (e.g. via ngrok or port forwarding). |
| Single position per device | If a phone sends two rapid updates, only the second is kept. |
