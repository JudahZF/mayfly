# Mayfly in one container. The data lives in the /data volume.
#
# Inside a container Mayfly listens on 0.0.0.0, so MAYFLY_TOKEN is required.
# Without it the env check stops the process at start, before anything else runs.

# pnpm needs Node, so dependencies are installed and the web app is built on the Node image.
FROM node:24.22.1-bookworm-slim AS base
RUN npm install --global pnpm@11.27.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS deps
RUN pnpm install --frozen-lockfile --prod

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# The server runs on Bun, straight from the TypeScript source.
FROM oven/bun:1.3.13-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist/web ./dist/web
COPY package.json ./
COPY src ./src
# src/server/db applies these migrations at start.
COPY drizzle ./drizzle
RUN mkdir /data && chown bun:bun /data
USER bun
VOLUME /data
EXPOSE 4747
# Set here, not with ENV, so that an --env-file copied from a local .env cannot move the address or the data folder.
ENTRYPOINT ["env", "MAYFLY_HOST=0.0.0.0", "MAYFLY_PORT=4747", "MAYFLY_DATA_DIR=/data", "bun", "src/server/index.ts"]
