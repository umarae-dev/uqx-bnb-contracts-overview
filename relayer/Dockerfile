FROM node:20.20.2-alpine3.22

ENV NODE_ENV=production \
    PORT=8787

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY relayer ./relayer

RUN chown -R node:node /app
USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "relayer/healthcheck.js"]

CMD ["node", "relayer/server.js"]
