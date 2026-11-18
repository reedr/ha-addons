FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js /app/server.js

CMD ["node", "/app/server.js"]
