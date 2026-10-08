# drakar.tech — production image (Coolify: "Dockerfile" build pack)
# No runtime dependencies: node:sqlite and WebSocket are built into Node 22.
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8787 \
    DB=/app/data/world.db

WORKDIR /app

# Database folder: mount it as a persistent volume (/app/data) in Coolify.
# Created here with the right owner so that a fresh volume inherits the permissions.
# A legacy /app/data/monde.db is adopted (renamed to world.db) by server.js on startup.
RUN mkdir -p /app/data && chown node:node /app/data

COPY --chown=node:node package.json server.js market.js ws-mini.js ./
COPY --chown=node:node public ./public
COPY --chown=node:node locales ./locales

USER node
EXPOSE 8787

# node as PID 1 (not npm): it receives SIGTERM directly and saves the world before stopping.
CMD ["node", "--no-warnings", "server.js"]
