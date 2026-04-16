const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const LOG_FILE = path.join(__dirname, 'mapper.log');
const NICKNAMES_FILE = path.join(__dirname, 'nicknames.json');
const GPX_DIR = path.join(__dirname, 'gpx');

// ── Nicknames ─────────────────────────────────────────────────────────────────
// Persisted to nicknames.json so GPX filenames survive server restarts.
let nicknames = {};
try { nicknames = JSON.parse(fs.readFileSync(NICKNAMES_FILE, 'utf8')); } catch {}

function saveNicknames() {
  fs.writeFileSync(NICKNAMES_FILE, JSON.stringify(nicknames, null, 2));
}

// ── GPX tracking ──────────────────────────────────────────────────────────────
// In-memory trackpoints per device per date. Loaded from existing files on
// first access so a server restart doesn't overwrite the day's track.
// Structure: Map<deviceId, Map<dateStr, Array<{lat,lon,ele,spd,time}>>>
const trackpoints = new Map();

function dateStr(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function safeName(str) {
  // Strip characters illegal on Windows/Linux filenames
  return str.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

function gpxFilePath(deviceId, date) {
  const nick = nicknames[deviceId];
  const base = nick ? `${safeName(nick)} - ${safeName(deviceId)}` : safeName(deviceId);
  return path.join(GPX_DIR, date, `${base}.gpx`);
}

function loadExistingPoints(deviceId, date) {
  // Read today's file (if any) and parse trackpoints so a restart doesn't lose them.
  try {
    const content = fs.readFileSync(gpxFilePath(deviceId, date), 'utf8');
    const points = [];
    const re = /<trkpt lat="([^"]+)" lon="([^"]+)">([\s\S]*?)<\/trkpt>/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const inner = m[3];
      points.push({
        lat: parseFloat(m[1]),
        lon: parseFloat(m[2]),
        ele: inner.match(/<ele>([^<]+)<\/ele>/)?.[1] ?? null,
        spd: inner.match(/<speed>([^<]+)<\/speed>/)?.[1] ?? null,
        time: inner.match(/<time>([^<]+)<\/time>/)?.[1] ?? new Date().toISOString(),
      });
    }
    return points;
  } catch {
    return [];
  }
}

function writeGpx(deviceId, date) {
  const points = trackpoints.get(deviceId)?.get(date);
  if (!points || points.length === 0) return;

  const filePath = gpxFilePath(deviceId, date);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const label = nicknames[deviceId] || deviceId;
  const trkpts = points.map(p => {
    let s = `    <trkpt lat="${p.lat}" lon="${p.lon}">`;
    if (p.ele != null) s += `\n      <ele>${p.ele}</ele>`;
    s += `\n      <time>${p.time}</time>`;
    if (p.spd != null) s += `\n      <extensions><speed>${parseFloat(p.spd).toFixed(3)}</speed></extensions>`;
    s += `\n    </trkpt>`;
    return s;
  }).join('\n');

  const gpx =
`<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Mapper" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><desc>${deviceId}</desc></metadata>
  <trk>
    <name>${label} (${deviceId}) \u2014 ${date}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;

  fs.writeFileSync(filePath, gpx, 'utf8');
}

function addTrackpoint(data) {
  const date = dateStr(data.timestamp);
  if (!trackpoints.has(data.deviceId)) trackpoints.set(data.deviceId, new Map());
  const devMap = trackpoints.get(data.deviceId);
  if (!devMap.has(date)) devMap.set(date, loadExistingPoints(data.deviceId, date));
  devMap.get(date).push({
    lat: data.lat,
    lon: data.lon,
    ele: data.alt,
    spd: data.spd,
    time: new Date(data.timestamp).toISOString(),
  });
  writeGpx(data.deviceId, date);
  broadcast({
    type: 'trackpoint',
    deviceId: data.deviceId,
    lat: data.lat,
    lon: data.lon,
    time: new Date(data.timestamp).toISOString(),
  });
}

// Pre-load today's GPX files into the trackpoints Map so browsers connecting
// right after a server restart still receive the full day's history.
function preloadTodayTracks() {
  const today = dateStr(Date.now());
  const dir = path.join(GPX_DIR, today);
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir).filter(f => f.endsWith('.gpx')).forEach(file => {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      const m = content.match(/<metadata>\s*<desc>([^<]+)<\/desc>\s*<\/metadata>/);
      if (!m) return;
      const deviceId = m[1];
      if (!trackpoints.has(deviceId)) trackpoints.set(deviceId, new Map());
      const devMap = trackpoints.get(deviceId);
      if (!devMap.has(today)) {
        const points = loadExistingPoints(deviceId, today);
        devMap.set(today, points);
      }
    } catch {}
  });
}

// Ring buffer of the last 100 log lines for replaying to new connections
const logBuffer = [];

function logUpdate(data) {
  const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const parts = [`[${time}] ${data.deviceId} →`];
  parts.push(`${data.lat.toFixed(5)}, ${data.lon.toFixed(5)}`);
  if (data.batt !== null) parts.push(`batt=${data.batt}%`);
  if (data.spd !== null) parts.push(`spd=${(data.spd * 3.6).toFixed(1)}km/h`);
  if (data.acc !== null) parts.push(`acc=±${data.acc}m`);
  if (data.alt !== null) parts.push(`alt=${data.alt}m`);
  const line = parts.join(' ');

  fs.appendFile(LOG_FILE, line + '\n', () => {});
  logBuffer.push(line);
  if (logBuffer.length > 100) logBuffer.shift();
  broadcast({ type: 'log', message: line });
}

const app = express();
// Wrap Express in a plain http.Server so we can share it with the WebSocket server
const server = http.createServer(app);
// WebSocket server mounted at /ws on the same port as HTTP
const wss = new WebSocket.Server({ server, path: '/ws' });

// In-memory store of the latest location for each device.
// Key: deviceId (phone serial from GPSLogger %SER token)
// Value: location object { deviceId, lat, lon, acc, batt, spd, alt, timestamp }
const devices = new Map();

// Populate trackpoints from today's GPX files before accepting connections
preloadTodayTracks();

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
  logUpdate(data);
  addTrackpoint(data);

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
  logUpdate(data);
  addTrackpoint(data);

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
  // Send today's full track for each device so the polyline is drawn immediately
  const today = dateStr(Date.now());
  trackpoints.forEach((devMap, deviceId) => {
    const points = devMap.get(today);
    if (points && points.length > 0) {
      ws.send(JSON.stringify({
        type: 'track',
        deviceId,
        points: points.map(p => ({ lat: p.lat, lon: p.lon })),
      }));
    }
  });
  // Replay the last 10 log lines so the bar is populated immediately
  logBuffer.slice(-10).forEach(line => {
    ws.send(JSON.stringify({ type: 'log', message: line }));
  });
});

// Expose the app version from package.json
const { version } = require('./package.json');
app.get('/version', (req, res) => res.json({ version }));

// Today's full track for all devices — used by the browser on initial load.
// Returns { deviceId: [{lat, lon, time}, …], … }
app.get('/tracks', (req, res) => {
  const today = dateStr(Date.now());
  const result = {};
  trackpoints.forEach((devMap, deviceId) => {
    const pts = devMap.get(today);
    if (pts && pts.length > 0) {
      result[deviceId] = pts.map(p => ({ lat: p.lat, lon: p.lon, time: p.time }));
    }
  });
  res.json(result);
});

// Nickname endpoints — browser POSTs when user sets/clears a nickname.
// Stored server-side so GPX filenames are correct even before the browser loads.
app.get('/nicknames', (req, res) => res.json(nicknames));

app.post('/nickname', (req, res) => {
  const { deviceId, nickname } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  const today = dateStr(Date.now());

  // Rename today's GPX file if it already exists under the old name
  const oldPath = gpxFilePath(deviceId, today);
  const oldExists = fs.existsSync(oldPath);

  if (nickname) {
    nicknames[deviceId] = nickname;
  } else {
    delete nicknames[deviceId];
  }
  saveNicknames();

  if (oldExists) {
    const newPath = gpxFilePath(deviceId, today);
    if (oldPath !== newPath) {
      try { fs.renameSync(oldPath, newPath); } catch {}
    }
  }

  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Mapper server running at http://localhost:${PORT}`);
  console.log(`Test with: http://localhost:${PORT}/location?lat=51.5&lon=-0.1&device=test1&acc=5&batt=80&spd=0&alt=10`);
});
