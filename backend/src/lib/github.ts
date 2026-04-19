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
