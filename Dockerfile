FROM node:26-bookworm-slim AS dependencies
WORKDIR /srv/app/typescript
COPY typescript/package*.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
COPY typescript ./
RUN npm run typecheck && npm test && npm run build

FROM node:26-bookworm-slim AS production-dependencies
WORKDIR /srv/app/typescript
COPY typescript/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:26-bookworm-slim AS production
ENV NODE_ENV=production TZ=Asia/Kolkata PORT=8789
WORKDIR /srv/app/typescript
RUN groupadd --gid 10001 planner && useradd --uid 10001 --gid 10001 planner && mkdir /data && chown planner:planner /data
COPY --from=production-dependencies /srv/app/typescript/node_modules ./node_modules
COPY --from=build /srv/app/typescript/dist ./dist
COPY --from=build /srv/app/typescript/package.json ./
COPY --from=build /srv/app/typescript/scripts/serve.mjs ./scripts/serve.mjs
COPY --from=build /srv/app/typescript/src/server/persistence.ts ./src/server/persistence.ts
USER 10001:10001
EXPOSE 8789
CMD ["node", "scripts/serve.mjs"]
