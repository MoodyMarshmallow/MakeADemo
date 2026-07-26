FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl docker.io git openssh-client unzip util-linux \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV GIT_SSL_CAINFO=/etc/openshell-tls/ca-bundle.pem

RUN mkdir -p /etc/openshell-tls \
  && if ! test -f /etc/openshell-tls/ca-bundle.pem; then ln -s /etc/ssl/certs/ca-certificates.crt /etc/openshell-tls/ca-bundle.pem; fi \
  && if test -f /etc/openshell-tls/ca-bundle.pem; then git config --system http.sslCAInfo /etc/openshell-tls/ca-bundle.pem; fi \
  && git config --system --add safe.directory /workspace

RUN mkdir -p /opt/makeademo

COPY submitted-code-node-browser.Dockerfile /opt/makeademo/submitted-code-node-browser.Dockerfile
COPY provision-submitted-node-runtime.mjs /opt/makeademo/provision-submitted-node-runtime.mjs
COPY preload-submitted-code-image.sh /usr/local/bin/makeademo-preload-submitted-code-image
COPY inspect-submitted-code-toolchain.mjs /usr/local/bin/makeademo-inspect-submitted-code-toolchain
RUN chmod 0750 /usr/local/bin/makeademo-preload-submitted-code-image /usr/local/bin/makeademo-inspect-submitted-code-toolchain

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.2.5" \
  && install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun \
  && ln -sf /usr/local/bin/bun /usr/local/bin/bunx \
  && rm -rf /root/.bun

RUN npm install -g --force pnpm@10.12.1 yarn@1.22.22 \
  && npm cache clean --force \
  && chmod 0750 /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/bun /usr/local/bin/pnpm /usr/local/bin/yarn

RUN useradd --home-dir /workspace/.makeademo/agent-home --no-create-home --shell /bin/bash pwuser \
  && mkdir -p /workspace/.makeademo/agent-home /workspace/.makeademo/tmp \
  && chown -R pwuser:pwuser /workspace \
  && chmod 0755 /tmp /var/tmp

WORKDIR /workspace
