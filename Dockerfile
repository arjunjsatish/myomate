# ==============================================================================
# MyoMate Cloud Telemetry & AI Hub - Production Dockerfile for Google Cloud Run
# ==============================================================================
FROM python:3.11-slim-bookworm

# Avoid interactive prompts & set unbuffered logging
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    PORT=8080

WORKDIR /app

# 1. Install Node.js 20.x, curl, and certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 2. Install Python dependencies with CPU-optimized PyTorch (~350MB vs ~3.5GB)
COPY ml_engine/requirements.txt ./ml_engine/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir torch --extra-index-url https://download.pytorch.org/whl/cpu && \
    pip install --no-cache-dir -r ./ml_engine/requirements.txt

# 3. Install Node.js production dependencies
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 4. Copy application source files
COPY cloud_server.js server.js ./
COPY public/ ./public/
COPY ml_engine/ ./ml_engine/
COPY entrypoint.sh ./

# Create data directories with appropriate permissions
RUN mkdir -p data/recordings && chmod +x entrypoint.sh

# Google Cloud Run dynamically assigns and listens on $PORT
EXPOSE 8080

# Health check verifying both microservices
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://127.0.0.1:${PORT}/api/status || exit 1

ENTRYPOINT ["./entrypoint.sh"]
