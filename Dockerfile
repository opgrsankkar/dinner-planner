FROM node:26-bookworm-slim AS dependencies
ENV PRISMA_DISABLE_TELEMETRY=1
WORKDIR /srv/app/typescript
COPY typescript/package*.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
COPY typescript ./
RUN npm run contract && npm run typecheck && npm test && npm run build

FROM node:26-bookworm-slim AS production
ENV NODE_ENV=production TZ=Asia/Kolkata PRISMA_DISABLE_TELEMETRY=1 PORT=8789
WORKDIR /srv/app/typescript
RUN groupadd --gid 10001 planner && useradd --uid 10001 --gid 10001 planner && mkdir /data && chown planner:planner /data
COPY --from=dependencies /srv/app/typescript/node_modules ./node_modules
COPY --from=build /srv/app/typescript/dist ./dist
COPY --from=build /srv/app/typescript/package.json /srv/app/typescript/prisma.config.ts /srv/app/typescript/tsconfig.json ./
COPY --from=build /srv/app/typescript/scripts ./scripts
COPY --from=build /srv/app/typescript/src ./src
COPY --from=build /srv/app/typescript/prisma ./prisma
COPY --from=build /srv/app/typescript/tests ./tests
USER 10001:10001
EXPOSE 8789
CMD ["node", "scripts/serve.mjs"]
