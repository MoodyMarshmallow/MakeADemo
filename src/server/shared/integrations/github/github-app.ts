export type GitHubRepository = {
  fullName: string;
  private: boolean;
  repoUrl: string;
};

export type GitHubRepositoryListDependencies = {
  createInstallationToken(installationId: string): Promise<string>;
  fetchJson(
    url: string,
    init: { headers: Record<string, string> },
  ): Promise<unknown>;
};

export type GitHubRepositoryRevisionDependencies = {
  createInstallationToken?(installationId: string): Promise<string>;
  fetchJson(
    url: string,
    init: { headers: Record<string, string> },
  ): Promise<unknown>;
};

export type GitHubAuthorizedInstallation = {
  installationId: string;
  repositories: GitHubRepository[];
};

export type GitHubAuthorizedInstallationDependencies = {
  createUserAccessToken(code: string): Promise<string>;
  fetchJson(
    url: string,
    init: { headers: Record<string, string> },
  ): Promise<unknown>;
};

type GitHubAppEnvironment = {
  appId: string;
  appSlug: string;
  clientId?: string;
  clientSecret?: string;
  privateKey: string;
  redirectUrl: string;
};

type GitHubApiRepository = {
  full_name?: unknown;
  html_url?: unknown;
  private?: unknown;
};

type GitHubApiUserInstallation = {
  id?: unknown;
};

export function createGitHubInstallUrl(input: {
  appSlug: string;
  state: string;
}): string {
  const params = new URLSearchParams();
  params.set("state", input.state);

  return `https://github.com/apps/${input.appSlug}/installations/new?${params.toString()}`;
}

export function createGitHubAuthorizationUrl(input: {
  clientId: string;
  redirectUrl: string;
  state: string;
}): string {
  const params = new URLSearchParams();
  params.set("client_id", input.clientId);
  params.set("redirect_uri", input.redirectUrl);
  params.set("state", input.state);

  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export async function listGitHubInstallationRepositories(
  input: { installationId: string },
  dependencies: GitHubRepositoryListDependencies,
): Promise<GitHubRepository[]> {
  const token = await dependencies.createInstallationToken(
    input.installationId,
  );
  const response = await dependencies.fetchJson(
    "https://api.github.com/installation/repositories",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  const repositories = readRepositories(response);

  return repositories.map((repository) => ({
    fullName: repository.full_name,
    private: repository.private,
    repoUrl: repository.html_url,
  }));
}

/** Resolves the repository's current default-branch head to one full commit SHA. */
export async function resolveGitHubRepositoryRevision(
  input: { githubInstallationId?: string; repoUrl: string },
  dependencies: GitHubRepositoryRevisionDependencies,
): Promise<string> {
  const repository = readGitHubRepositoryName(input.repoUrl);
  const token =
    input.githubInstallationId === undefined
      ? undefined
      : await dependencies.createInstallationToken?.(
          input.githubInstallationId,
        );
  if (input.githubInstallationId !== undefined && token === undefined) {
    throw new Error("GitHub installation authentication is unavailable");
  }
  const response = await dependencies.fetchJson(
    `https://api.github.com/repos/${repository}/commits/HEAD`,
    {
      headers: {
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (
    typeof response !== "object" ||
    response === null ||
    Array.isArray(response) ||
    typeof (response as { sha?: unknown }).sha !== "string" ||
    !/^[0-9a-f]{40}$/i.test((response as { sha: string }).sha)
  ) {
    throw new Error("GitHub revision response is missing a full commit SHA");
  }
  return (response as { sha: string }).sha.toLowerCase();
}

export async function connectGitHubAuthorizedInstallation(
  input: { code: string },
  dependencies: GitHubAuthorizedInstallationDependencies,
): Promise<GitHubAuthorizedInstallation | null> {
  const token = await dependencies.createUserAccessToken(input.code);
  const response = await dependencies.fetchJson(
    "https://api.github.com/user/installations",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  const installations = readUserInstallations(response);
  const installation = installations[0];
  if (!installation) {
    return null;
  }

  const installationId = String(installation.id);
  return {
    installationId,
    repositories: await listGitHubUserInstallationRepositories(
      { installationId, token },
      { fetchJson: dependencies.fetchJson },
    ),
  };
}

export function createGitHubAppIntegrationFromEnv(
  env: NodeJS.ProcessEnv = process.env,
) {
  const app = readGitHubAppEnvironment(env);

  return {
    createAuthorizationUrl(input: { state: string }) {
      return createGitHubAuthorizationUrl({
        clientId: readGitHubClientId(app),
        redirectUrl: createGitHubOAuthCallbackUrl(app.redirectUrl),
        state: input.state,
      });
    },
    createCallbackUrl(input: {
      installationId: string;
      setupAction: string;
      state: string;
    }) {
      return createGitHubCallbackUrl(app.redirectUrl, input);
    },
    createInstallUrl(input: { state: string }) {
      return createGitHubInstallUrl({
        appSlug: app.appSlug,
        state: input.state,
      });
    },
    listRepositories(installationId: string) {
      return listGitHubInstallationRepositories(
        { installationId },
        {
          createInstallationToken: (id) => createInstallationToken(id, app),
          fetchJson,
        },
      );
    },
    resolveRepositoryRevision(input: {
      githubInstallationId?: string;
      repoUrl: string;
    }) {
      return resolveGitHubRepositoryRevision(input, {
        createInstallationToken: (id) => createInstallationToken(id, app),
        fetchJson,
      });
    },
    connectAuthorizedInstallation(code: string) {
      return connectGitHubAuthorizedInstallation(
        { code },
        {
          createUserAccessToken: (nextCode) =>
            createGitHubUserAccessToken(nextCode, app),
          fetchJson,
        },
      );
    },
  };
}

function readGitHubRepositoryName(repoUrl: string) {
  const url = new URL(repoUrl);
  const parts = url.pathname
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    parts.length !== 2
  ) {
    throw new Error("repoUrl must identify one GitHub repository");
  }
  return `${parts[0]}/${parts[1]}`;
}

async function listGitHubUserInstallationRepositories(
  input: { installationId: string; token: string },
  dependencies: Pick<GitHubRepositoryListDependencies, "fetchJson">,
): Promise<GitHubRepository[]> {
  const response = await dependencies.fetchJson(
    `https://api.github.com/user/installations/${input.installationId}/repositories`,
    {
      headers: {
        Authorization: `Bearer ${input.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  const repositories = readRepositories(response);

  return repositories.map((repository) => ({
    fullName: repository.full_name,
    private: repository.private,
    repoUrl: repository.html_url,
  }));
}

async function createGitHubUserAccessToken(
  code: string,
  app: GitHubAppEnvironment,
): Promise<string> {
  if (!app.clientId || !app.clientSecret) {
    throw new Error(
      "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required for GitHub authorization callbacks",
    );
  }

  const params = new URLSearchParams({
    client_id: app.clientId,
    client_secret: app.clientSecret,
    code,
    redirect_uri: createGitHubOAuthCallbackUrl(app.redirectUrl),
  });
  const response = await fetch("https://github.com/login/oauth/access_token", {
    body: params,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const oauthError = formatGitHubOAuthError(body);
    throw new Error(
      `GitHub user access token request failed: ${response.status}${oauthError ? `: ${oauthError}` : ""}`,
    );
  }

  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    typeof (body as { access_token?: unknown }).access_token !== "string"
  ) {
    const oauthError = formatGitHubOAuthError(body);
    if (oauthError) {
      throw new Error(`GitHub user access token request failed: ${oauthError}`);
    }

    throw new Error("GitHub user access token response is missing token");
  }

  return (body as { access_token: string }).access_token;
}

async function createInstallationToken(
  installationId: string,
  app: GitHubAppEnvironment,
): Promise<string> {
  const jwt = createGitHubAppJwt(app);
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new Error(
      `GitHub installation token request failed: ${response.status}`,
    );
  }

  const body = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    typeof (body as { token?: unknown }).token !== "string"
  ) {
    throw new Error("GitHub installation token response is missing token");
  }

  return (body as { token: string }).token;
}

function createGitHubAppJwt(app: GitHubAppEnvironment): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      exp: now + 60 * 10,
      iat: now - 60,
      iss: app.appId,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(normalizePrivateKey(app.privateKey));

  return `${unsigned}.${base64Url(signature)}`;
}

async function fetchJson(
  url: string,
  init: { headers: Record<string, string> },
) {
  const response = await fetch(url, { headers: init.headers });
  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status}`);
  }

  return response.json();
}

function readGitHubAppEnvironment(
  env: NodeJS.ProcessEnv,
): GitHubAppEnvironment {
  const appId = readRequiredEnv(env, "GITHUB_APP_ID");
  const appSlug = readRequiredEnv(env, "GITHUB_APP_SLUG");
  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  const privateKey = readRequiredEnv(env, "GITHUB_PRIVATE_KEY");
  const redirectUrl =
    env.GITHUB_REDIRECT_URL ?? "http://localhost:5173/github/callback";

  return {
    appId,
    appSlug,
    ...(clientId === undefined ? {} : { clientId }),
    ...(clientSecret === undefined ? {} : { clientSecret }),
    privateKey,
    redirectUrl,
  };
}

function readRequiredEnv(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function readGitHubClientId(app: GitHubAppEnvironment) {
  if (!app.clientId) {
    throw new Error("GITHUB_CLIENT_ID is required for GitHub authorization");
  }

  return app.clientId;
}

function createGitHubOAuthCallbackUrl(frontendCallbackUrl: string) {
  const url = new URL(frontendCallbackUrl);
  url.pathname = "/api/github/oauth-callback";
  url.search = "";
  url.hash = "";

  return url.toString();
}

function createGitHubCallbackUrl(
  frontendCallbackUrl: string,
  input: { installationId: string; setupAction: string; state: string },
) {
  const url = new URL(frontendCallbackUrl);
  url.search = "";
  url.searchParams.set("installation_id", input.installationId);
  url.searchParams.set("setup_action", input.setupAction);
  url.searchParams.set("state", input.state);

  return url.toString();
}

function formatGitHubOAuthError(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "";
  }

  const error = (value as { error?: unknown }).error;
  if (typeof error !== "string" || error.length === 0) {
    return "";
  }

  const description = (value as { error_description?: unknown })
    .error_description;
  if (typeof description !== "string" || description.length === 0) {
    return error;
  }

  return `${error}: ${description}`;
}

function normalizePrivateKey(privateKey: string) {
  return privateKey.replaceAll("\\n", "\n");
}

function base64Url(value: Buffer | string) {
  const buffer = typeof value === "string" ? Buffer.from(value) : value;

  return buffer
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function readRepositories(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub repository response must be an object");
  }

  const repositories = (value as { repositories?: unknown }).repositories;
  if (!Array.isArray(repositories)) {
    throw new Error("GitHub repository response must include repositories");
  }

  return repositories.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`repositories[${index}] must be an object`);
    }

    const repository = item as GitHubApiRepository;
    if (
      typeof repository.full_name !== "string" ||
      typeof repository.html_url !== "string" ||
      typeof repository.private !== "boolean"
    ) {
      throw new Error(`repositories[${index}] is missing required fields`);
    }

    return {
      full_name: repository.full_name,
      html_url: repository.html_url,
      private: repository.private,
    };
  });
}

function readUserInstallations(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub user installations response must be an object");
  }

  const installations = (value as { installations?: unknown }).installations;
  if (!Array.isArray(installations)) {
    throw new Error(
      "GitHub user installations response must include installations",
    );
  }

  return installations.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`installations[${index}] must be an object`);
    }

    const installation = item as GitHubApiUserInstallation;
    if (
      typeof installation.id !== "number" &&
      typeof installation.id !== "string"
    ) {
      throw new Error(`installations[${index}] is missing id`);
    }

    return { id: installation.id };
  });
}
import { createSign } from "node:crypto";
