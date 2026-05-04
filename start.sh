#!/bin/bash
set -euo pipefail

echo "[start] PhiloProxy starting..."

# ── Playwright Chromium install (idempotent) ──────────────────────────────────
# Runs every container start so upgrades are picked up without a full rebuild.
# Skips quickly if Chromium is already installed.
echo "[start] Checking Playwright Chromium..."
npx playwright install chromium --with-deps 2>&1 | grep -v "^$" || true

# ── Virtual display (Xvfb) ───────────────────────────────────────────────────
# Display :200 is used by the Philo stream manager for the first stream session.
# Additional concurrent streams spin up :201, :202, … automatically.
Xvfb :200 -screen 0 1280x720x24 -nolisten tcp -noreset &
XVFB_PID=$!
echo "[start] Xvfb started on :200 (pid $XVFB_PID)"

# ── PulseAudio (global virtual sink for x11grab audio) ────────────────────────
# The stream manager also creates per-channel private PA daemons for isolation,
# but a global daemon is needed as a fallback when the per-channel one is not
# yet ready.
mkdir -p /var/run/pulse
pulseaudio --start \
  --exit-idle-time=-1 \
  --disallow-exit \
  --log-target=stderr \
  --load="module-native-protocol-unix auth-anonymous=1 socket=/var/run/pulse/native" \
  --load="module-null-sink sink_name=tvnow_out" \
  --load="module-null-source source_name=virtual_in" \
  2>/dev/null || true
echo "[start] PulseAudio started"

# Wait for Xvfb to be ready
sleep 1

# ── Start Node server ─────────────────────────────────────────────────────────
echo "[start] Starting PhiloProxy on port ${PORT:-5050}"
exec node /app/src/server.js
