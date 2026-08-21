FROM node:22-alpine AS builder

WORKDIR /app
# Build tools required by better-sqlite3 native module on Alpine (musl)
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
# Keep npm's download cache outside the image layer. An unchanged lockfile
# still reuses this whole layer; after dependency updates BuildKit can now
# reuse already-downloaded tarballs while `npm ci` continues to create a clean,
# lockfile-exact node_modules tree. Drop only the root postinstall from this
# temporary manifest: `nuxt build` prepares the project after its sources are
# copied, so running `nuxt prepare` here (without those sources) is duplicate
# work. Dependency install scripts, including native builds, still run.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm pkg delete scripts.postinstall && \
    npm ci --prefer-offline --no-audit --no-fund
COPY . .
RUN npx nuxt build

FROM node:22-alpine

WORKDIR /app
RUN apk add --no-cache pigz
COPY --from=builder /app/.output/ .output/

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", ".output/server/index.mjs"]
