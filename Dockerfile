# SURGEFALL multiplayer server, built from source (e.g. Render/Railway "deploy from repo").
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN node scripts/build.mjs --prod

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
ENV PORT=8080
EXPOSE 8080
# profiles are stored in /app/data — mount a volume there to keep them across restarts
CMD ["node", "dist/server.js"]
