FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && chown node:node /app

COPY --chown=node:node . .

RUN mkdir -p /app/db && chown node:node /app/db
VOLUME ["/app/db"]

USER node

ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT

# Run node directly so Docker's stop signal reaches the bot.
CMD ["node", "index.js"]
