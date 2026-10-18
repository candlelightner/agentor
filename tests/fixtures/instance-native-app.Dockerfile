ARG BASE_IMAGE=agentor-phase7-orchestrator:bounded
FROM ${BASE_IMAGE}
# Reuse the accepted musl binding only with the exact same package version and
# Node ABI. The current locally built JS/public output is portable; rebuilding
# the complete native dependency layer for every fixture is unnecessary.
RUN node -e 'const r=require("node:module").createRequire("/app/.output/server/package.json"); if(r("better-sqlite3/package.json").version!=="12.9.0"||process.versions.modules!=="127")throw Error("Fixture native ABI changed"); const d=new(r("better-sqlite3"))(":memory:"); d.close(); const fs=require("node:fs");fs.copyFileSync("/app/.output/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node","/tmp/fixture-sqlite.node");fs.rmSync("/app/.output",{recursive:true,force:true})'
COPY app-output/ /app/.output/
RUN node -e 'const r=require("node:module").createRequire("/app/.output/server/package.json"); if(r("better-sqlite3/package.json").version!=="12.9.0")throw Error("Fixture package changed"); const fs=require("node:fs");fs.copyFileSync("/tmp/fixture-sqlite.node","/app/.output/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node");fs.unlinkSync("/tmp/fixture-sqlite.node");const d=new(r("better-sqlite3"))(":memory:");if(d.prepare("select 1 as n").get().n!==1)throw Error("Fixture SQLite preflight failed");d.close()'
COPY instance-restore-native/ /app/.output/server/instance-restore-native/
COPY instance-restore-helper.mjs /app/.output/server/instance-restore-helper.mjs
COPY volume-mount-helper.py incus-volume-live-helper.py /app/.output/server/
ARG REMOVE_VOLUME_HELPER_SLEEP=false
# The existing legacy extraction leaf fails after native acknowledgement only
# in the explicit rollback fixture; current App still runs Node normally.
RUN if [ "$REMOVE_VOLUME_HELPER_SLEEP" = true ]; then rm /bin/sleep; fi
