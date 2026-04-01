# ─────────────────────────────────────────────────────────────
# SLGP Fleet Web App
# Node.js 20 + FFmpeg + Real-ESRGAN + RIFE (CPU mode) + OpenCV
# ─────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim

# ── System packages ──────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Video processing
    ffmpeg \
    # Required by realesrgan-ncnn-vulkan and rife-ncnn-vulkan
    # even in CPU mode (-g -1) the runtime needs these
    libvulkan1 \
    libvulkan-dev \
    mesa-vulkan-drivers \
    # Archive extraction
    unzip \
    wget \
    ca-certificates \
    # OpenGL / runtime deps
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    # Python — dark recovery pipeline (engine.js OpenCV)
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# ── Python packages — OpenCV dark recovery ───────────────────
# opencv-python-headless: no GUI deps, works in headless containers
RUN pip3 install --no-cache-dir --break-system-packages \
    opencv-python-headless==4.10.0.84 \
    numpy==1.26.4

# ── Real-ESRGAN (ncnn-vulkan binary, CPU-compatible via -g -1) ──
# v0.2.5.0 — last stable release with realesr-animevideov3 model
RUN mkdir -p /opt/realesrgan && \
    wget -q -O /tmp/esrgan.zip \
        "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip" && \
    unzip -q /tmp/esrgan.zip -d /opt/realesrgan && \
    chmod +x /opt/realesrgan/realesrgan-ncnn-vulkan && \
    rm /tmp/esrgan.zip

# ── RIFE (ncnn-vulkan binary, CPU-compatible via -g -1) ──────
# v0.3.1 — AI frame interpolation, far smoother than FFmpeg framerate filter
RUN mkdir -p /opt/rife && \
    wget -q -O /tmp/rife.zip \
        "https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-ubuntu.zip" && \
    unzip -q /tmp/rife.zip -d /tmp/rife_extract && \
    mv /tmp/rife_extract/rife-ncnn-vulkan-20221029-ubuntu/* /opt/rife/ && \
    chmod +x /opt/rife/rife-ncnn-vulkan && \
    rm -rf /tmp/rife.zip /tmp/rife_extract

# ── App directory ────────────────────────────────────────────
WORKDIR /app

# Verify node is working at build time
RUN node --version && npm --version

# ── Node dependencies ────────────────────────────────────────
# Copy only package.json — explicitly exclude package-lock.json
# so npm installs fresh from package.json version ranges
COPY package.json ./
RUN npm install --omit=dev --no-package-lock

# ── Application code ─────────────────────────────────────────
COPY . .

# ── Runtime volume (uploads, logs, enhanced output) ──────────
# Volume mounted via Railway dashboard → /app/meshcentral-data

# ── Environment: point app to AI tool locations ──────────────
ENV ESRGAN_BIN=/opt/realesrgan/realesrgan-ncnn-vulkan
ENV ESRGAN_MODELS=/opt/realesrgan/models
ENV RIFE_BIN=/opt/rife/rife-ncnn-vulkan
ENV RIFE_MODELS=/opt/rife/models
ENV NODE_ENV=production

# ── Health check ─────────────────────────────────────────────
# Gives Node 90s to start (AI tool detection + DB init can be slow)
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/health', r => process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# ── Port ─────────────────────────────────────────────────────
EXPOSE 8080

# ── Start ────────────────────────────────────────────────────
CMD ["node", "--unhandled-rejections=strict", "index.js"]
