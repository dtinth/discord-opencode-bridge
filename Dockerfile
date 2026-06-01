FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .

FROM oven/bun:1
WORKDIR /app
COPY --from=build /app /app
ENV DATABASE_PATH=/data/bridge.db
CMD ["bun", "bot", "run"]
