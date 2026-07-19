FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl docker.io git openssh-client unzip \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV GIT_SSL_CAINFO=/etc/openshell-tls/ca-bundle.pem

RUN mkdir -p /etc/openshell-tls \
  && if ! test -f /etc/openshell-tls/ca-bundle.pem; then ln -s /etc/ssl/certs/ca-certificates.crt /etc/openshell-tls/ca-bundle.pem; fi \
  && if test -f /etc/openshell-tls/ca-bundle.pem; then git config --system http.sslCAInfo /etc/openshell-tls/ca-bundle.pem; fi

RUN mkdir -p /opt/makeademo

COPY submitted-code-node-browser.Dockerfile /opt/makeademo/submitted-code-node-browser.Dockerfile
COPY preload-submitted-code-image.sh /usr/local/bin/makeademo-preload-submitted-code-image
COPY inspect-submitted-code-toolchain.mjs /usr/local/bin/makeademo-inspect-submitted-code-toolchain
RUN chmod +x /usr/local/bin/makeademo-preload-submitted-code-image /usr/local/bin/makeademo-inspect-submitted-code-toolchain

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.2.5" \
  && ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
  && ln -sf /root/.bun/bin/bunx /usr/local/bin/bunx

RUN npm install -g --force pnpm@10.12.1 yarn@1.22.22 \
  && npm cache clean --force

RUN npm install -g --force opencode-ai@1.18.3 \
  && npm cache clean --force

WORKDIR /workspace
