FROM node:lts-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY notes-webdav/ ./notes-webdav/

# FIX_PERMISSIONS=1 (.env, passed as build arg by docker-compose.yml): hand /app to the node user.
# Off by default — chown -R over node_modules is slow, and the app only writes to the /app/data volume,
# whose ownership comes from the host directory.
ARG FIX_PERMISSIONS=0
RUN if [ "$FIX_PERMISSIONS" = "1" ]; then \
      mkdir -p /app/data && chmod 700 /app/data && chown -R node:node /app; \
    fi

VOLUME ["/app/data"]

USER node

ENV NODE_ENV=production
#ENV NODE_ENV=production \
#    PORT=3000 \
#    HOST=0.0.0.0 \
#    DATA_FILE=data/data.json

EXPOSE 3000

CMD ["node", "backend/server.js"]
