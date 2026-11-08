# Pinned to an exact Node and Alpine release so every build is the same; bump it deliberately.
FROM node:22.23.4-alpine3.24

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# App files stay owned by root, so the bot can't modify its own code; only /app/db is writable.
COPY . .

RUN mkdir -p /app/db && chown node:node /app/db
VOLUME ["/app/db"]

USER node

ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT

# Run node directly so Docker's stop signal reaches the bot.
CMD ["node", "index.js"]
