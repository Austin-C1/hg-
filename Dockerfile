ARG NODE_IMAGE=m.daocloud.io/docker.io/library/node:22-alpine

FROM ${NODE_IMAGE} AS frontend-build

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/index.html frontend/tsconfig.json frontend/vite.config.ts ./
COPY frontend/src ./src
COPY src/crown/app/app-contract-version.mjs /app/src/crown/app/app-contract-version.mjs
RUN npm run build

FROM ${NODE_IMAGE}

WORKDIR /app

ENV NODE_ENV=production
ENV CROWN_DASHBOARD_HOST=0.0.0.0
ENV CROWN_DASHBOARD_PORT=8787
ENV CROWN_DB_PATH=/app/storage/crown.sqlite
ENV CROWN_STATIC_DIR=/app/frontend/dist

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts/crown-dashboard.mjs ./scripts/crown-dashboard.mjs
COPY config/default-leagues.json config/monitor-settings.json config/monitored-leagues.json /app/config/
COPY data/fixtures/crown/20260708_004011/replay-normalized.jsonl ./data/fixtures/crown/20260708_004011/replay-normalized.jsonl
COPY data/fixtures/crown/20260708_004011/replay-summary.json ./data/fixtures/crown/20260708_004011/replay-summary.json
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

RUN mkdir -p /app/data/runtime /app/storage

EXPOSE 8787

CMD ["npm", "run", "crown:dashboard"]
