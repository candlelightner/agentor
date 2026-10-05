ARG BASE_IMAGE=agentor-phase7-orchestrator:bounded
FROM ${BASE_IMAGE}
COPY instance-restore-native/ /app/.output/server/instance-restore-native/
COPY instance-restore-helper.mjs /app/.output/server/instance-restore-helper.mjs
