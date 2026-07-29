import { railwaySpikeTemplateRecipe } from "./railway-spike-template-recipe";

const nodeBin = "/opt/makeademo/toolchains/node/versions/22.23.1/bin/node";
const npmBin = "/opt/makeademo/toolchains/node/versions/22.23.1/bin/npm";
const captureRoot = "/opt/makeademo/capture-runtime";

const productionBaseCommands = railwaySpikeTemplateRecipe.commands.map(
  (command) => {
    if (command.startsWith(`${npmBin} install --global`)) {
      return createPinnedNpmHydrationCommand();
    }
    if (
      command.startsWith(
        `${npmBin} install --prefix /opt/makeademo/playwright-runtime`,
      )
    ) {
      return createPinnedPlaywrightRuntimeCommand();
    }
    return command;
  },
);

/**
 * Revisioned Railway image for the opt-in full MakeADemo Pipeline path.
 * It deliberately remains separate from the latency spike recipe: changing a
 * production capability must not invalidate the measured POC cohort.
 */
export const railwayProductionTemplateRecipe = {
  ...railwaySpikeTemplateRecipe,
  revision: "makeademo-railway-pipeline-v2",
  runtimePaths: {
    ...railwaySpikeTemplateRecipe.runtimePaths,
    immutable: [
      ...railwaySpikeTemplateRecipe.runtimePaths.immutable,
      {
        path: captureRoot,
        owner: "root:root" as const,
        immutable: true as const,
        writable: false as const,
      },
    ],
  },
  commands: [
    ...productionBaseCommands,
    // Capture tooling is independent from submitted project toolchains. Every
    // npm artifact below has an exact version, direct tarball URL, and pinned
    // sha512. Bun uses GitHub's exact tagged asset plus provider digest/size.
    `install -d -o root -g root -m 0755 ${captureRoot}/bin ${captureRoot}/npm`,
    createPinnedBunCaptureCommand(),
    createPinnedPlaywrightCliCommand(),
    `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright PLAYWRIGHT_SKIP_BROWSER_GC=1 ${captureRoot}/bin/playwright-cli install-browser chromium`,
    `test -x ${captureRoot}/bin/bun && test "$(${captureRoot}/bin/bun --version)" = '1.2.22' && test "$(${nodeBin} -p \"require('${captureRoot}/npm/node_modules/@playwright/cli/package.json').version\")" = '0.1.17'`,
    `chown -R root:root ${captureRoot} /ms-playwright && chmod -R a+rX ${captureRoot} /ms-playwright && chmod -R a-w ${captureRoot} /ms-playwright && chmod 0555 ${captureRoot}/bin/bun ${captureRoot}/bin/playwright-cli`,
  ],
} as const;

type RailwayProductionTemplateRecipe = typeof railwayProductionTemplateRecipe;

function createPinnedNpmHydrationCommand(): string {
  const url = "https://registry.npmjs.org/npm/-/npm-11.6.2.tgz";
  const sha512 =
    "ee22b335fcbc95662cdf3ab8a053daf045d9cf9c6df6040d28965abb707512b2c16fa6c5eec049d34c74f78f390cebd14f697919eadb97756564d4f9eccc4954";
  const nodeRoot = "/opt/makeademo/toolchains/node/versions/22.23.1";
  return [
    "set -eu",
    "workdir=$(mktemp -d)",
    "trap 'rm -rf \"$workdir\"' EXIT",
    `curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 ${shellQuote(url)} -o "$workdir/npm.tgz"`,
    `printf '%s  %s\\n' ${shellQuote(sha512)} "$workdir/npm.tgz" | sha512sum --check --status`,
    `rm -rf ${shellQuote(`${nodeRoot}/lib/node_modules/npm`)}`,
    `install -d -o root -g root -m 0755 ${shellQuote(`${nodeRoot}/lib/node_modules/npm`)}`,
    `tar --no-same-owner --no-same-permissions --strip-components=1 -xzf "$workdir/npm.tgz" -C ${shellQuote(`${nodeRoot}/lib/node_modules/npm`)}`,
    `ln -sfn ../lib/node_modules/npm/bin/npm-cli.js ${shellQuote(`${nodeRoot}/bin/npm`)}`,
    `ln -sfn ../lib/node_modules/npm/bin/npx-cli.js ${shellQuote(`${nodeRoot}/bin/npx`)}`,
    `test "$(${shellQuote(`${nodeRoot}/bin/npm`)} --version)" = '11.6.2'`,
  ].join(" && ");
}

function createPinnedPlaywrightRuntimeCommand(): string {
  const root = "/opt/makeademo/playwright-runtime/node_modules";
  return [
    "set -eu",
    `rm -rf ${shellQuote(root)}`,
    `install -d -o root -g root -m 0755 ${shellQuote(`${root}/@playwright/test`)} ${shellQuote(`${root}/playwright`)} ${shellQuote(`${root}/playwright-core`)}`,
    createPinnedNpmExtraction({
      destination: `${root}/@playwright/test`,
      filename: "test-1.49.1.tgz",
      sha512:
        "2b2f815733f3f292fa3d0c47a8d456d64de6232bfddf72cc2fb1e4b52f2e8a4d1b51734274f8684bf90b8a188ed6d31ffde81a25be08bad5dded4cb0bd7116fa",
      url: "https://registry.npmjs.org/@playwright/test/-/test-1.49.1.tgz",
    }),
    createPinnedNpmExtraction({
      destination: `${root}/playwright`,
      filename: "playwright-1.49.1.tgz",
      sha512:
        "5582fcccba0d4c1c553ab2416c3b9180359ade2fa67d08034eb2fc021f505d9edac780ec8f4312ab96d8832b519c35557be9e3a0a9dfb18907dc7cea563e5464",
      url: "https://registry.npmjs.org/playwright/-/playwright-1.49.1.tgz",
    }),
    createPinnedNpmExtraction({
      destination: `${root}/playwright-core`,
      filename: "playwright-core-1.49.1.tgz",
      sha512:
        "0739a955cb38904d821f5e6b59fce98f354685611125f9a75e69e24b229e45952cf56b3ae66f911888bb9a324afdeb827a07e7de2ee3bea59e5b21def72dd582",
      url: "https://registry.npmjs.org/playwright-core/-/playwright-core-1.49.1.tgz",
    }),
    `test "$(${nodeBin} ${shellQuote(`${root}/playwright/cli.js`)} --version)" = 'Version 1.49.1'`,
  ].join(" && ");
}

function createPinnedBunCaptureCommand(): string {
  const version = "1.2.22";
  const parser =
    "const fs=require('node:fs');const name=process.argv[1];const value=JSON.parse(fs.readFileSync(0,'utf8'));const matches=Array.isArray(value.assets)?value.assets.filter((asset)=>asset&&asset.name===name):[];const asset=matches[0];if(matches.length!==1||typeof asset.digest!=='string'||!/^sha256:[a-f0-9]{64}$/.test(asset.digest)||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>134217728)process.exit(1);process.stdout.write(asset.digest+' '+asset.size);";
  return [
    "set -eu",
    `version=${shellQuote(version)}`,
    'case "$(dpkg --print-architecture)" in amd64) architecture=x64 ;; arm64) architecture=aarch64 ;; *) echo "unsupported Bun architecture" >&2; exit 64 ;; esac',
    'asset="bun-linux-${architecture}.zip"',
    'member="bun-linux-${architecture}/bun"',
    `tag=${shellQuote(`bun-v${version}`)}`,
    "workdir=$(mktemp -d)",
    "trap 'rm -rf \"$workdir\"' EXIT",
    `curl --fail --silent --show-error --location --max-filesize 8388608 --proto '=https' --tlsv1.2 ${shellQuote(`https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v${version}`)} -o "$workdir/release.json"`,
    `authority=$(${nodeBin} -e ${shellQuote(parser)} "$asset" < "$workdir/release.json")`,
    "digest=${authority%% *}",
    "asset_size=${authority##* }",
    `curl --fail --silent --show-error --location --max-filesize 134217728 --proto '=https' --tlsv1.2 "https://github.com/oven-sh/bun/releases/download/$tag/$asset" -o "$workdir/$asset"`,
    'test "$(wc -c < "$workdir/$asset" | tr -d " ")" = "$asset_size"',
    'printf \'%s  %s\\n\' "${digest#sha256:}" "$workdir/$asset" | sha256sum --check --status',
    'test "$(unzip -Z1 "$workdir/$asset" | grep -Fxc "$member")" = 1',
    'unzip -q "$workdir/$asset" "$member" -d "$workdir/extracted"',
    `install -o root -g root -m 0555 "$workdir/extracted/$member" ${captureRoot}/bin/bun`,
  ].join(" && ");
}

function createPinnedPlaywrightCliCommand(): string {
  const root = `${captureRoot}/npm/node_modules`;
  return [
    "set -eu",
    `rm -rf ${shellQuote(root)}`,
    `install -d -o root -g root -m 0755 ${shellQuote(`${root}/@playwright/cli`)} ${shellQuote(`${root}/playwright`)} ${shellQuote(`${root}/playwright-core`)}`,
    createPinnedNpmExtraction({
      destination: `${root}/@playwright/cli`,
      filename: "cli-0.1.17.tgz",
      sha512:
        "541c3acb7a7c7aa3aa9a32a0d3b2245923c6289929221311343148e83398b030fa7c07dc2355d811630b5b2852650d01fce73628de3d7aae17a84eb83d43c706",
      url: "https://registry.npmjs.org/@playwright/cli/-/cli-0.1.17.tgz",
    }),
    createPinnedNpmExtraction({
      destination: `${root}/playwright`,
      filename: "playwright-1.62.0-alpha-1783623505000.tgz",
      sha512:
        "e8a57d8783cfde1aaee0d686771c5c8a359f621f4b25c148fd1dac3f84d30b8239705a37a116b0374113956e4c904ddc40480a861a23d0a50dcf8b1fa424f44e",
      url: "https://registry.npmjs.org/playwright/-/playwright-1.62.0-alpha-1783623505000.tgz",
    }),
    createPinnedNpmExtraction({
      destination: `${root}/playwright-core`,
      filename: "playwright-core-1.62.0-alpha-1783623505000.tgz",
      sha512:
        "08f25976c03f2864f641095e92257a5adf90950ad91d5499ea888db4e23f6d860e2152ccf237ca1964cce33422c9de1437ee340aae1c03a9719991d96ed3ef25",
      url: "https://registry.npmjs.org/playwright-core/-/playwright-core-1.62.0-alpha-1783623505000.tgz",
    }),
    `printf '%s\\n' '#!/bin/sh' 'exec ${nodeBin} ${root}/@playwright/cli/playwright-cli.js "$@"' > ${captureRoot}/bin/playwright-cli`,
    `chmod 0555 ${captureRoot}/bin/playwright-cli`,
  ].join(" && ");
}

function createPinnedNpmExtraction(input: {
  destination: string;
  filename: string;
  sha512: string;
  url: string;
}): string {
  const archive = `/tmp/${input.filename}`;
  return [
    `curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 ${shellQuote(input.url)} -o ${shellQuote(archive)}`,
    `printf '%s  %s\\n' ${shellQuote(input.sha512)} ${shellQuote(archive)} | sha512sum --check --status`,
    `tar --no-same-owner --no-same-permissions --strip-components=1 -xzf ${shellQuote(archive)} -C ${shellQuote(input.destination)}`,
    `rm -f ${shellQuote(archive)}`,
  ].join(" && ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
