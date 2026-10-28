// Dashboard status summary: answers "is anything wrong or running right now"
// from the server list and the recent deploy list the dashboard already loads.
// Pure function so every state is unit-testable without rendering.

import { deployStatusBadge } from "./status";

export interface StatusServer {
  id: string;
  name: string;
  status: string;
}

export interface StatusDeploy {
  id: string;
  status: string;
  blocked?: boolean;
  createdAt: string;
  serverId?: string;
  appId?: string;
  app: { name: string };
  server: { name: string };
}

export interface StatusIssue {
  key: string;
  /** What the issue is about, e.g. "srv-a" or "my-app on srv-a". */
  subject: string;
  /** Short state in words, e.g. "offline" or "last deploy failed". */
  detail: string;
  /** Status dot suffix (status-dot-<tone>). */
  tone: "offline" | "failed" | "no-relay" | "warning";
  href: string;
}

export interface RunningDeploy {
  key: string;
  subject: string;
}

export type DashboardLevel = "attention" | "running" | "unchecked" | "ok" | "empty";

export interface DashboardStatus {
  level: DashboardLevel;
  issues: StatusIssue[];
  running: RunningDeploy[];
  serversOnline: number;
  serversTotal: number;
  /** Servers that are neither online nor flagged (offline, no relay), e.g. status unknown. */
  serversUnchecked: number;
}

// Deploy outcomes that need a human. `success` is fine; `running` and `pending`
// are handled as in-flight, never as a problem. The tone follows the canonical
// badge mapping (deployStatusBadge): danger is red, warning is amber.
const PROBLEM_DEPLOY_STATUS = new Set(["failed", "interrupted", "rolled_back"]);

export function summarizeDashboardStatus(servers: StatusServer[], deploys: StatusDeploy[]): DashboardStatus {
  const issues: StatusIssue[] = [];

  for (const s of servers) {
    if (s.status === "offline") {
      issues.push({ key: `server-${s.id}`, subject: s.name, detail: "offline", tone: "offline", href: `/servers/${s.id}` });
    } else if (s.status === "no-relay") {
      issues.push({ key: `server-${s.id}`, subject: s.name, detail: "no relay installed", tone: "no-relay", href: `/servers/${s.id}` });
    }
  }

  // Only the newest deploy of each app on each server counts: a later success
  // supersedes an earlier failure, so a fixed problem stops showing up.
  const newestFirst = [...deploys].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const seen = new Set<string>();
  const running: RunningDeploy[] = [];
  for (const d of newestFirst) {
    const key = `${d.serverId ?? d.server.name}/${d.appId ?? d.app.name}`;
    const subject = `${d.app.name} on ${d.server.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (d.status === "running") running.push({ key: `run-${d.id}`, subject });
    if (PROBLEM_DEPLOY_STATUS.has(d.status)) {
      const badge = deployStatusBadge(d.status, d.blocked);
      const tone: StatusIssue["tone"] = badge.className === "badge-danger" ? "failed" : "warning";
      const label = badge.label.toLowerCase();
      issues.push({ key: `deploy-${d.id}`, subject, detail: `last deploy ${label}`, tone, href: "/deploys" });
    }
  }

  const serversOnline = servers.filter((s) => s.status === "online").length;
  const serversUnchecked = servers.filter((s) => s.status !== "online" && s.status !== "offline" && s.status !== "no-relay").length;
  const level: DashboardLevel =
    issues.length > 0
      ? "attention"
      : running.length > 0
        ? "running"
        : servers.length === 0
          ? "empty"
          : serversUnchecked > 0
            ? "unchecked"
            : "ok";

  return { level, issues, running, serversOnline, serversTotal: servers.length, serversUnchecked };
}
