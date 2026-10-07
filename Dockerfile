# drakar.tech — image de production (Coolify : Build Pack « Dockerfile »)
# Aucune dépendance d'exécution : node:sqlite et le WebSocket sont intégrés à Node 22.
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8787 \
    DB=/app/data/monde.db

WORKDIR /app

# Dossier de la base : à monter en volume persistant (/app/data) dans Coolify.
# Créé ici avec le bon propriétaire pour qu'un volume neuf hérite des droits.
RUN mkdir -p /app/data && chown node:node /app/data

COPY --chown=node:node package.json server.js market.js ws-mini.js ./
COPY --chown=node:node public ./public

USER node
EXPOSE 8787

# node en PID 1 (pas npm) : il reçoit directement SIGTERM et sauvegarde le monde avant l'arrêt.
CMD ["node", "--no-warnings", "server.js"]
