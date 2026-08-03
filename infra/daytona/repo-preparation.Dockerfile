FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl docker.io git openssh-client python3-venv ripgrep unzip util-linux \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV GIT_SSL_CAINFO=/etc/openshell-tls/ca-bundle.pem

RUN mkdir -p /etc/openshell-tls \
  && if ! test -f /etc/openshell-tls/ca-bundle.pem; then ln -s /etc/ssl/certs/ca-certificates.crt /etc/openshell-tls/ca-bundle.pem; fi \
  && if test -f /etc/openshell-tls/ca-bundle.pem; then git config --system http.sslCAInfo /etc/openshell-tls/ca-bundle.pem; fi \
  && git config --system --add safe.directory /workspace

RUN mkdir -p /opt/makeademo

ARG OSV_SCANNER_VERSION=2.3.8
ARG OSV_SCANNER_LINUX_AMD64_SHA256=bc98e15319ed0d515e3f9235287ba53cdc5535d576d24fd573978ecfe9ab92dc
ARG OSV_SCANNER_LINUX_ARM64_SHA256=8158b18edd2d03b1a30d905ca91b032bc62262167be8f206c27114f08823e27c

RUN makeademo_security_arch="$(dpkg --print-architecture)" \
  && case "$makeademo_security_arch" in \
    amd64) makeademo_osv_arch=amd64; makeademo_osv_sha256="$OSV_SCANNER_LINUX_AMD64_SHA256" ;; \
    arm64) makeademo_osv_arch=arm64; makeademo_osv_sha256="$OSV_SCANNER_LINUX_ARM64_SHA256" ;; \
    *) echo "unsupported security scanner architecture: $makeademo_security_arch" >&2; exit 1 ;; \
  esac \
  && mkdir -p /opt/makeademo/security-tools \
  && curl -fsSL "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_linux_${makeademo_osv_arch}" -o /opt/makeademo/security-tools/osv-scanner \
  && printf '%s  %s\n' "$makeademo_osv_sha256" /opt/makeademo/security-tools/osv-scanner | sha256sum -c - \
  && chmod 0755 /opt/makeademo/security-tools/osv-scanner \
  && python3 -m venv /opt/makeademo/security-tools/guarddog \
  && /opt/makeademo/security-tools/guarddog/bin/pip install --no-cache-dir --disable-pip-version-check guarddog==3.1.0 \
  && python3 -m venv /opt/makeademo/security-tools/semgrep \
  && /opt/makeademo/security-tools/semgrep/bin/pip install --no-cache-dir --disable-pip-version-check semgrep==1.172.0 \
  && /opt/makeademo/security-tools/osv-scanner --version | grep -F "2.3.8" \
  && /opt/makeademo/security-tools/guarddog/bin/guarddog --version | grep -F "3.1.0" \
  && /opt/makeademo/security-tools/semgrep/bin/semgrep --version | grep -Fx "1.172.0" \
  && chown -R root:root /opt/makeademo/security-tools \
  && chmod -R a-w /opt/makeademo/security-tools

COPY repo-security-semgrep-rules.yml /opt/makeademo/security/semgrep-rules.yml
RUN chown -R root:root /opt/makeademo/security \
  && chmod -R a-w /opt/makeademo/security

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
