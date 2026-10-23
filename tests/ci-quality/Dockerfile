# Preparation-only quality image; active CI adoption requires a published digest
# and matched hosted pull-inclusive timings. No application modules are baked.
FROM node:22-bookworm-slim AS node
FROM docker:28-cli AS docker-cli
FROM ubuntu:24.04
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=node /usr/local/ /usr/local/
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl git jq tmux python3 build-essential pkg-config qemu-utils \
       systemd openssl sudo tar gzip xz-utils zstd \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 runner && useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash runner \
    && printf 'runner ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/ci-quality \
    && chmod 0440 /etc/sudoers.d/ci-quality
COPY tests/package.json tests/package-lock.json tests/ci-quality/check-image.mjs tests/ci-quality/Dockerfile /tmp/ci-quality/
RUN cd /tmp/ci-quality \
    && npm ci --ignore-scripts --no-audit --no-fund \
    && npx --no-install playwright install --with-deps chromium \
    && node check-image.mjs --write /etc/agentor-ci-quality.json \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /tmp/ci-quality /root/.npm /var/lib/apt/lists/*
ENV HOME=/home/runner
USER 1001:1001
WORKDIR /workspace
CMD ["bash"]
