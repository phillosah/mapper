// ─────────────────────────────────────────────────────────────────────────────
// Mapper — server.js
//
// Node.js HTTP + WebSocket server that:
//   • Receives GPS location updates from GPSLogger (Android) and OwnTracks (iOS)
//   • Broadcasts live updates to every connected browser via WebSocket
//   • Writes per-device per-day GPX track files to disk
//   • Persists device nicknames to nicknames.json
//   • Serves the static frontend from public/
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');
const fs      = require('fs');

// ── File paths ────────────────────────────────────────────────────────────────

const LOG_FILE       = path.join(__dirname, 'mapper.log');   // append-only update log
const NICKNAMES_FILE = path.join(__dirname, 'nicknames.json'); // { deviceId: nickname }
const GPX_DIR        = path.join(__dirname, 'gpx');           // gpx/<date>/<name>.gpx

// ── Nicknames ─────────────────────────────────────────────────────────────────
// Nicknames are stored server-side so GPX filenames stay consistent even when
// the browser hasn't loaded yet or a different browser is used.

let nicknames = {};
try {
  // Silently ignore if the file doesn't exist yet (first run)
  nicknames = JSON.parse(fs.readFileSync(NICKNAMES_FILE, 'utf8'));
} catch {}

function saveNicknames() {
  fs.writeFileSync(NICKNAMES_FILE, JSON.stringify(nicknames, null, 2));
}

// ── GPX tracking ──────────────────────────────────────────────────────────────
// In-memory store of all trackpoints for the current day, organised as:
//   Map<deviceId, Map<dateStr, Array<{ lat, lon, ele, acc, spd, time }>>>
//
// Points are accumulated here first, then written to disk as a full GPX file
// on every update (simple and keeps the file always valid).
const trackpoints = new Map();

// Returns a YYYY-MM-DD string for a given Unix timestamp (local UTC date)
function dateStr(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

// Removes characters that are illegal in filenames on Windows and Linux
function safeName(str) {
  return str.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

// Builds the full path for a device's GPX file for a given date.
// Example: gpx/2026-04-16/Phil - ABC123.gpx
function gpxFilePath(deviceId, date) {
  const nick = nicknames[deviceId];
  const base = nick
    ? `${safeName(nick)} - ${safeName(deviceId)}`
    : safeName(deviceId);
  return path.join(GPX_DIR, date, `${base}.gpx`);
}

// Writes the complete in-memory point list for a device+date to a GPX file.
// Called after every new trackpoint so the file on disk is always up to date.
function writeGpx(deviceId, date) {
  const points = trackpoints.get(deviceId)?.get(date);
  if (!points || points.length === 0) return;

  const filePath = gpxFilePath(deviceId, date);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const label = nicknames[deviceId] || deviceId;

  // Build the <trkpt> elements, including optional elevation and speed
  const trkpts = points.map(p => {
    let s = `    <trkpt lat="${p.lat}" lon="${p.lon}">`;
    if (p.ele != null) s += `\n      <ele>${p.ele}</ele>`;
    s += `\n      <time>${p.time}</time>`;
    if (p.spd != null) {
      s += `\n      <extensions><speed>${parseFloat(p.spd).toFixed(3)}</speed></extensions>`;
    }
    s += `\n    </trkpt>`;
    return s;
  }).join('\n');

  // The <metadata><desc> tag stores the raw deviceId so the file can be
  // re-associated with a device after a server restart (see preloadTodayTracks)
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

// Adds a new trackpoint for a device, then rewrites its GPX file and
// broadcasts the new point to all connected browsers.
function addTrackpoint(data) {
  const date = dateStr(data.timestamp);

  // Initialise the nested Map structure on first encounter
  if (!trackpoints.has(data.deviceId)) trackpoints.set(data.deviceId, new Map());
  const devMap = trackpoints.get(data.deviceId);

  // On first point of the day, load any existing points from disk.
  // preloadTodayTracks() handles this at startup, but this is a safety net
  // for devices not yet in the Map (e.g. a brand-new device mid-day).
  if (!devMap.has(date)) devMap.set(date, loadExistingPoints(data.deviceId, date));

  devMap.get(date).push({
    lat:  data.lat,
    lon:  data.lon,
    ele:  data.alt,   // altitude in metres
    acc:  data.acc,   // GPS accuracy in metres (not stored in GPX, kept in memory)
    spd:  data.spd,   // speed in m/s
    time: new Date(data.timestamp).toISOString(),
  });

  writeGpx(data.deviceId, date);

  // Push the new point to all open browser tabs so polylines update live
  broadcast({
    type:     'trackpoint',
    deviceId: data.deviceId,
    lat:      data.lat,
    lon:      data.lon,
    acc:      data.acc,
    time:     new Date(data.timestamp).toISOString(),
  });
}

// Scans today's GPX folder on startup and populates the in-memory trackpoints
// Map. This means browsers connecting right after a server restart still get
// the full day's trail via GET /tracks.
function preloadTodayTracks() {
  const today = dateStr(Date.now());
  const dir   = path.join(GPX_DIR, today);
  if (!fs.existsSync(dir)) return;

  fs.readdirSync(dir).filter(f => f.endsWith('.gpx')).forEach(file => {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');

      // Primary: deviceId is stored in <metadata><desc>deviceId</desc></metadata>
      let deviceId = (content.match(/<metadata>\s*<desc>([^<]+)<\/desc>\s*<\/metadata>/) || [])[1];

      // Fallback for older files: extract from <name>Label (deviceId) — date</name>
      if (!deviceId) {
        deviceId = (content.match(/<name>[^(]*\(([^)]+)\)/) || [])[1];
      }

      if (!deviceId) return; // can't identify device — skip

      if (!trackpoints.has(deviceId)) trackpoints.set(deviceId, new Map());
      const devMap = trackpoints.get(deviceId);

      if (!devMap.has(today)) {
        // Parse all <trkpt> elements from the file content already in memory
        const points = [];
        const re = /<trkpt lat="([^"]+)" lon="([^"]+)">([\s\S]*?)<\/trkpt>/g;
        let m;
        while ((m = re.exec(content)) !== null) {
          const inner = m[3];
          points.push({
            lat:  parseFloat(m[1]),
            lon:  parseFloat(m[2]),
            ele:  (inner.match(/<ele>([^<]+)<\/ele>/)      || [])[1] ?? null,
            acc:  null, // accuracy is not written to GPX files
            spd:  (inner.match(/<speed>([^<]+)<\/speed>/)  || [])[1] ?? null,
            time: (inner.match(/<time>([^<]+)<\/time>/)    || [])[1] ?? new Date().toISOString(),
          });
        }
        devMap.set(today, points);
      }
    } catch {
      // Skip unreadable or malformed files silently
    }
  });
}

// ── Ring buffer for log replay ────────────────────────────────────────────────
// Keeps the last 100 log lines in memory so new browser tabs can see recent
// activity without waiting for the next GPS ping.
const logBuffer = [];

// Formats and appends a location update to mapper.log, stores it in the ring
// buffer, and broadcasts it to all browsers as a 'log' WebSocket message.
function logUpdate(data) {
  const time  = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const parts = [`[${time}] ${data.deviceId} \u2192`];
  parts.push(`${data.lat.toFixed(5)}, ${data.lon.toFixed(5)}`);
  if (data.batt !== null) parts.push(`batt=${data.batt}%`);
  if (data.spd  !== null) parts.push(`spd=${(data.spd * 3.6).toFixed(1)}km/h`);
  if (data.acc  !== null) parts.push(`acc=\u00b1${data.acc}m`);
  if (data.alt  !== null) parts.push(`alt=${data.alt}m`);
  const line = parts.join(' ');

  fs.appendFile(LOG_FILE, line + '\n', () => {}); // non-blocking disk write
  logBuffer.push(line);
  if (logBuffer.length > 100) logBuffer.shift();  // evict oldest entry
  broadcast({ type: 'log', message: line });
}

// ── Express + WebSocket server ────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app); // shared HTTP server for both Express and WS
const wss    = new WebSocket.Server({ server, path: '/ws' });

// In-memory store of the *latest* location for each device.
// Used to replay current positions to browsers that connect mid-session.
// Key: deviceId   Value: { deviceId, lat, lon, acc, batt, spd, alt, timestamp }
const devices = new Map();

// Read today's GPX files into memory before the server starts accepting
// connections, so GET /tracks returns data immediately after a restart
preloadTodayTracks();

// Serve index.html and any static assets (JS, CSS, images) from public/
app.use(express.static(path.join(__dirname, 'public')));
// Parse JSON request bodies (used by POST /owntracks and POST /nickname)
app.use(express.json());

// ── GPS input endpoints ───────────────────────────────────────────────────────

// GET /location — called by GPSLogger on Android.
// GPSLogger substitutes tokens like %LAT, %LON, %SER before sending, so the
// server receives plain numeric strings in the query string.
app.get('/location', (req, res) => {
  const { lat, lon, device, acc, batt, spd, alt } = req.query;

  if (!lat || !lon) {
    return res.status(400).send('Missing lat/lon');
  }

  // Use the phone's serial number as the device ID; fall back to its IP address
  const deviceId = device || req.ip || 'unknown';

  const data = {
    deviceId,
    lat:  parseFloat(lat),
    lon:  parseFloat(lon),
    acc:  acc  ? parseFloat(acc)  : null, // GPS accuracy in metres
    batt: batt ? parseFloat(batt) : null, // battery percentage 0–100
    spd:  spd  ? parseFloat(spd)  : null, // speed in m/s (GPSLogger unit)
    alt:  alt  ? parseFloat(alt)  : null, // altitude in metres
    timestamp: Date.now(),
  };

  devices.set(deviceId, data);           // update latest-position store
  broadcast({ type: 'location', ...data }); // push to all open browsers
  logUpdate(data);                       // append to mapper.log
  addTrackpoint(data);                   // append to GPX file

  res.send('OK'); // GPSLogger only checks for HTTP 200; body is ignored
});

// POST /owntracks — called by OwnTracks on iOS or Android.
// OwnTracks sends a JSON body for several event types; we only care about
// _type === 'location'. All other types are acknowledged and ignored.
app.post('/owntracks', (req, res) => {
  const body = req.body;

  if (!body || body._type !== 'location') {
    return res.json([]); // OwnTracks expects an empty array for non-location events
  }

  const { lat, lon, tid, batt, vel, alt, acc } = body;

  if (!lat || !lon) {
    return res.status(400).json([]);
  }

  // tid is the short "tracker ID" configured in the OwnTracks app settings
  const deviceId = tid || req.ip || 'unknown';

  const data = {
    deviceId,
    lat:  parseFloat(lat),
    lon:  parseFloat(lon),
    acc:  acc  != null ? parseFloat(acc)         : null,
    batt: batt != null ? parseFloat(batt)        : null,
    spd:  vel  != null ? parseFloat(vel) / 3.6   : null, // OwnTracks sends km/h; convert to m/s
    alt:  alt  != null ? parseFloat(alt)         : null,
    timestamp: Date.now(),
  };

  devices.set(deviceId, data);
  broadcast({ type: 'location', ...data });
  logUpdate(data);
  addTrackpoint(data);

  res.json([]); // OwnTracks protocol requires an empty JSON array response
});

// ── WebSocket broadcast ───────────────────────────────────────────────────────

// Sends a JSON message to every browser tab that is currently connected.
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// When a new browser tab connects, immediately send it:
//   1. The latest known position for every tracked device → markers appear instantly
//   2. Today's full track for every device → polylines and history dots appear
//   3. The last 10 log lines → log bar shows recent activity straight away
//
// Pushing tracks over the WebSocket (rather than having the browser fetch /tracks
// separately) is more reliable: a single connection delivers everything atomically,
// with no race between the HTTP response and incoming WS messages.
wss.on('connection', ws => {
  // ① Replay current device positions so markers appear immediately
  devices.forEach(data => {
    ws.send(JSON.stringify({ type: 'location', ...data }));
  });

  // ② Push today's full track for every device so the polylines are drawn
  const tracks = getTodayTracks();
  Object.entries(tracks).forEach(([deviceId, points]) => {
    ws.send(JSON.stringify({ type: 'track', deviceId, points }));
  });

  // ③ Replay the most recent log entries
  logBuffer.slice(-10).forEach(line => {
    ws.send(JSON.stringify({ type: 'log', message: line }));
  });
});

// ── REST API endpoints ────────────────────────────────────────────────────────

// GET /version — returns the app version from package.json.
// The browser displays this in the sidebar header.
const { version } = require('./package.json');
app.get('/version', (req, res) => res.json({ version }));

// getTodayTracks — builds the full point list for every device for today.
// Reads directly from GPX files on disk so it works even after a server restart
// (preloadTodayTracks() populates memory, but disk is the ground truth).
// In-memory points not yet flushed to disk are merged in on top.
// Returns: { deviceId: [{ lat, lon, time, acc }, …], … }
function getTodayTracks() {
  const today  = dateStr(Date.now());
  const result = {};

  // ① Read every GPX file in today's folder from disk
  const dir = path.join(GPX_DIR, today);
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).filter(f => f.endsWith('.gpx')).forEach(file => {
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');

        // Identify the device from <metadata><desc>deviceId</desc>
        let deviceId = (content.match(/<metadata>\s*<desc>([^<]+)<\/desc>\s*<\/metadata>/) || [])[1];
        // Fallback: extract from <name>Label (deviceId) — date</name>
        if (!deviceId) {
          deviceId = (content.match(/<name>[^(]*\(([^)]+)\)/) || [])[1];
        }
        if (!deviceId) return;

        const points = [];
        const re = /<trkpt lat="([^"]+)" lon="([^"]+)">([\s\S]*?)<\/trkpt>/g;
        let m;
        while ((m = re.exec(content)) !== null) {
          const inner = m[3];
          points.push({
            lat:  parseFloat(m[1]),
            lon:  parseFloat(m[2]),
            time: (inner.match(/<time>([^<]+)<\/time>/)   || [])[1] ?? new Date().toISOString(),
            acc:  null, // accuracy radius is not persisted in GPX
          });
        }

        if (points.length > 0) result[deviceId] = points;
      } catch {}
    });
  }

  // ② Merge any in-memory points not yet on disk (writeGpx is synchronous so
  //    this mainly catches the very latest point during a concurrent request)
  trackpoints.forEach((devMap, deviceId) => {
    const pts = devMap.get(today);
    if (!pts || pts.length === 0) return;
    const diskCount = result[deviceId]?.length ?? 0;
    const extra = pts.slice(diskCount).map(p => ({
      lat: p.lat, lon: p.lon, time: p.time, acc: p.acc ?? null,
    }));
    if (extra.length > 0) {
      result[deviceId] = [...(result[deviceId] || []), ...extra];
    }
  });

  return result;
}

// GET /tracks — HTTP endpoint returning today's tracks (kept for diagnostics /
// external tooling; the browser now receives tracks via WebSocket on connect).
app.get('/tracks', (req, res) => res.json(getTodayTracks()));

// GET /gpx/:deviceId — serves today's GPX file for a single device as a
// file download. The browser triggers this when the ⇩ button is clicked.
app.get('/gpx/:deviceId', (req, res) => {
  const deviceId = req.params.deviceId;
  const today    = dateStr(Date.now());
  const filePath = gpxFilePath(deviceId, today);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('No track for this device today');
  }

  const filename = path.basename(filePath);
  res.setHeader('Content-Type', 'application/gpx+xml');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.sendFile(filePath);
});

// GET /nicknames — returns the full nickname map { deviceId: nickname }.
// The browser merges this with its localStorage copy on page load so
// nicknames set from one browser are visible on all others.
app.get('/nicknames', (req, res) => res.json(nicknames));

// POST /nickname — sets or clears a nickname for a device.
// Body: { deviceId: string, nickname: string | null }
// Also renames today's GPX file if it already exists under the old name.
app.post('/nickname', (req, res) => {
  const { deviceId, nickname } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  const today = dateStr(Date.now());

  // Capture the path under the *old* nickname before changing it
  const oldPath   = gpxFilePath(deviceId, today);
  const oldExists = fs.existsSync(oldPath);

  // Update the in-memory map and persist to disk
  if (nickname) {
    nicknames[deviceId] = nickname;
  } else {
    delete nicknames[deviceId];
  }
  saveNicknames();

  // Rename the GPX file so it matches the new nickname immediately
  if (oldExists) {
    const newPath = gpxFilePath(deviceId, today);
    if (oldPath !== newPath) {
      try { fs.renameSync(oldPath, newPath); } catch {}
    }
  }

  res.json({ ok: true });
});

// ── Start server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Mapper server running at http://localhost:${PORT}`);
  console.log(`Test with: http://localhost:${PORT}/location?lat=51.5&lon=-0.1&device=test1&acc=5&batt=80&spd=0&alt=10`);
});
