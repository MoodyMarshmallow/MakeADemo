/**
 * Revisioned, provider-neutral description of the Railway sandbox image used
 * by the Phase 0 spike.  This module intentionally contains no Railway SDK
 * imports: the SDK gateway is the only module that translates this data into
 * provider calls.
 */

import { railwaySpikeTrustedFiles } from "./railway-spike-trusted-files";

export const railwaySpikeTemplateRevision = "makeademo-railway-spike-v4";

const railwaySpikeNodeRoot =
  "/opt/makeademo/toolchains/node/versions/22.23.1" as const;
const railwaySpikeNodeBin = `${railwaySpikeNodeRoot}/bin/node` as const;
const railwaySpikeNpmBin = `${railwaySpikeNodeRoot}/bin/npm` as const;

type RailwaySpikeRuntimePath = Readonly<{
  path: string;
  owner: "root:root";
  immutable: true;
  writable: false;
}>;

type RailwaySpikeTrustedFile = Readonly<{
  contents: string;
  mode: 0o555;
  owner: "root:root";
  path: "/usr/local/bin/makeademo-inspect-submitted-code-toolchain";
}>;

export type RailwaySpikeTemplateRecipe = Readonly<{
  revision: string;
  node: Readonly<{
    architectures: readonly ["x64", "arm64"];
    npmVersion: "11.6.2";
    shasumsUrl: "https://nodejs.org/dist/v22.23.1/SHASUMS256.txt";
    version: "22.23.1";
  }>;
  playwright: Readonly<{
    version: "1.49.1";
    browsers: readonly ["chromium"];
  }>;
  packages: Readonly<{
    system: readonly string[];
    npm: readonly ["@playwright/test@1.49.1", "playwright@1.49.1"];
  }>;
  user: Readonly<{
    group: "makeademo";
    home: "/home/makeademo";
    name: "makeademo";
    privileged: false;
    temporaryDirectory: "/tmp/makeademo";
    workspace: "/workspace";
  }>;
  runtimePaths: Readonly<{
    immutable: readonly RailwaySpikeRuntimePath[];
    nodeBin: typeof railwaySpikeNodeBin;
    npmBin: typeof railwaySpikeNpmBin;
  }>;
  trustedFiles: readonly RailwaySpikeTrustedFile[];
  commands: readonly string[];
}>;

/**
 * The exact package and command order is part of the spike contract.  Keep
 * values as readonly data so a provider adapter can render them for its own
 * template API without making this module provider-specific.
 */
export const railwaySpikeTemplateRecipe = {
  revision: railwaySpikeTemplateRevision,
  node: {
    architectures: ["x64", "arm64"],
    npmVersion: "11.6.2",
    shasumsUrl: "https://nodejs.org/dist/v22.23.1/SHASUMS256.txt",
    version: "22.23.1",
  },
  playwright: {
    version: "1.49.1",
    browsers: ["chromium"],
  },
  packages: {
    system: [
      "ca-certificates",
      "coreutils",
      "curl",
      "ffmpeg",
      "fonts-freefont-ttf",
      "fonts-ipafont-gothic",
      "fonts-liberation",
      "fonts-noto-color-emoji",
      "fonts-tlwg-loma-otf",
      "fonts-unifont",
      "fonts-wqy-zenhei",
      "git",
      "gpgv",
      "libasound2t64",
      "libatk-bridge2.0-0t64",
      "libatk1.0-0t64",
      "libatspi2.0-0t64",
      "libcairo2",
      "libcups2t64",
      "libdbus-1-3",
      "libdrm2",
      "libfontconfig1",
      "libfreetype6",
      "libgbm1",
      "libglib2.0-0t64",
      "libnspr4",
      "libnss3",
      "libpango-1.0-0",
      "libx11-6",
      "libxcb1",
      "libxcomposite1",
      "libxdamage1",
      "libxext6",
      "libxfixes3",
      "libxkbcommon0",
      "libxrandr2",
      "tar",
      "unzip",
      "xfonts-scalable",
      "xz-utils",
      "xvfb",
    ],
    npm: ["@playwright/test@1.49.1", "playwright@1.49.1"],
  },
  user: {
    group: "makeademo",
    home: "/home/makeademo",
    name: "makeademo",
    privileged: false,
    temporaryDirectory: "/tmp/makeademo",
    workspace: "/workspace",
  },
  runtimePaths: {
    immutable: [
      {
        path: "/opt/makeademo/playwright-runtime",
        owner: "root:root",
        immutable: true,
        writable: false,
      },
      {
        path: "/ms-playwright",
        owner: "root:root",
        immutable: true,
        writable: false,
      },
      {
        path: railwaySpikeNodeRoot,
        owner: "root:root",
        immutable: true,
        writable: false,
      },
      {
        path: "/opt/makeademo/runtime-markers",
        owner: "root:root",
        immutable: true,
        writable: false,
      },
      {
        path: "/usr/local/bin/makeademo-inspect-submitted-code-toolchain",
        owner: "root:root",
        immutable: true,
        writable: false,
      },
    ],
    nodeBin: railwaySpikeNodeBin,
    npmBin: railwaySpikeNpmBin,
  },
  trustedFiles: railwaySpikeTrustedFiles,
  commands: [
    "apt-get update",
    "apt-get install -y --no-install-recommends ca-certificates coreutils curl ffmpeg git gpgv tar unzip xz-utils",
    'set -eu; node_version=22.23.1; case "$(dpkg --print-architecture)" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) echo "unsupported Node architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; esac; node_archive="node-v22.23.1-linux-${node_arch}.tar.xz"; node_dist="https://nodejs.org/dist/v${node_version}"; install -d -o root -g root -m 0755 /opt/makeademo/toolchains/node/versions; workdir=$(mktemp -d); cd "${workdir}"; curl --fail --location --proto \'=https\' --tlsv1.2 --output SHASUMS256.txt "${node_dist}/SHASUMS256.txt"; curl --fail --location --proto \'=https\' --tlsv1.2 --output "${node_archive}" "${node_dist}/${node_archive}"; grep -F "  ${node_archive}" SHASUMS256.txt | sha256sum --check -; tar -xJf "${node_archive}"; mv "node-v${node_version}-linux-${node_arch}" "/opt/makeademo/toolchains/node/versions/${node_version}"; rm -rf "${workdir}"; ln -sfn "/opt/makeademo/toolchains/node/versions/${node_version}/bin/node" /usr/local/bin/node; ln -sfn "/opt/makeademo/toolchains/node/versions/${node_version}/bin/npm" /usr/local/bin/npm',
    `${railwaySpikeNpmBin} install --global --prefix ${railwaySpikeNodeRoot} --ignore-scripts --no-audit --no-fund npm@11.6.2`,
    `test "$(${railwaySpikeNodeBin} --version)" = "v22.23.1" && test "$(${railwaySpikeNpmBin} --version)" = "11.6.2" && ffmpeg -version >/dev/null`,
    `${railwaySpikeNpmBin} install --prefix /opt/makeademo/playwright-runtime --ignore-scripts --no-audit --no-fund @playwright/test@1.49.1 playwright@1.49.1`,
    `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright ${railwaySpikeNodeBin} /opt/makeademo/playwright-runtime/node_modules/playwright/cli.js install chromium`,
    "groupadd --system makeademo && useradd --system --gid makeademo --home-dir /home/makeademo --create-home --shell /usr/sbin/nologin makeademo",
    "install -d -o makeademo -g makeademo -m 0750 /home/makeademo /tmp/makeademo /workspace && chown makeademo:makeademo /workspace",
    "install -d -o root -g root -m 0755 /opt/makeademo/runtime-markers && printf 'node=22.23.1\\nnpm=11.6.2\\nplaywright=1.49.1\\n' > /opt/makeademo/runtime-markers/toolchain && chown root:root /opt/makeademo/runtime-markers/toolchain && chmod 0444 /opt/makeademo/runtime-markers/toolchain",
    "chown -R root:root /opt/makeademo/playwright-runtime /ms-playwright /opt/makeademo/toolchains/node /opt/makeademo/runtime-markers && chmod -R a-w /opt/makeademo/playwright-runtime /ms-playwright /opt/makeademo/toolchains/node /opt/makeademo/runtime-markers",
    `test "$(stat -c '%U:%G:%a' /usr/local/bin/makeademo-inspect-submitted-code-toolchain)" = 'root:root:555' && ${railwaySpikeNodeBin} /usr/local/bin/makeademo-inspect-submitted-code-toolchain >/tmp/makeademo-toolchain-inspection.json && ${railwaySpikeNodeBin} -e "const fs = require('node:fs'); const result = JSON.parse(fs.readFileSync('/tmp/makeademo-toolchain-inspection.json', 'utf8')); if (!Array.isArray(result.candidates)) process.exit(1);"`,
    `runuser --user makeademo -- env HOME=/home/makeademo TMPDIR=/tmp/makeademo PLAYWRIGHT_BROWSERS_PATH=/ms-playwright ${railwaySpikeNodeBin} -e "const { chromium } = require('/opt/makeademo/playwright-runtime/node_modules/playwright'); (async () => { const browser = await chromium.launch({ headless: true }); await browser.close(); })().catch((error) => { console.error(error); process.exit(1); });"`,
  ],
} as const satisfies RailwaySpikeTemplateRecipe;
