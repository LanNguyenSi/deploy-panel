/**
 * Minimal GitHub API helper for the identity-broker registration path.
 *
 * Mirrors the same shape already in agent-tasks and project-forge — the
 * three modules re-verify the broker-supplied access-token independently
 * against GitHub so a compromised broker cannot impersonate users.
 */

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  email: string | null;
}

export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

export class GitHubUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubUnreachableError";
  }
}

const GITHUB_TIMEOUT_MS = 5_000;

export interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

// Scopes for the native login flow. Intentionally narrow — deploy-panel
// doesn't need repo-wide access here; just identity. Contrast the broker
// path (project-pilot) which requests `repo` because it provisions
// downstream modules that may need it.
const OAUTH_SCOPES = "read:user read:org";

export function buildAuthorizationUrl(cfg: OAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: OAUTH_SCOPES,
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export async function exchangeCodeForToken(
  cfg: OAuthConfig,
  code: string,
): Promise<GitHubTokenResponse> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: cfg.redirectUri,
    }),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new GitHubUnreachableError(`Token exchange failed: ${response.status}`);
  }

  const data = (await response.json()) as GitHubTokenResponse & { error?: string };
  if (data.error) {
    throw new GitHubAuthError(`GitHub OAuth error: ${data.error}`);
  }
  return data;
}

export function generateOAuthState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  let response: Response;
  try {
    response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GitHubUnreachableError(
      `Could not reach GitHub: ${(err as Error).message}`,
    );
  }

  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new GitHubAuthError(
      `GitHub rejected the access-token (${response.status})`,
    );
  }
  if (!response.ok) {
    throw new GitHubUnreachableError(`GitHub API returned ${response.status}`);
  }

  return response.json() as Promise<GitHubUser>;
}
