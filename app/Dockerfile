FROM node:lts-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public/ ./public/

VOLUME ["/app/data"]

ENV NODE_ENV=production
#ENV NODE_ENV=production \
#    PORT=3000 \
#    HOST=0.0.0.0 \
#    DATA_FILE=data/data.json

EXPOSE 3000

CMD ["node", "server.js"]
