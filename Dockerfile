# SOKOLENOK / LUDIK — production image
# node:sqlite is built into Node 22.5+, so we pin a recent Node 22 LTS line.
FROM node:22-slim

# Create app directory
WORKDIR /app

# The app has NO npm dependencies (pure Node stdlib), so there's nothing to install.
# We still copy package.json for metadata / `npm start`.
COPY package.json ./
COPY server.js ./
COPY storage ./storage
COPY public ./public
COPY README.md ./

# Data directory for the SQLite file / JSON fallback. Mounted as a volume in compose.
RUN mkdir -p /data && chown -R node:node /app /data
ENV SOKOLENOK_DATA_DIR=/data

# Run as the unprivileged "node" user that ships with the image
USER node

# Internal port (mapped/proxied externally)
ENV PORT=4173
EXPOSE 4173

# Lightweight healthcheck against the built-in /api/health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
