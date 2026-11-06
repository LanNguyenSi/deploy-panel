/**
 * GitHub login comparison helpers.
 *
 * GitHub logins are case-insensitive: `octocat`, `Octocat` and `OCTOCAT` all
 * name the same account, and GitHub may return any casing of a login
 * regardless of how the operator typed the `ALLOWED_GITHUB_LOGINS` entry.
 * Comparing the two exactly let an entry `alice` lock out the real `Alice`
 * (routes/auth.ts), so every login comparison goes through this module:
 * normalise both sides first, then compare.
 */
import { allowedGitHubLogins } from "../config/index.js";

/**
 * Canonical form of a GitHub login for comparison: trimmed and lowercased.
 * Never use it for storage; persisted `githubLogin` values keep GitHub's
 * casing.
 */
export function normalizeGitHubLogin(login: string): string {
  return login.trim().toLowerCase();
}

/**
 * True when `login` passes the allowlist. An empty allowlist means "no
 * allowlist enforced" (accept any verified login, the back-compat default of
 * config.ALLOWED_GITHUB_LOGINS in development and test; production refuses
 * to start with an empty list). Otherwise the check is case-insensitive: the
 * login and every entry are normalised before they are compared, so the
 * entry `alice` admits the GitHub login `Alice`. An empty or whitespace-only
 * login, or an entry that normalises to the empty string, never matches
 * (the config parse drops such entries; the helper keeps the same rule for
 * hand-built lists).
 */
export function isAllowedGitHubLogin(
  login: string,
  allowlist: readonly string[] = allowedGitHubLogins,
): boolean {
  if (allowlist.length === 0) return true;
  const normalizedLogin = normalizeGitHubLogin(login);
  if (normalizedLogin === "") return false;
  return allowlist.some(
    (entry) => normalizeGitHubLogin(entry) === normalizedLogin,
  );
}
