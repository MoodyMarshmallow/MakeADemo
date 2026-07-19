import { describe, expect, it } from "vitest";

import {
  createSubmittedRuntimeEnv,
  evaluateDependencyNetworkRequest,
} from "./dependency-network-gate";

describe("evaluateDependencyNetworkRequest", () => {
  it.each([
    "npm ci",
    "npm ci --ignore-scripts",
    "npm ci --omit=dev",
    "npm ci --include=dev --ignore-scripts",
    "npm install",
    "npm install --ignore-scripts",
    "npm install --workspaces=false --ignore-scripts",
    "npm install --legacy-peer-deps",
    "npm install --force",
    "pnpm install",
    "pnpm install --frozen-lockfile",
    "pnpm install --ignore-scripts",
    "pnpm install --prod=false",
    "yarn install",
    "yarn install --frozen-lockfile",
    "yarn install --immutable",
    "yarn install --ignore-scripts",
    "bun install",
    "bun install --frozen-lockfile",
    "bun install --no-save",
    "corepack pnpm install --frozen-lockfile",
    "corepack yarn install --immutable",
  ])("allows dependency install command: %s", (command) => {
    expect(
      evaluateDependencyNetworkRequest({
        command,
        reason: "dependency-install",
      }),
    ).toEqual({ status: "allowed" });
  });

  it("denies network access when the reason is not dependency installation", () => {
    const result = evaluateDependencyNetworkRequest({
      command: "bun run build",
      reason: "demo-build",
    });

    expect(result).toEqual({
      reason:
        "Outbound network access is only allowed for dependency installation.",
      status: "denied",
    });
  });

  it.each([
    "npm install left-pad",
    "pnpm add react",
    "yarn add vite",
    "bun add react",
    "npm run build",
    "bun install && curl https://example.com",
    "npm ci; npm run build",
    "pnpm install | tee install.log",
    "yarn install > install.log",
    "npm ci --registry=https://evil.example",
    "sh -c 'npm ci'",
  ])("denies non-allowlisted network command: %s", (command) => {
    expect(
      evaluateDependencyNetworkRequest({
        command,
        reason: "dependency-install",
      }),
    ).toEqual({
      reason:
        "Dependency installation network access is limited to allowlisted package-manager install commands.",
      status: "denied",
    });
  });
});

describe("createSubmittedRuntimeEnv", () => {
  it("keeps only safe runtime variables while removing agent-only settings and unknown host state", () => {
    const env = createSubmittedRuntimeEnv({
      ANTHROPIC_API_KEY: "secret",
      CONTEXT7_API_KEY: "secret",
      DAYTONA_API_KEY: "secret",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      HTTP_PROXY: "http://proxy.example",
      MAKEADEMO_AGENT_TOKEN: "secret",
      NODE_ENV: "production",
      NPM_CONFIG__AUTH_TOKEN: "secret",
      NPM_CONFIG_TOKEN: "secret",
      NPM_CONFIG_USERCONFIG: "/home/agent/.npmrc",
      MADEMO_AGENT_CONFIG: "/home/agent/.agent/config.json",
      MADEMO_AGENT_CONFIG_CONTENT: "secret config",
      MADEMO_AGENT_ENABLE_EXA: "1",
      MADEMO_AGENT_EXPERIMENTAL_EXA: "1",
      OPENAI_API_KEY: "secret",
      PATH: "/usr/local/bin:/usr/bin",
      R2_ACCESS_KEY_ID: "secret",
      R2_SECRET_ACCESS_KEY: "secret",
      RESEND_API_KEY: "secret",
      OAUTH_CLIENT_SECRET: "secret",
      POSTGRES_PASSWORD: "secret",
      GOOGLE_APPLICATION_CREDENTIALS: "secret",
      GITHUB_PRIVATE_KEY: "secret",
      GITHUB_TOKEN: "secret",
      DATABASE_URL: "postgres://secret",
      SESSION_SECRET: "secret",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      UNKNOWN_ENV: "host state",
      VITE_PUBLIC_DEMO_MODE: "1",
      token: "lowercase-secret",
      npm_config_cache: "/home/agent/.npm",
    });

    expect(env).toEqual({
      NODE_ENV: "production",
      VITE_PUBLIC_DEMO_MODE: "1",
    });
  });
});
