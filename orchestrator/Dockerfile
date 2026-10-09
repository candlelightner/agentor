FROM node:22-alpine AS builder

WORKDIR /app/orchestrator
# Build tools required by better-sqlite3 native module on Alpine (musl)
RUN apk add --no-cache python3 make g++
COPY orchestrator/package.json orchestrator/package-lock.json* ./
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
COPY orchestrator/ .
# Canonical source assets are packaged by the build, never maintained here.
COPY worker/vm/ /app/worker/vm/
COPY worker/entrypoint.sh /app/worker/entrypoint.sh
COPY scripts/build-incus-worker-image.sh /app/scripts/build-incus-worker-image.sh
COPY scripts/incus-canary.mjs /app/scripts/incus-canary.mjs
RUN npm run build

FROM node:22-alpine

WORKDIR /app
RUN apk add --no-cache pigz python3 coreutils qemu-img tar acl
COPY --from=builder /app/orchestrator/.output/ .output/
# npm run build includes a separately traced, import-checked native adapter at
# .output/server/instance-restore-native/index.mjs; no full builder modules copy.
# Kept outside the Nitro request process on purpose: a short-lived,
# network-disabled helper uses it to stop/apply/restart an instance restore.
COPY --from=builder /app/orchestrator/instance-restore-helper.mjs .output/server/instance-restore-helper.mjs
COPY --from=builder /app/orchestrator/volume-mount-helper.py .output/server/volume-mount-helper.py
COPY --from=builder /app/orchestrator/incus-volume-live-helper.py .output/server/incus-volume-live-helper.py

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", ".output/server/index.mjs"]
