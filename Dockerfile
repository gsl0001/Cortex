# Cortex needs Node >= 25 for the built-in node:sqlite module.
FROM node:25-slim

WORKDIR /app

# Install dependencies first for better layer caching (reproducible from the lockfile).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# App source, build the web UI, then drop dev deps from the runtime image.
COPY . .
RUN npm run web:build && npm prune --omit=dev

# Persist the database on a volume so it survives container restarts.
ENV CORTEX_DB=/data/cortex.sqlite
ENV CORTEX_HOST=0.0.0.0
ENV CORTEX_ALLOW_REMOTE=1
VOLUME ["/data"]
EXPOSE 4317

# CORTEX_TOKEN must be supplied at run time, e.g.
#   docker run -e CORTEX_TOKEN=... -p 4317:4317 -v cortex-data:/data cortex
CMD ["npm", "start"]
