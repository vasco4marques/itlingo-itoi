FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
RUN addgroup -S -g 10001 itlingo \
    && adduser -S -D -H -u 10001 -G itlingo itlingo \
    && mkdir -p /app/.runtime-modules \
    && chown -R itlingo:itlingo /app
USER 10001:10001
EXPOSE 3001
CMD ["node", "dist/server.js"]
