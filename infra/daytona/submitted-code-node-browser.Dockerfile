FROM mcr.microsoft.com/playwright:v1.49.1-noble@sha256:70e367e0cbf60340a5b5fd562f6247a34eb3196efab9f88a3dd56482d9fe09d2

ARG TARGETARCH
ARG MAKEADEMO_CAPTURE_NODE_VERSION=v22.12.0
ARG MAKEADEMO_CAPTURE_NODE_SHA256=177208bfc4a9403121a40c72d038c670f4fd937fa16ca7df0a720e90be0fe2d9
RUN if [ "$TARGETARCH" != "amd64" ]; then \
      echo "unsupported submitted-code architecture: $TARGETARCH (expected amd64)" >&2; \
      exit 1; \
    fi

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg git gpgv iproute2 unzip xz-utils \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.2.5" \
  && install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun \
  && ln -sf /usr/local/bin/bun /usr/local/bin/bunx \
  && rm -rf /root/.bun

RUN npm install -g \
    @playwright/cli@0.1.17 \
    typescript@5.7.3 \
  && npm cache clean --force

RUN mkdir -p /opt/makeademo/playwright-runtime \
  && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --prefix /opt/makeademo/playwright-runtime --ignore-scripts --no-audit --no-fund \
    @playwright/test@1.49.1 \
    playwright@1.49.1 \
  && chown -R root:root /opt/makeademo/playwright-runtime \
  && chmod -R a-w /opt/makeademo/playwright-runtime

# Capture Path Validation and Footage Capture never inherit the submitted
# project's Node or package-manager PATH. Snapshot publication freezes this
# image-owned Node binary and bridge at an explicit, root-owned location.
RUN set -eu; \
  test "$(node --version)" = "${MAKEADEMO_CAPTURE_NODE_VERSION}"; \
  printf '%s  %s\n' "${MAKEADEMO_CAPTURE_NODE_SHA256}" "$(command -v node)" | sha256sum -c -; \
  mkdir -p /opt/makeademo/capture-runtime/bin; \
  install -m 0555 "$(command -v node)" /opt/makeademo/capture-runtime/bin/node; \
  test "$(/opt/makeademo/capture-runtime/bin/node --version)" = "${MAKEADEMO_CAPTURE_NODE_VERSION}"; \
  printf '%s  %s\n' "${MAKEADEMO_CAPTURE_NODE_SHA256}" /opt/makeademo/capture-runtime/bin/node | sha256sum -c -; \
  printf '%s\n' "${MAKEADEMO_CAPTURE_NODE_VERSION}" > /opt/makeademo/capture-runtime/node.version; \
  printf '%s\n' "${MAKEADEMO_CAPTURE_NODE_SHA256}" > /opt/makeademo/capture-runtime/node.sha256; \
  printf '%s\n' \
    'import { createRequire } from "node:module";' \
    'const requireTrustedPlaywright = createRequire("/opt/makeademo/playwright-runtime/node_modules/playwright/package.json");' \
    'export const chromium = requireTrustedPlaywright("playwright").chromium;' \
    'export const expect = requireTrustedPlaywright("@playwright/test").expect;' \
    > /opt/makeademo/capture-runtime/playwright.mjs; \
  /opt/makeademo/capture-runtime/bin/node --input-type=module -e 'import("/opt/makeademo/capture-runtime/playwright.mjs").then(({ chromium, expect }) => { if (!chromium || !expect) process.exit(1); })'; \
  chown -R root:root /opt/makeademo/capture-runtime; \
  chmod -R a-w /opt/makeademo/capture-runtime

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NO_UPDATE_NOTIFIER=1

RUN PLAYWRIGHT_SKIP_BROWSER_GC=1 playwright-cli install-browser chromium \
  && PLAYWRIGHT_SKIP_BROWSER_GC=1 node /opt/makeademo/playwright-runtime/node_modules/playwright/cli.js install chromium \
  && chown -R root:root /ms-playwright \
  && chmod -R a+rX /ms-playwright \
  && chmod -R a-w /ms-playwright

ARG NODE_RELEASE_KEYS_COMMIT=b28073028e6d6855cfb53bf7fa0137599c01f967
ARG NODE_RELEASE_KEYRING_SHA256=6030d4e0cd53330acf2ab68acd455b7ca98bb5d5975376f0b7c0892308ba2d57
RUN mkdir -p /opt/makeademo/node-release-trust \
  && curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    "https://raw.githubusercontent.com/nodejs/release-keys/${NODE_RELEASE_KEYS_COMMIT}/gpg/pubring.kbx" \
    -o /opt/makeademo/node-release-trust/pubring.kbx \
  && echo "${NODE_RELEASE_KEYRING_SHA256}  /opt/makeademo/node-release-trust/pubring.kbx" | sha256sum -c - \
  && printf '%s\n' \
    5BE8A3F6C8A5C01D106C0AD820B1A390B168D356 \
    DD792F5973C6DE52C432CBDAC77ABFA00DDBF2B7 \
    CC68F5A3106FF448322E48ED27F5E38D5B0A215F \
    8FCCA13FEF1D0C2E91008E09770F7A9A5AE15600 \
    890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4 \
    C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C \
    108F52B48DB57BB0CC439B2997B01419BD92F80A \
    A363A499291CBBC940DD62E41F10027AF002F8B0 \
    655F3B5C1FB3FA8D1A0CA6BDE4A7D232B936D2FD \
    C0D6248439F1D5604AAFFB4021D900FFDB233756 \
    > /opt/makeademo/node-release-trust/allowed-primary-fingerprints.txt \
  && chown -R root:root /opt/makeademo/node-release-trust \
  && chmod 0555 /opt/makeademo/node-release-trust \
  && chmod 0400 /opt/makeademo/node-release-trust/pubring.kbx /opt/makeademo/node-release-trust/allowed-primary-fingerprints.txt

# These releases exercise each known-good family, the benchmark-selected
# exacts at this policy revision, and 24.2.0's retired-but-valid release key.
ARG NODE_RELEASE_TRUST_SMOKE_VERSIONS="18.20.8 20.19.5 22.23.1 24.0.0 24.18.0 24.2.0"
RUN set -eu; \
  mkdir -p /tmp/makeademo-node-release-trust-smoke; \
  for version in ${NODE_RELEASE_TRUST_SMOKE_VERSIONS}; do \
    signed="/tmp/makeademo-node-release-trust-smoke/${version}.asc"; \
    verified="/tmp/makeademo-node-release-trust-smoke/${version}.txt"; \
    status="/tmp/makeademo-node-release-trust-smoke/${version}.status"; \
    curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
      "https://nodejs.org/dist/v${version}/SHASUMS256.txt.asc" -o "$signed"; \
    gpgv --status-fd=1 \
      --keyring=/opt/makeademo/node-release-trust/pubring.kbx \
      --output="$verified" "$signed" > "$status"; \
    test "$(grep -c '^\[GNUPG:\] VALIDSIG ' "$status")" -eq 1; \
    ! grep -Eq '^\[GNUPG:\] (REVKEYSIG|KEYREVOKED)( |$)' "$status"; \
    primary="$(awk '/^\[GNUPG:\] VALIDSIG / { print $NF }' "$status")"; \
    grep -Fx "$primary" /opt/makeademo/node-release-trust/allowed-primary-fingerprints.txt; \
  done; \
  rm -rf /tmp/makeademo-node-release-trust-smoke

COPY provision-submitted-node-runtime.mjs /usr/local/bin/makeademo-provision-submitted-node-runtime
RUN chmod 0700 /usr/local/bin/makeademo-provision-submitted-node-runtime \
  && mkdir -p /opt/makeademo/toolchains/node/sha256 /opt/makeademo/toolchains/node/versions \
  && chown -R root:root /opt/makeademo/toolchains/node \
  && chmod -R a-w /opt/makeademo/toolchains/node

RUN mkdir -p /workspace/.makeademo/cache \
  && chown -R pwuser:pwuser /workspace

ENV HOME=/home/pwuser \
    XDG_CACHE_HOME=/workspace/.makeademo/cache

WORKDIR /workspace
# Daytona backend control commands run as root so the provider can hydrate a
# root-owned toolchain artifact directory before submitted files are synchronized. The
# provider always drops submitted-code execution to pwuser.
USER root
