export const daytonaWorkspaceDirectory = "/workspace";

export const daytonaGitCaBundleCandidates = [
  "/etc/daytona/netleash/ca.crt",
  "/etc/openshell-tls/ca-bundle.pem",
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
] as const;

/**
 * Creates the writable repo root expected by MakeADemo Daytona stages and
 * removes prior workspace contents before cloning submitted code.
 */
export function createDaytonaWorkspaceResetCommand(
  directory = daytonaWorkspaceDirectory,
): string {
  const quotedDirectory = shellQuote(directory);
  return [
    `if ! (mkdir -p ${quotedDirectory} && test -w ${quotedDirectory}); then sudo mkdir -p ${quotedDirectory} && sudo chown -R "$(id -u):$(id -g)" ${quotedDirectory}; fi`,
    `find ${quotedDirectory} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`,
  ].join(" && ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
