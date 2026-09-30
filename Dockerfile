FROM node:26-bookworm-slim AS build
ENV PRISMA_TELEMETRY_DISABLED=1
WORKDIR /srv/app/typescript
COPY typescript/package*.json ./
RUN npm ci --no-audit --no-fund
COPY typescript ./
RUN npm run contract && npm run typecheck && npm test && npm run build

FROM node:26-bookworm-slim AS production
ENV NODE_ENV=production TZ=Asia/Kolkata PRISMA_TELEMETRY_DISABLED=1 PORT=8789
WORKDIR /srv/app/typescript
RUN groupadd --gid 10001 planner && useradd --uid 10001 --gid 10001 planner && mkdir /data && chown planner:planner /data
COPY --from=build /srv/app/typescript /srv/app/typescript
USER 10001:10001
EXPOSE 8789
CMD ["node", "scripts/serve.mjs"]
