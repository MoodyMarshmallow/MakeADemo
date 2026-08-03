const caBundleEnvCandidates = [
  "GIT_SSL_CAINFO",
  "SSL_CERT_FILE",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
];

const defaultCaBundleCandidates = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
];

/**
 * Builds a native Git acquisition command for an isolated repository workspace.
 * Implementations must keep repo URL and path arguments shell-quoted, discover a
 * readable CA bundle before fetching, never disable TLS verification or execute
 * repository hooks, and verify HEAD when an immutable commit is requested.
 */
export function createGitCloneCommand(input: {
  caBundleCandidates?: string[];
  commitSha?: string;
  destinationPath: string;
  repoUrl: string;
  resetCommand: string;
}): string {
  if (
    input.commitSha !== undefined &&
    !/^[0-9a-f]{40}$/i.test(input.commitSha)
  ) {
    throw new Error("commitSha must be a full 40-character Git SHA");
  }

  const destinationPath = shellQuote(input.destinationPath);
  const commitSha =
    input.commitSha === undefined ? undefined : shellQuote(input.commitSha);
  const fetchTarget = commitSha ?? shellQuote("HEAD");
  return [
    input.resetCommand,
    createCaBundleDiscoveryCommand(
      input.caBundleCandidates ?? defaultCaBundleCandidates,
    ),
    createTrustedGitEnvironmentCommand(),
    `git init --quiet ${destinationPath}`,
    `git -C ${destinationPath} config remote.origin.url ${shellQuote(input.repoUrl)}`,
    `git -C ${destinationPath} config remote.origin.tagOpt --no-tags`,
    `git -C ${destinationPath} fetch --depth=1 --no-tags --recurse-submodules=no origin ${fetchTarget}`,
    `git -C ${destinationPath} checkout --quiet --detach --no-recurse-submodules FETCH_HEAD`,
    ...(commitSha === undefined
      ? []
      : [`test "$(git -C ${destinationPath} rev-parse HEAD)" = ${commitSha}`]),
  ].join(" && ");
}

function createTrustedGitEnvironmentCommand(): string {
  const config = [
    ["core.hooksPath", "/dev/null"],
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
    ["submodule.recurse", "false"],
    ["fetch.recurseSubmodules", "false"],
  ] as const;
  return [
    "export GIT_TERMINAL_PROMPT=0",
    "GIT_ASKPASS=/bin/false",
    "SSH_ASKPASS=/bin/false",
    "GIT_CONFIG_NOSYSTEM=1",
    "GIT_CONFIG_GLOBAL=/dev/null",
    "GIT_LFS_SKIP_SMUDGE=1",
    `GIT_CONFIG_COUNT=${config.length}`,
    ...config.flatMap(([key, value], index) => [
      `GIT_CONFIG_KEY_${index}=${shellQuote(key)}`,
      `GIT_CONFIG_VALUE_${index}=${shellQuote(value)}`,
    ]),
  ].join(" ");
}

function createCaBundleDiscoveryCommand(caBundleCandidates: string[]): string {
  const envDiscoveryCommand = [
    `for makeademo_ca_env_name in ${caBundleEnvCandidates.join(" ")}; do`,
    'eval "makeademo_ca_env_value=\\${${makeademo_ca_env_name}-}";',
    'case "$makeademo_ca_env_value" in /*) if test -f "$makeademo_ca_env_value" && test -r "$makeademo_ca_env_value"; then makeademo_ca_bundle="$makeademo_ca_env_value"; break; fi ;; esac; done',
  ].join(" ");

  return [
    envDiscoveryCommand,
    `if test -z "\${makeademo_ca_bundle:-}"; then for makeademo_ca_candidate in ${caBundleCandidates.map(shellQuote).join(" ")}; do if test -f "$makeademo_ca_candidate" && test -r "$makeademo_ca_candidate"; then makeademo_ca_bundle="$makeademo_ca_candidate"; break; fi; done; fi`,
    `if test -n "\${makeademo_ca_bundle:-}"; then export GIT_SSL_CAINFO="$makeademo_ca_bundle"; export SSL_CERT_FILE="$makeademo_ca_bundle"; export CURL_CA_BUNDLE="$makeademo_ca_bundle"; fi`,
  ].join("; ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
