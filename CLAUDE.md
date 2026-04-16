# Mapper — Claude Code Instructions

Real-time GPS location tracker built with Node.js (Express + WebSocket) and Leaflet.js.

## Versioning

Version format: `YYYY.MM.DD.R` where `R` is a zero-based daily revision number.

- **2026.04.16.0** — first change on that date
- **2026.04.16.1** — second change on that date

Update `package.json` `"version"` field on every meaningful change. The version is served via `GET /version` and displayed in the browser header automatically — no other files need changing.

```bash
# Example: first revision on 16 April 2026
"version": "2026.04.16.0"
```

## Git workflow

After every task that changes code or docs:

1. Stage only the files that were changed (never `git add -A` blindly — `.claude/`, `*.lock`, `*.log`, `gpx/`, `nicknames.json` must not be committed)
2. Commit with a concise message describing *why*, not just *what*
3. Push to `origin/master`

Files that must never be committed:
- `.claude/`
- `.~lock.*`
- `mapper.log`
- `nicknames.json`
- `gpx/`

A `.gitignore` should cover these if not already present.

## Project structure

```
Mapper/
├── server.js           # Express + WebSocket server (port 3000)
├── package.json        # Version lives here
├── public/
│   └── index.html      # Single-file frontend (Leaflet.js, no build step)
├── mapper.log          # Device update log — auto-created, do not commit
├── nicknames.json      # Nickname store — auto-created, do not commit
├── gpx/                # GPX tracks by date — auto-created, do not commit
│   └── YYYY-MM-DD/
│       └── Nickname - DeviceID.gpx
├── README.md
├── CLAUDE.md           # This file
└── Mapper_VPS_Deployment.docx
```

## Key conventions

### Device data flow
1. Phone → `GET /location` (GPSLogger) or `POST /owntracks` (OwnTracks)
2. Server stores latest position in `devices` Map, writes GPX trackpoint, appends to `mapper.log`
3. Server broadcasts WebSocket messages: `location`, `trackpoint`, `log`
4. Browser connects via WebSocket + fetches `/tracks` (history) and `/nicknames` on load

### Nicknames
- Stored server-side in `nicknames.json` — survives restarts
- `GET /nicknames` — browser merges on load
- `POST /nickname { deviceId, nickname }` — browser POSTs on every change
- Renaming a device renames today's GPX file automatically

### GPX files
- Written to `gpx/<YYYY-MM-DD>/<Nickname> - <DeviceID>.gpx`
- Filename uses `safeName()` to strip illegal characters
- `<metadata><desc>deviceId</desc>` embedded so files can be re-associated after restart
- `preloadTodayTracks()` runs at startup — reads today's files into memory

### WebSocket message types
| type | direction | payload |
|------|-----------|---------|
| `location` | server → browser | full device data |
| `trackpoint` | server → browser | `{ deviceId, lat, lon, time }` |
| `track` | server → browser | `{ deviceId, points: [{lat,lon}] }` (on connect) |
| `log` | server → browser | `{ message }` (last 10 replayed on connect) |

### REST endpoints
| method | path | purpose |
|--------|------|---------|
| GET | `/location` | GPSLogger update |
| POST | `/owntracks` | OwnTracks update |
| GET | `/version` | App version from package.json |
| GET | `/tracks` | Today's full track for all devices |
| GET | `/gpx/:deviceId` | Download today's GPX for one device |
| GET | `/nicknames` | All stored nicknames |
| POST | `/nickname` | Set/clear a nickname |

## Documentation

When features are added or changed, update **both**:
1. `README.md` — user-facing feature list and file structure
2. `Mapper_VPS_Deployment.docx` — deployment guide (use the `anthropic-skills:docx` skill)

## Deployment target

Red Hat / RHEL / CentOS / Fedora VPS running Node.js 20 via PM2. See `Mapper_VPS_Deployment.docx` for full steps.
