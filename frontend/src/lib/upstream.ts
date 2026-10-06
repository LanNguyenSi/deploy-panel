import type { AppUpstream } from "@/lib/api";

// Display logic for the per-app "outdated" badge. State is always conveyed
// by a text label plus an icon glyph, never by colour alone.

export type UpstreamView = {
  state: "current" | "outdated" | "unknown" | "checking";
  label: string;
  icon: string;
  badgeClass: string;
  reason: string | null;
};

const NOT_REPORTED = "relay does not report upstream";
export const CHECK_FAILED = "upstream check failed";

/** The value every app gets when the upstream request itself fails. */
export function failedUpstream(): AppUpstream {
  return { branch: null, deployedCommit: null, remoteHead: null, checkedAt: null, state: "unknown", reason: CHECK_FAILED };
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "?";
}

/** The relay's "behind" is shown as "outdated" (deployed commit differs from the remote branch head). */
export function describeUpstream(up: AppUpstream | undefined | null, pending = false): UpstreamView {
  if (pending && !up) {
    return { state: "checking", label: "Checking", icon: "…", badgeClass: "badge-neutral", reason: null };
  }
  if (up?.state === "current") {
    return { state: "current", label: "Current", icon: "✓", badgeClass: "badge-success", reason: null };
  }
  if (up?.state === "behind") {
    return { state: "outdated", label: "Outdated", icon: "▲", badgeClass: "badge-warning", reason: null };
  }
  return {
    state: "unknown",
    label: "Unknown",
    icon: "?",
    badgeClass: "badge-neutral",
    reason: up?.reason || NOT_REPORTED,
  };
}

export function countOutdated(apps: Array<{ upstream?: AppUpstream | null }>): number {
  return apps.filter((a) => describeUpstream(a.upstream).state === "outdated").length;
}

/**
 * GitHub compare link, only for an app whose known repo URL is on github.com
 * and only when both full commits are known.
 */
export function githubCompareUrl(
  repoUrl: string | null | undefined,
  up: AppUpstream | undefined | null,
): string | null {
  if (!repoUrl || !up?.deployedCommit || !up.remoteHead) return null;
  const m = repoUrl
    .trim()
    .match(/^(?:https:\/\/|git@|ssh:\/\/git@)github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}/compare/${up.deployedCommit}...${up.remoteHead}`;
}

export function formatCheckedAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
