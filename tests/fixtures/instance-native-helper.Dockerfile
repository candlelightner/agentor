ARG BASE_IMAGE=agentor-phase7-orchestrator:bounded
FROM ${BASE_IMAGE}
ARG REMOVE_VOLUME_HELPER_SLEEP=false
# Test-only real legacy leaf failure after native inverse has acknowledged.
# The target/helper run Node directly; production images are unaffected.
RUN if [ "$REMOVE_VOLUME_HELPER_SLEEP" = true ]; then rm /bin/sleep; fi
COPY instance-restore-native/ /app/.output/server/instance-restore-native/
COPY instance-restore-helper.mjs /app/.output/server/instance-restore-helper.mjs
