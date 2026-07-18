FROM mcr.microsoft.com/playwright:v1.49.1-noble

ARG TARGETARCH
RUN if [ "$TARGETARCH" != "amd64" ]; then \
      echo "unsupported submitted-code architecture: $TARGETARCH (expected amd64)" >&2; \
      exit 1; \
    fi

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg git unzip \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.2.5" \
  && install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun \
  && ln -sf /usr/local/bin/bun /usr/local/bin/bunx \
  && rm -rf /root/.bun

RUN npm install -g --force pnpm@10.12.1 yarn@1.22.22 \
  && npm cache clean --force

RUN npm install -g \
    @playwright/test@1.49.1 \
    playwright@1.49.1 \
    typescript@5.7.3 \
  && npm cache clean --force

ARG MISE_VERSION=2026.7.7
ARG MISE_SHA256=429f71e7e989908bf975aafac9066329c16e2d8fc7cd8e74fdf21dd6300ffe7c
ENV MISE_DATA_DIR=/opt/mise \
    MISE_CACHE_DIR=/opt/mise/cache \
    MISE_CONFIG_DIR=/opt/mise/config \
    MISE_STATE_DIR=/opt/mise/state \
    MISE_NO_CONFIG=1 \
    MISE_NO_ENV=1 \
    MISE_NO_HOOKS=1 \
    MISE_NOT_FOUND_AUTO_INSTALL=0 \
    MISE_OFFLINE=1 \
    MISE_LOCKED=1 \
    MISE_PARANOID=1 \
    COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_NETWORK=0 \
    COREPACK_DEFAULT_TO_LATEST=0 \
    COREPACK_ENABLE_AUTO_PIN=0 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_ENABLE_PROJECT_SPEC=1 \
    COREPACK_ENABLE_STRICT=1 \
    COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=0 \
    COREPACK_ENV_FILE=0

RUN curl -fsSL \
      "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-x64" \
      -o /usr/local/bin/mise \
  && echo "${MISE_SHA256}  /usr/local/bin/mise" | sha256sum -c - \
  && chmod +x /usr/local/bin/mise \
  && MISE_OFFLINE=0 MISE_LOCKED=0 mise --no-config install node@22.23.1 \
  && MISE_OFFLINE=0 MISE_LOCKED=0 mise --no-config exec node@22.23.1 -- npm install -g corepack@0.35.0 \
  && MISE_OFFLINE=0 MISE_LOCKED=0 COREPACK_ENABLE_NETWORK=1 mise --no-config exec node@22.23.1 -- corepack pack pnpm@10.27.0 -o /tmp/pnpm-10.27.0.tgz \
  && MISE_OFFLINE=0 MISE_LOCKED=0 COREPACK_ENABLE_NETWORK=1 mise --no-config exec node@22.23.1 -- corepack pack pnpm@11.13.0 -o /tmp/pnpm-11.13.0.tgz \
  && mise --no-config exec node@22.23.1 -- corepack install -g --cache-only /tmp/pnpm-10.27.0.tgz \
  && mise --no-config exec node@22.23.1 -- corepack install -g --cache-only /tmp/pnpm-11.13.0.tgz \
  && rm -f /tmp/pnpm-10.27.0.tgz /tmp/pnpm-11.13.0.tgz \
  && chmod -R a-w /opt/mise /opt/corepack

RUN mkdir -p /workspace/.makeademo/cache \
  && chown -R pwuser:pwuser /workspace

ENV HOME=/home/pwuser \
    XDG_CACHE_HOME=/workspace/.makeademo/cache

WORKDIR /workspace
USER pwuser
