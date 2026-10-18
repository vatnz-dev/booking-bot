FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --chown=node:node . .

USER node

CMD ["npm", "start"]
