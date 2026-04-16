const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
// Wrap Express in a plain http.Server so we can share it with the WebSocket server
const server = http.createServer(app);
// WebSocket server mounted at /ws on the same port as HTTP
const wss = new WebSocket.Server({ server, path: '/ws' });

// In-memory store of the latest location for each device.
// Key: deviceId (phone serial from GPSLogger %SER token)
// Value: location object { deviceId, lat, lon, acc, batt, spd, alt, timestamp }
const devices = new Map();

// Serve index.html and any other static assets from the public/ folder
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Location endpoint — called by GPSLogger on each phone.
// GPSLogger substitutes %LAT, %LON, %SER etc. before sending the request,
// so the server receives plain numeric values in the query string.
app.get('/location', (req, res) => {
  const { lat, lon, device, acc, batt, spd, alt } = req.query;

  // lat and lon are the only fields required to place a marker
  if (!lat || !lon) {
    return res.status(400).send('Missing lat/lon');
  }

  // Fall back to the request IP if GPSLogger didn't send a device ID
  const deviceId = device || req.ip || 'unknown';

  const data = {
    deviceId,
    lat: parseFloat(lat),
    lon: parseFloat(lon),
    // Optional fields — stored as null when absent so the frontend can skip them
    acc: acc ? parseFloat(acc) : null,   // GPS accuracy in metres
    batt: batt ? parseFloat(batt) : null, // Battery percentage
    spd: spd ? parseFloat(spd) : null,   // Speed in m/s (GPSLogger unit)
    alt: alt ? parseFloat(alt) : null,   // Altitude in metres
    timestamp: Date.now(),
  };

  // Overwrite the previous position for this device
  devices.set(deviceId, data);

  // Push the update to every browser that is currently connected
  broadcast({ type: 'location', ...data });

  // GPSLogger only checks for a 200 status; the body content doesn't matter
  res.send('OK');
});

// Location endpoint — called by OwnTracks on iOS/Android.
// OwnTracks sends a JSON POST body: { _type, lat, lon, tid, batt, vel, alt, acc, ... }
// tid is a short 2-char tracker ID configured in the OwnTracks app.
app.post('/owntracks', (req, res) => {
  const body = req.body;

  if (!body || body._type !== 'location') {
    // OwnTracks also posts 'transition', 'waypoint', etc. — silently ignore them
    return res.json([]);
  }

  const { lat, lon, tid, batt, vel, alt, acc } = body;

  if (!lat || !lon) {
    return res.status(400).json([]);
  }

  const deviceId = tid || req.ip || 'unknown';

  const data = {
    deviceId,
    lat: parseFloat(lat),
    lon: parseFloat(lon),
    acc: acc != null ? parseFloat(acc) : null,
    batt: batt != null ? parseFloat(batt) : null,
    spd: vel != null ? parseFloat(vel) / 3.6 : null, // OwnTracks sends km/h, store as m/s
    alt: alt != null ? parseFloat(alt) : null,
    timestamp: Date.now(),
  };

  devices.set(deviceId, data);
  broadcast({ type: 'location', ...data });

  // OwnTracks expects an empty JSON array response
  res.json([]);
});

// Send a JSON message to every open WebSocket connection
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// When a new browser tab connects, send it the current position of every
// known device so the map is populated immediately without waiting for the
// next GPSLogger ping from each phone.
wss.on('connection', ws => {
  devices.forEach(data => {
    ws.send(JSON.stringify({ type: 'location', ...data }));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Mapper server running at http://localhost:${PORT}`);
  console.log(`Test with: http://localhost:${PORT}/location?lat=51.5&lon=-0.1&device=test1&acc=5&batt=80&spd=0&alt=10`);
});
