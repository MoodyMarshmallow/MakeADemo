import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("Daytona Repo Preparation image", () => {
  it("includes Docker-in-Docker support and the submitted-code image definition", async () => {
    const dockerfile = await readFile(
      join(import.meta.dirname, "repo-preparation.Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toContain("docker.io");
    expect(dockerfile).toContain("ca-certificates");
    expect(dockerfile).toContain("git");
    expect(dockerfile).toContain("update-ca-certificates");
    expect(dockerfile).toContain("submitted-code-node-browser.Dockerfile");
    expect(dockerfile).toContain("makeademo-preload-submitted-code-image");
    expect(dockerfile).toContain(
      "COPY inspect-submitted-code-toolchain.mjs /usr/local/bin/makeademo-inspect-submitted-code-toolchain",
    );
    expect(dockerfile).toMatch(
      /chmod 0750[^\n]*makeademo-inspect-submitted-code-toolchain/,
    );
    expect(dockerfile).toContain(
      "GIT_SSL_CAINFO=/etc/openshell-tls/ca-bundle.pem",
    );
    expect(dockerfile).toContain("ln -s /etc/ssl/certs/ca-certificates.crt");
    expect(dockerfile).toContain("test -f /etc/openshell-tls/ca-bundle.pem");
    expect(dockerfile).toContain(
      "git config --system http.sslCAInfo /etc/openshell-tls/ca-bundle.pem",
    );
    expect(dockerfile).toContain(
      "git config --system --add safe.directory /workspace",
    );
    expect(dockerfile).not.toMatch(/safe\.directory\s+(?:['"]?\*['"]?)/);
    expect(dockerfile).not.toContain("opencode");
    expect(dockerfile).toContain("useradd");
    expect(dockerfile).toContain("pwuser");
    expect(dockerfile).toMatch(/chown -R pwuser:pwuser[^\n]*\/workspace/);
    expect(dockerfile).toContain(
      "install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun",
    );
    expect(dockerfile).not.toContain(
      "ln -sf /root/.bun/bin/bun /usr/local/bin/bun",
    );
    expect(dockerfile).toMatch(
      /chmod 0750[^\n]*makeademo-inspect-submitted-code-toolchain/,
    );
    expect(dockerfile).toMatch(
      /chmod 0750[^\n]*\/usr\/(?:local\/)?bin\/(?:node|npm)/,
    );
  });

  it("defines the generic Node/browser submitted-code runtime image", async () => {
    const dockerfile = await readFile(
      join(import.meta.dirname, "submitted-code-node-browser.Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toContain("mcr.microsoft.com/playwright");
    expect(dockerfile).toContain("ca-certificates");
    expect(dockerfile).toContain("ffmpeg");
    expect(dockerfile).toContain("git");
    expect(dockerfile).toContain("unzip");
    expect(dockerfile).toContain("update-ca-certificates");
    expect(dockerfile).toContain("bun-v1.2.5");
    expect(dockerfile).toContain(
      "install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun",
    );
    expect(dockerfile).toContain(
      "ln -sf /usr/local/bin/bun /usr/local/bin/bunx",
    );
    expect(dockerfile).not.toContain(
      "ln -sf /root/.bun/bin/bun /usr/local/bin/bun",
    );
    expect(dockerfile).toContain("pnpm@10.12.1");
    expect(dockerfile).toContain("yarn@1.22.22");
    expect(dockerfile).toContain("@playwright/test@1.49.1");
    expect(dockerfile).toContain("playwright@1.49.1");
    expect(dockerfile).toContain("typescript@5.7.3");
    expect(dockerfile).toContain("WORKDIR /workspace");
    expect(dockerfile).toContain("MISE_VERSION=2026.7.7");
    expect(dockerfile).toContain("ARG TARGETARCH");
    expect(dockerfile).toContain('"amd64"');
    expect(dockerfile).toContain("unsupported submitted-code architecture");
    expect(dockerfile).toContain("sha256sum -c");
    expect(dockerfile).toContain("mise --no-config install node@22.23.1");
    expect(dockerfile).toContain("corepack@0.35.0");
    expect(dockerfile).toContain("corepack pack pnpm@10.27.0");
    expect(dockerfile).toContain("corepack pack pnpm@11.13.0");
    expect(dockerfile).toContain("corepack install -g --cache-only");
    expect(dockerfile).toContain("MISE_NO_CONFIG=1");
    expect(dockerfile).toContain("MISE_OFFLINE=1");
    expect(dockerfile).toContain("MISE_PARANOID=1");
    expect(dockerfile).toContain("MISE_LOCKED=1");
    expect(dockerfile).toContain("COREPACK_ENABLE_NETWORK=0");
    expect(dockerfile).toContain("COREPACK_DEFAULT_TO_LATEST=0");
    expect(dockerfile).toContain("COREPACK_ENABLE_AUTO_PIN=0");
    expect(dockerfile).toContain("COREPACK_ENV_FILE=0");
    expect(dockerfile).toContain("COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=0");
    expect(dockerfile).toContain("COREPACK_ENABLE_STRICT=1");
    expect(dockerfile).toMatch(
      /chmod -R a-w[^\n]*\/opt\/mise[^\n]*\/opt\/corepack/,
    );
    expect(dockerfile).toMatch(/chown -R pwuser:pwuser[^\n]*\/workspace/);
    expect(dockerfile).toContain("USER pwuser");
    expect(dockerfile).toContain("pnpm@10.27.0");
    expect(dockerfile).toContain("pnpm@11.13.0");
    expect(dockerfile).not.toContain("/opt/makeademo/toolchains/pnpm");
    expect(dockerfile).not.toMatch(/COREPACK_INTEGRITY_KEYS=(?:0|\s*$)/m);
  });

  it("ships the pinned Playwright agent CLI and matching browser for offline runtime use", async () => {
    const dockerfile = await readFile(
      join(import.meta.dirname, "submitted-code-node-browser.Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toContain("@playwright/cli@0.1.17");
    expect(dockerfile).toContain("playwright-cli install-browser chromium");
    expect(dockerfile).toContain("PLAYWRIGHT_BROWSERS_PATH=/ms-playwright");
    expect(dockerfile).toContain("NO_UPDATE_NOTIFIER=1");
  });

  it("keeps Docker RUN and ENV continuations parseable", async () => {
    const dockerfile = await readFile(
      join(import.meta.dirname, "submitted-code-node-browser.Dockerfile"),
      "utf8",
    );

    expect(dockerfile).not.toMatch(/^(?:RUN|ENV).*\s\+\s{2,}/m);
    expect(dockerfile).toMatch(
      /RUN if \[ "\$TARGETARCH" != "amd64" \]; then \\\n+\s+echo [^\n]+ \\\n+\s+exit 1; \\\n+\s+fi/,
    );
    expect(dockerfile).toMatch(
      /RUN mkdir -p \/workspace\/.makeademo\/cache \\\n+\s+&& chown -R pwuser:pwuser \/workspace/,
    );
    expect(dockerfile).toMatch(
      /ENV HOME=\/home\/pwuser \\\n+\s+XDG_CACHE_HOME=\/workspace\/.makeademo\/cache/,
    );
  });
});
