import { afterEach, describe, expect, it, vi } from "vitest";

import {
  connectGitHubAuthorizedInstallation,
  createGitHubAppIntegrationFromEnv,
  createGitHubAuthorizationUrl,
  createGitHubInstallUrl,
  listGitHubInstallationRepositories,
  resolveGitHubRepositoryRevision,
} from "./github-app";

describe("resolveGitHubRepositoryRevision", () => {
  it("resolves one full immutable revision for Project Intake", async () => {
    const commitSha = "c".repeat(40);
    const requests: string[] = [];

    await expect(
      resolveGitHubRepositoryRevision(
        { repoUrl: "https://github.com/example/app" },
        {
          async fetchJson(url) {
            requests.push(url);
            return { sha: commitSha };
          },
        },
      ),
    ).resolves.toBe(commitSha);
    expect(requests).toEqual([
      "https://api.github.com/repos/example/app/commits/HEAD",
    ]);
  });
});

describe("GitHub App integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates the GitHub App authorization URL with the callback redirect URI", () => {
    expect(
      createGitHubAuthorizationUrl({
        clientId: "client-123",
        redirectUrl: "http://localhost:5173/github/callback",
        state: "draft-123",
      }),
    ).toBe(
      "https://github.com/login/oauth/authorize?client_id=client-123&redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fgithub%2Fcallback&state=draft-123",
    );
  });

  it("creates the GitHub App install URL for fresh installations", () => {
    expect(
      createGitHubInstallUrl({
        appSlug: "owlet-demo",
        state: "draft-123",
      }),
    ).toBe(
      "https://github.com/apps/owlet-demo/installations/new?state=draft-123",
    );
  });

  it("routes OAuth callbacks through the API while final callbacks return to the frontend", () => {
    const integration = createGitHubAppIntegrationFromEnv({
      GITHUB_APP_ID: "123",
      GITHUB_APP_SLUG: "owlet-demo",
      GITHUB_CLIENT_ID: "client-123",
      GITHUB_CLIENT_SECRET: "secret-123",
      GITHUB_PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\nprivate-key\n-----END RSA PRIVATE KEY-----",
      GITHUB_REDIRECT_URL: "http://localhost:5173/github/callback",
    });

    expect(integration.createAuthorizationUrl({ state: "draft-123" })).toBe(
      "https://github.com/login/oauth/authorize?client_id=client-123&redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fapi%2Fgithub%2Foauth-callback&state=draft-123",
    );
    expect(
      integration.createCallbackUrl({
        installationId: "123",
        setupAction: "oauth",
        state: "draft-123",
      }),
    ).toBe(
      "http://localhost:5173/github/callback?installation_id=123&setup_action=oauth&state=draft-123",
    );
  });

  it("lists repositories available to an installation", async () => {
    const repositories = await listGitHubInstallationRepositories(
      { installationId: "123" },
      {
        createInstallationToken: async (installationId) => {
          expect(installationId).toBe("123");
          return "token-123";
        },
        fetchJson: async (url, init) => {
          expect(url).toBe("https://api.github.com/installation/repositories");
          expect(init.headers.Authorization).toBe("Bearer token-123");
          return {
            repositories: [
              {
                full_name: "example/private-app",
                html_url: "https://github.com/example/private-app",
                private: true,
              },
            ],
          };
        },
      },
    );

    expect(repositories).toEqual([
      {
        fullName: "example/private-app",
        private: true,
        repoUrl: "https://github.com/example/private-app",
      },
    ]);
  });

  it("uses the existing installation available to an authorized GitHub user", async () => {
    const requests: Array<{ authorization: string; url: string }> = [];
    const connection = await connectGitHubAuthorizedInstallation(
      { code: "oauth-code" },
      {
        createUserAccessToken: async (code) => {
          expect(code).toBe("oauth-code");
          return "user-token";
        },
        fetchJson: async (url, init) => {
          requests.push({
            authorization: init.headers.Authorization ?? "",
            url,
          });

          if (url === "https://api.github.com/user/installations") {
            return { installations: [{ id: 123 }] };
          }

          if (
            url === "https://api.github.com/user/installations/123/repositories"
          ) {
            return {
              repositories: [
                {
                  full_name: "example/private-app",
                  html_url: "https://github.com/example/private-app",
                  private: true,
                },
              ],
            };
          }

          throw new Error(`unexpected GitHub URL: ${url}`);
        },
      },
    );

    expect(connection).toEqual({
      installationId: "123",
      repositories: [
        {
          fullName: "example/private-app",
          private: true,
          repoUrl: "https://github.com/example/private-app",
        },
      ],
    });
    expect(requests).toEqual([
      {
        authorization: "Bearer user-token",
        url: "https://api.github.com/user/installations",
      },
      {
        authorization: "Bearer user-token",
        url: "https://api.github.com/user/installations/123/repositories",
      },
    ]);
  });

  it("returns null when an authorized GitHub user has no existing installations", async () => {
    const connection = await connectGitHubAuthorizedInstallation(
      { code: "oauth-code" },
      {
        createUserAccessToken: async () => "user-token",
        fetchJson: async () => ({ installations: [] }),
      },
    );

    expect(connection).toBeNull();
  });

  it("surfaces GitHub OAuth errors when the authorization code cannot be exchanged", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "bad_verification_code",
          error_description: "The code passed is incorrect or expired.",
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      ),
    );

    const integration = createGitHubAppIntegrationFromEnv({
      GITHUB_APP_ID: "123",
      GITHUB_APP_SLUG: "owlet-demo",
      GITHUB_CLIENT_ID: "client-123",
      GITHUB_CLIENT_SECRET: "secret-123",
      GITHUB_PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\nprivate-key\n-----END RSA PRIVATE KEY-----",
      GITHUB_REDIRECT_URL: "http://localhost:5173/github/callback",
    });

    await expect(
      integration.connectAuthorizedInstallation("expired-code"),
    ).rejects.toThrow(
      "GitHub user access token request failed: bad_verification_code: The code passed is incorrect or expired.",
    );
  });
});
