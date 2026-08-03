import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("Daytona Repo Preparation image", () => {
  it("pins trusted read-only repository scanners and their local Semgrep policy", async () => {
    const dockerfile = await readFile(
      join(import.meta.dirname, "repo-preparation.Dockerfile"),
      "utf8",
    );
    const semgrepRules = await readFile(
      join(import.meta.dirname, "repo-security-semgrep-rules.yml"),
      "utf8",
    );

    expect(dockerfile).toContain("ripgrep");
    expect(dockerfile).toContain("python3-venv");
    expect(dockerfile).toContain("ARG OSV_SCANNER_VERSION=2.3.8");
    expect(dockerfile).toContain(
      "ARG OSV_SCANNER_LINUX_AMD64_SHA256=bc98e15319ed0d515e3f9235287ba53cdc5535d576d24fd573978ecfe9ab92dc",
    );
    expect(dockerfile).toContain("guarddog==3.1.0");
    expect(dockerfile).toContain("semgrep==1.172.0");
    expect(dockerfile).toContain(
      "COPY repo-security-semgrep-rules.yml /opt/makeademo/security/semgrep-rules.yml",
    );
    expect(dockerfile).toContain(
      "/opt/makeademo/security-tools/osv-scanner --version",
    );
    expect(dockerfile).toContain(
      "/opt/makeademo/security-tools/guarddog/bin/guarddog --version",
    );
    expect(dockerfile).toContain(
      "/opt/makeademo/security-tools/semgrep/bin/semgrep --version",
    );
    expect(dockerfile).toMatch(
      /chown -R root:root \/opt\/makeademo\/security(?:-tools)?/,
    );
    expect(dockerfile).toMatch(
      /chmod -R a-w \/opt\/makeademo\/security(?:-tools)?/,
    );
    expect(semgrepRules).toContain("id: makeademo.destructive-root-filesystem");
    expect(semgrepRules).toContain("id: makeademo.remote-download-execution");
    expect(semgrepRules).toContain("id: makeademo.encoded-shell-execution");
    expect(semgrepRules).toContain("languages: [generic]");
  });

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
    expect(dockerfile).toContain(
      "COPY provision-submitted-node-runtime.mjs /opt/makeademo/provision-submitted-node-runtime.mjs",
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
    expect(dockerfile).toContain("iproute2");
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
    expect(dockerfile).not.toContain("pnpm@10.12.1");
    expect(dockerfile).not.toContain("yarn@1.22.22");
    expect(dockerfile).toContain("@playwright/test@1.49.1");
    expect(dockerfile).toContain("playwright@1.49.1");
    expect(dockerfile).toContain("typescript@5.7.3");
    expect(dockerfile).toContain("WORKDIR /workspace");
    expect(dockerfile).not.toContain("MISE_");
    expect(dockerfile).toContain("ARG TARGETARCH");
    expect(dockerfile).toContain('"amd64"');
    expect(dockerfile).toContain("unsupported submitted-code architecture");
    expect(dockerfile).toContain("sha256sum -c");
    expect(dockerfile).not.toContain("mise --no-config");
    expect(dockerfile).not.toContain("node@22.23.1");
    expect(dockerfile).not.toContain("corepack pack pnpm@");
    expect(dockerfile).toMatch(/chown -R pwuser:pwuser[^\n]*\/workspace/);
    expect(dockerfile).toContain("USER root");
    expect(dockerfile).toContain(
      "provider always drops submitted-code execution to pwuser",
    );
    expect(dockerfile).not.toContain("pnpm@10.27.0");
    expect(dockerfile).not.toContain("pnpm@11.13.0");
    expect(dockerfile).not.toContain("/opt/makeademo/toolchains/pnpm");
    expect(dockerfile).not.toMatch(/COREPACK_INTEGRITY_KEYS=(?:0|\s*$)/m);
  });

  it("separates the agent CLI from a read-only trusted Playwright runtime", async () => {
    const dockerfile = await readFile(
      join(import.meta.dirname, "submitted-code-node-browser.Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toContain("@playwright/cli@0.1.17");
    expect(dockerfile).toContain(
      "npm install --prefix /opt/makeademo/playwright-runtime",
    );
    expect(dockerfile).toContain("@playwright/test@1.49.1");
    expect(dockerfile).toContain("playwright@1.49.1");
    expect(dockerfile).toContain("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1");
    expect(dockerfile).toMatch(
      /chmod -R a-w[^\n]*\/opt\/makeademo\/playwright-runtime/,
    );
    expect(dockerfile).toContain("playwright-cli install-browser chromium");
    expect(dockerfile).toContain("PLAYWRIGHT_SKIP_BROWSER_GC=1");
    expect(dockerfile).toContain(
      "node /opt/makeademo/playwright-runtime/node_modules/playwright/cli.js install chromium",
    );
    expect(dockerfile).toContain("PLAYWRIGHT_BROWSERS_PATH=/ms-playwright");
    expect(dockerfile).toMatch(
      /playwright-cli install-browser chromium[\s\S]*chown -R root:root \/ms-playwright[\s\S]*chmod -R a-w \/ms-playwright/,
    );
    expect(dockerfile).toContain("NO_UPDATE_NOTIFIER=1");
  });

  it("provisions a root-owned fixed Node and Playwright bridge for capture", async () => {
    const dockerfile = await readFile(
      join(import.meta.dirname, "submitted-code-node-browser.Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toContain("/opt/makeademo/capture-runtime/bin/node");
    expect(dockerfile).toContain(
      "FROM mcr.microsoft.com/playwright:v1.49.1-noble@sha256:70e367e0cbf60340a5b5fd562f6247a34eb3196efab9f88a3dd56482d9fe09d2",
    );
    expect(dockerfile).toContain("ARG MAKEADEMO_CAPTURE_NODE_VERSION=v22.12.0");
    expect(dockerfile).toContain(
      "ARG MAKEADEMO_CAPTURE_NODE_SHA256=177208bfc4a9403121a40c72d038c670f4fd937fa16ca7df0a720e90be0fe2d9",
    );
    expect(dockerfile).toContain(
      "/opt/makeademo/capture-runtime/playwright.mjs",
    );
    expect(dockerfile).toContain(
      'createRequire("/opt/makeademo/playwright-runtime/node_modules/playwright/package.json")',
    );
    expect(dockerfile).toContain(
      "printf '%s  %s\\n' \"${MAKEADEMO_CAPTURE_NODE_SHA256}\" /opt/makeademo/capture-runtime/bin/node | sha256sum -c -",
    );
    expect(dockerfile).toContain(
      "chown -R root:root /opt/makeademo/capture-runtime",
    );
    expect(dockerfile).toContain("chmod -R a-w /opt/makeademo/capture-runtime");
  });

  it("pins Node release signing trust and installs a root-only hydration helper", async () => {
    const dockerfile = await readFile(
      join(import.meta.dirname, "submitted-code-node-browser.Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toContain("gpgv");
    expect(dockerfile).toContain("xz-utils");
    expect(dockerfile).toContain(
      "ARG NODE_RELEASE_KEYS_COMMIT=b28073028e6d6855cfb53bf7fa0137599c01f967",
    );
    expect(dockerfile).toContain(
      "ARG NODE_RELEASE_KEYRING_SHA256=6030d4e0cd53330acf2ab68acd455b7ca98bb5d5975376f0b7c0892308ba2d57",
    );
    expect(dockerfile).toContain("/gpg/pubring.kbx");
    expect(dockerfile).not.toContain("gpg-only-active-keys/pubring.kbx");
    expect(dockerfile).toContain("NODE_RELEASE_KEYRING_SHA256");
    const allowedPrimaryFingerprints = [
      "5BE8A3F6C8A5C01D106C0AD820B1A390B168D356",
      "DD792F5973C6DE52C432CBDAC77ABFA00DDBF2B7",
      "CC68F5A3106FF448322E48ED27F5E38D5B0A215F",
      "8FCCA13FEF1D0C2E91008E09770F7A9A5AE15600",
      "890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4",
      "C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C",
      "108F52B48DB57BB0CC439B2997B01419BD92F80A",
      "A363A499291CBBC940DD62E41F10027AF002F8B0",
      "655F3B5C1FB3FA8D1A0CA6BDE4A7D232B936D2FD",
      "C0D6248439F1D5604AAFFB4021D900FFDB233756",
    ];
    for (const fingerprint of allowedPrimaryFingerprints) {
      expect(dockerfile).toContain(fingerprint);
    }
    const policyBlock =
      /printf '%s\\n' \\\n(?<body>[\s\S]+?)> \/opt\/makeademo\/node-release-trust\/allowed-primary-fingerprints\.txt/.exec(
        dockerfile,
      )?.groups?.body;
    expect(policyBlock?.match(/[A-F0-9]{40}/g)).toEqual(
      allowedPrimaryFingerprints,
    );
    for (const version of [
      "18.20.8",
      "20.19.5",
      "22.23.1",
      "24.0.0",
      "24.18.0",
      "24.2.0",
    ]) {
      expect(dockerfile).toContain(version);
    }
    expect(dockerfile).toContain("NODE_RELEASE_TRUST_SMOKE_VERSIONS");
    expect(dockerfile).toContain(
      "https://nodejs.org/dist/v${version}/SHASUMS256.txt.asc",
    );
    expect(dockerfile).toContain("gpgv --status-fd=1");
    expect(dockerfile).toContain("REVKEYSIG|KEYREVOKED");
    expect(dockerfile).toContain(
      "COPY provision-submitted-node-runtime.mjs /usr/local/bin/makeademo-provision-submitted-node-runtime",
    );
    expect(dockerfile).toMatch(
      /chmod 0700[^\n]*makeademo-provision-submitted-node-runtime/,
    );
    expect(dockerfile).toMatch(
      /chmod 0400[^\n]*pubring\.kbx[^\n]*allowed-primary-fingerprints\.txt/,
    );
    expect(dockerfile).toContain("/opt/makeademo/toolchains/node/sha256");
    expect(dockerfile).toContain(
      "chown -R root:root /opt/makeademo/toolchains/node",
    );
    expect(dockerfile).toContain("chmod -R a-w /opt/makeademo/toolchains/node");
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
