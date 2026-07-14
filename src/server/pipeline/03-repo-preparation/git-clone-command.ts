const caBundleEnvCandidates = [
  "GIT_SSL_CAINFO",
  "SSL_CERT_FILE",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
];

const caBundleCandidates = [
  "/etc/daytona/netleash/ca.crt",
  "/etc/openshell-tls/ca-bundle.pem",
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
];

/**
 * Builds the native git clone command used inside Daytona workspaces.
 * Implementations must keep repo URL and path arguments shell-quoted, discover a
 * readable CA bundle before cloning, must never disable TLS verification, and
 * must verify HEAD when an immutable commit is requested.
 */
export function createGitCloneCommand(input: {
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
  return [
    input.resetCommand,
    createCaBundleDiscoveryCommand(),
    `git clone --depth 1${commitSha === undefined ? "" : " --no-checkout"} ${shellQuote(input.repoUrl)} ${destinationPath}`,
    ...(commitSha === undefined
      ? []
      : [
          `git -C ${destinationPath} fetch --depth 1 origin ${commitSha}`,
          `git -C ${destinationPath} checkout --detach ${commitSha}`,
          `test "$(git -C ${destinationPath} rev-parse HEAD)" = ${commitSha}`,
        ]),
  ].join(" && ");
}

function createCaBundleDiscoveryCommand(): string {
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
