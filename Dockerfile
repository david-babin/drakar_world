# drakar world — production image (Coolify: "Dockerfile" build pack)

# ---- build: bundles and minifies the site (public/) and the server (bin/backend.js) ----
FROM node:22-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
# sources, Earth data and .git when the context has it (the commit shown on the page is read from it;
# SOURCE_COMMIT, passed by Coolify, takes precedence) — see .dockerignore
COPY . .
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT
RUN npm run build

# ---- runtime: no dependencies (node:sqlite and WebSocket are built into Node 22) ----
FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8787 \
    DB=/app/data/world.db
WORKDIR /app

# Database folder: mount it as a persistent volume (/app/data) in Coolify.
# Created here with the right owner so that a fresh volume inherits the permissions.
# A legacy /app/data/monde.db is adopted (renamed to world.db) on startup.
RUN mkdir -p /app/data && chown node:node /app/data

COPY --chown=node:node package.json ./
COPY --from=build --chown=node:node /src/bin ./bin
COPY --from=build --chown=node:node /src/public ./public

USER node
EXPOSE 8787

# node as PID 1 (not npm): it receives SIGTERM directly and saves the world before stopping.
CMD ["node", "--no-warnings", "bin/backend.js"]
