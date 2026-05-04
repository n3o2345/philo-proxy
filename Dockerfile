FROM node:20-bookworm-slim

# ── System packages ───────────────────────────────────────────────────────────
# ffmpeg: x11grab + h264_nvenc/hevc_nvenc (NVIDIA libs injected at runtime).
# pulseaudio: per-channel null-sink audio capture.
# xvfb / x11-*: virtual framebuffer for headless Chromium.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    pulseaudio \
    pulseaudio-utils \
    xvfb \
    xauth \
    x11-xserver-utils \
    x11-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Dependencies (separate layer — only rebuilds on package.json change) ──────
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ── Playwright Chromium (separate layer for cache efficiency) ─────────────────
RUN npx playwright install chromium --with-deps

# ── Application source ────────────────────────────────────────────────────────
COPY src/ src/
COPY start.sh /start.sh
RUN chmod +x /start.sh

# ── Runtime ───────────────────────────────────────────────────────────────────
VOLUME ["/data"]
EXPOSE 5050

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -fsS http://localhost:${PORT:-5050}/api/health || exit 1

CMD ["/start.sh"]
