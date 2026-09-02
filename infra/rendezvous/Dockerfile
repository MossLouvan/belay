# Belay rendezvous — stateless signaling introducer.
# UNVERIFIED-DEPLOY: builds from the tested TypeScript, but this image has not
# been run against live cross-NAT traffic here (see docs/SCALABILITY.md).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8790
# BELAY_TURN_SECRET and BELAY_TURN_URLS are required; the process refuses to
# boot without them (config.ts fails fast).
CMD ["node", "dist/server.js"]
