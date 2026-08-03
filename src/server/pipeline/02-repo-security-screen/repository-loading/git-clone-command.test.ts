import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createGitCloneCommand } from "./git-clone-command";

describe("createGitCloneCommand", () => {
  it("acquires only the requested pinned revision", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "makeademo-pinned-clone-"));
    const sourcePath = join(tempDir, "source");
    const destinationPath = join(tempDir, "submitted code");
    mkdirSync(sourcePath);

    try {
      git(sourcePath, "init", "--quiet", "--initial-branch=main");
      git(sourcePath, "config", "user.name", "Fixture");
      git(sourcePath, "config", "user.email", "fixture@example.test");
      writeFileSync(join(sourcePath, "README.md"), "pinned revision\n");
      git(sourcePath, "add", "README.md");
      git(sourcePath, "commit", "--quiet", "-m", "pinned revision");
      const pinnedCommit = git(sourcePath, "rev-parse", "HEAD");
      git(sourcePath, "tag", "pinned-tag");

      writeFileSync(
        join(sourcePath, "future-only.bin"),
        deterministicBytes(2 * 1024 * 1024),
      );
      git(sourcePath, "add", "future-only.bin");
      git(sourcePath, "commit", "--quiet", "-m", "future default tip");
      const futureCommit = git(sourcePath, "rev-parse", "HEAD");
      const futureBlob = git(sourcePath, "rev-parse", "HEAD:future-only.bin");
      git(sourcePath, "tag", "future-tag");

      const command = createGitCloneCommand({
        commitSha: pinnedCommit,
        destinationPath,
        repoUrl: `file://${sourcePath}`,
        resetCommand: `rm -rf '${destinationPath}'`,
      });
      execFileSync("/bin/sh", ["-c", command]);

      expect(git(destinationPath, "rev-parse", "HEAD")).toBe(pinnedCommit);
      expect(git(destinationPath, "rev-parse", "--is-shallow-repository")).toBe(
        "true",
      );
      expect(
        gitExitCode(destinationPath, "symbolic-ref", "-q", "HEAD"),
      ).not.toBe(0);
      expect(git(destinationPath, "remote", "get-url", "origin")).toBe(
        `file://${sourcePath}`,
      );
      expect(
        gitExitCode(
          destinationPath,
          "config",
          "--get-all",
          "remote.origin.fetch",
        ),
      ).not.toBe(0);
      expect(
        git(destinationPath, "config", "--get", "remote.origin.tagOpt"),
      ).toBe("--no-tags");
      expect(
        gitExitCode(destinationPath, "cat-file", "-e", futureCommit),
      ).not.toBe(0);
      expect(
        gitExitCode(destinationPath, "cat-file", "-e", futureBlob),
      ).not.toBe(0);
      expect(
        git(
          destinationPath,
          "for-each-ref",
          "--format=%(refname)",
          "refs/tags",
        ),
      ).toBe("");
      expect(
        git(
          destinationPath,
          "for-each-ref",
          "--format=%(refname)",
          "refs/remotes",
        ),
      ).toBe("");
      expect(git(destinationPath, "status", "--porcelain")).toBe("");
      expect(gitExitCode(destinationPath, "diff", "--exit-code")).toBe(0);
      expect(git(destinationPath, "ls-files")).toBe("README.md");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("fetches and verifies an immutable commit with trusted Git settings", () => {
    const command = createGitCloneCommand({
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      destinationPath: "/workspace/submitted code",
      repoUrl: "https://github.com/example/app",
      resetCommand: "rm -rf '/workspace/submitted code'",
    });

    expect(command).toContain("export GIT_TERMINAL_PROMPT=0");
    expect(command).toContain("GIT_CONFIG_NOSYSTEM=1");
    expect(command).toContain("GIT_CONFIG_GLOBAL=/dev/null");
    expect(command).toContain("GIT_LFS_SKIP_SMUDGE=1");
    expect(command).toContain("GIT_CONFIG_VALUE_0='/dev/null'");
    expect(command).toContain("GIT_CONFIG_KEY_1='gc.auto'");
    expect(command).toContain("GIT_CONFIG_KEY_2='maintenance.auto'");
    expect(command).toContain("GIT_CONFIG_KEY_3='submodule.recurse'");
    expect(command).toContain("GIT_CONFIG_KEY_4='fetch.recurseSubmodules'");
    expect(command).toContain("git init --quiet '/workspace/submitted code'");
    expect(command).toContain(
      "git -C '/workspace/submitted code' config remote.origin.url 'https://github.com/example/app'",
    );
    expect(command).toContain(
      "git -C '/workspace/submitted code' config remote.origin.tagOpt --no-tags",
    );
    expect(command).toContain(
      "git -C '/workspace/submitted code' fetch --depth=1 --no-tags --recurse-submodules=no origin '0123456789abcdef0123456789abcdef01234567'",
    );
    expect(command).toContain(
      "git -C '/workspace/submitted code' checkout --quiet --detach --no-recurse-submodules FETCH_HEAD",
    );
    expect(command).toContain(
      `test "$(git -C '/workspace/submitted code' rev-parse HEAD)" = '0123456789abcdef0123456789abcdef01234567'`,
    );
    expect(command).not.toContain("git clone");
  });

  it("rejects abbreviated commit SHAs at the clone boundary", () => {
    expect(() =>
      createGitCloneCommand({
        commitSha: "abc123",
        destinationPath: "/workspace",
        repoUrl: "https://github.com/example/app",
        resetCommand: "rm -rf '/workspace'",
      }),
    ).toThrow("commitSha must be a full 40-character Git SHA");
  });

  it("prefers readable absolute CA env paths before hardcoded CA bundles", () => {
    const command = createGitCloneCommand({
      destinationPath: "/workspace/submitted code",
      repoUrl: "https://github.com/example/app",
      resetCommand: "rm -rf '/workspace/submitted code'",
    });

    expect(command.indexOf("GIT_SSL_CAINFO")).toBeLessThan(
      command.indexOf("/etc/ssl/certs/ca-certificates.crt"),
    );
    expect(command.indexOf("SSL_CERT_FILE")).toBeLessThan(
      command.indexOf("/etc/ssl/certs/ca-certificates.crt"),
    );
    expect(command.indexOf("CURL_CA_BUNDLE")).toBeLessThan(
      command.indexOf("/etc/ssl/certs/ca-certificates.crt"),
    );
    expect(command.indexOf("REQUESTS_CA_BUNDLE")).toBeLessThan(
      command.indexOf("/etc/ssl/certs/ca-certificates.crt"),
    );
    expect(command).toContain("test -r");
    expect(command).toMatch(/case .* in \/\*/s);
    expect(command).toMatch(/export GIT_SSL_CAINFO="\$makeademo_ca_bundle"/);
    expect(command).toMatch(/export SSL_CERT_FILE="\$makeademo_ca_bundle"/);
    expect(command).toMatch(/export CURL_CA_BUNDLE="\$makeademo_ca_bundle"/);
  });

  it("discovers CA bundle env values by name with POSIX shell indirection", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "makeademo-git-clone-command-"));
    const fakeGitPath = join(tempDir, "git");
    const caBundlePath = join(tempDir, "ca.crt");
    const selectedCaPath = join(tempDir, "selected-ca.txt");
    writeFileSync(caBundlePath, "test certificate");
    writeFileSync(
      fakeGitPath,
      `#!/bin/sh
printf '%s' "$GIT_SSL_CAINFO" > "$FAKE_GIT_SELECTED_CA_PATH"
`,
    );
    chmodSync(fakeGitPath, 0o755);

    const command = createGitCloneCommand({
      destinationPath: join(tempDir, "submitted code"),
      repoUrl: "https://github.com/example/app",
      resetCommand: ":",
    });

    expect(command).not.toContain("${$makeademo_ca_env_name-}");

    execFileSync("/bin/sh", ["-c", command], {
      env: {
        ...process.env,
        CURL_CA_BUNDLE: "relative-ca.crt",
        FAKE_GIT_SELECTED_CA_PATH: selectedCaPath,
        GIT_SSL_CAINFO: "relative-ca.crt",
        PATH: tempDir,
        SSL_CERT_FILE: caBundlePath,
      },
    });

    expect(readFileSync(selectedCaPath, "utf8")).toBe(caBundlePath);
  });

  it("preserves configured CA bundle preference order", () => {
    const command = createGitCloneCommand({
      caBundleCandidates: [
        "/provider/primary-ca.crt",
        "/provider/secondary-ca.crt",
        "/etc/ssl/certs/ca-certificates.crt",
      ],
      destinationPath: "/workspace/submitted code",
      repoUrl: "https://github.com/example/app",
      resetCommand: "rm -rf '/workspace/submitted code'",
    });

    expect(command.indexOf("/provider/primary-ca.crt")).toBeLessThan(
      command.indexOf("/provider/secondary-ca.crt"),
    );
    expect(command.indexOf("/provider/primary-ca.crt")).toBeLessThan(
      command.indexOf("/etc/ssl/certs/ca-certificates.crt"),
    );
    expect(command.indexOf("/provider/secondary-ca.crt")).toBeLessThan(
      command.indexOf("/etc/ssl/certs/ca-certificates.crt"),
    );
    expect(command).toMatch(/export GIT_SSL_CAINFO=.*git init/s);
    expect(command).not.toContain("GIT_SSL_NO_VERIFY");
    expect(command).not.toContain("sslVerify=false");
  });
});

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
  }).trim();
}

function gitExitCode(directory: string, ...args: string[]): number {
  try {
    execFileSync("git", ["-C", directory, ...args], { stdio: "ignore" });
    return 0;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof error.status === "number"
    ) {
      return error.status;
    }
    throw error;
  }
}

function deterministicBytes(length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let state = 0x12345678;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}
