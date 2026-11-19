FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/ apps/
COPY packages/ packages/
RUN bun install --frozen-lockfile && bun run build:web

FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7
WORKDIR /app
COPY --from=build --chown=bun:bun /app /app
USER bun
CMD ["bun", "run", "start"]
