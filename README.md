# Philoproxy

A self-hosted proxy that authenticates with Philo (Widevine DRM), captures live
TV via `x11grab`, and re-serves every channel as a standard HLS stream — no DRM
headaches for your media server.

```
Philo (Widevine) → Playwright/Chromium → Xvfb → FFmpeg x11grab → HLS → Plex / Jellyfin / Dispatcharr
```

---

## Features

- **OTP login** — email or phone, no passwords stored
- **Playwright browser automation** — Chromium in a virtual framebuffer; no screen required
- **Per-channel PulseAudio isolation** — audio streams don't cross-contaminate
- **NVIDIA NVENC / Intel QSV / x264** — GPU-accelerated encoding detected at startup
- **Concurrent streams** — configurable cap (`MAX_PHILO_STREAMS`, default 3)
- **Auto-recovery** — FFmpeg and browser sessions restart automatically on failure
- **EPG** — Philo guide data fetched via GraphQL and served as XMLTV
- **HDHomeRun emulation** — Plex DVR and Dispatcharr auto-detect the lineup

---

## Quick start

### 1. Prerequisites

- Docker + Docker Compose
- NVIDIA GPU with `nvidia-container-toolkit` **or** Intel GPU (QSV profile)
- A Philo account

### 2. Configure

```bash
cp .env.example .env
# Edit DATA_DIR, TZ, MAX_PHILO_STREAMS, etc.
```

### 3. Run

```bash
# NVIDIA (default)
docker compose up -d

# Intel QSV
docker compose --profile intel up -d
```

### 4. Log in to Philo

Open the web UI at `http://<host>:5050`, go to **Sources → Add Source → Philo**,
and follow the OTP login flow.

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/channels.m3u` | M3U playlist of all Philo channels |
| `GET` | `/epg.xml` | XMLTV guide (48 h window by default) |
| `GET` | `/lineup.json` | HDHomeRun-compatible lineup |
| `GET` | `/discover.json` | HDHomeRun device discovery |
| `GET` | `/stream/:id/philo.m3u8` | HLS manifest for a channel |
| `GET` | `/stream/:id/philo-seg/:f` | HLS segment |
| `GET` | `/stream/status` | All active stream sessions |
| `GET` | `/stream/:id/health` | Per-stream diagnostics |
| `POST` | `/stream/:id/restart` | Restart a stream session |
| `DELETE` | `/stream/:id` | Stop a stream session |
| `GET` | `/api/health` | Container health check |
| `GET` | `/api/system` | CPU / RAM / GPU stats |
| `GET` | `/api/logs` | In-memory log ring buffer |

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TZ` | `America/Chicago` | Container timezone |
| `PORT` | `5050` | HTTP port |
| `DATA_DIR` | `./data` | Host path bind-mounted as `/data` |
| `MAX_PHILO_STREAMS` | `3` | Max concurrent Philo streams |
| `EPG_REFRESH_HOURS` | `6` | Philo EPG refresh interval (hours) |
| `FFMPEG_NVENC_PRESET` | `p4` | NVENC preset (`p1`–`p7`) |
| `FFMPEG_NVENC_TUNE` | `ll` | NVENC tune (`ll`, `hq`, `ull`) |
| `FFMPEG_LOGLEVEL` | `warning` | FFmpeg log level |

---

## Media server integration

### Plex / Jellyfin / Emby — M3U + XMLTV

| Setting | Value |
|---------|-------|
| M3U URL | `http://<host>:5050/channels.m3u` |
| EPG URL | `http://<host>:5050/epg.xml` |

### Dispatcharr — HDHomeRun device

Add a new HDHomeRun device pointing at `http://<host>:5050`.
Dispatcharr will auto-discover the lineup via `/discover.json`.

---

## GitHub Actions / GHCR

The included workflow (`.github/workflows/docker.yml`) publishes images to
GitHub Container Registry automatically:

| Event | Tag |
|-------|-----|
| Push to `main` | `ghcr.io/<owner>/<repo>:main` |
| `v1.2.3` tag | `…:1.2.3`, `…:1.2`, `…:1`, `…:latest` |
| Pull request | Build only (no push) |

Set `GHCR_REPO` in your `.env` to pull the published image instead of building locally.

---

## Architecture

```
                 ┌─────────────────────────────────────────┐
                 │  Docker container                        │
                 │                                          │
  Philo.com ────▶│  Playwright/Chromium  ──▶  Xvfb :20x   │
  (Widevine)     │                              │           │
                 │                         FFmpeg x11grab  │
                 │                              │           │
  Client ◀───────│  /stream/:id/philo.m3u8  ◀──┘           │
                 │  /stream/:id/philo-seg/*                 │
                 └─────────────────────────────────────────┘
```

One Xvfb virtual display (`:201`, `:202`, …) and one PulseAudio null-sink
daemon are created per concurrent stream. FFmpeg captures the display with
`-f x11grab` and the audio via `-f pulse`, encodes with NVENC/x264, and writes
HLS segments to a tmpdir. The Node server rewrites segment URLs and serves them
to the client.

---

## Troubleshooting

**Stream never starts (60 s timeout)**
Check `docker logs Philoproxy`. The Playwright browser navigates to Philo and
must complete auth before FFmpeg starts. Expired cookies → re-authenticate in
Sources.

**NVENC not available**
`POST /stream/reprobe-nvenc` to re-probe. Ensure `nvidia-container-toolkit` is
installed and `runtime: nvidia` is set in compose.

**Audio out of sync**
The default `aresample=async=9600` filter corrects moderate drift. For severe
sync issues try lowering `MAX_PHILO_STREAMS` to reduce CPU contention.

**"Max N concurrent streams reached"**
Increase `MAX_PHILO_STREAMS` in `.env` and restart. Each stream requires a
full Chromium + FFmpeg process.

---

## License

MIT
