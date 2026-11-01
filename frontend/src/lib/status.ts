// Canonical status -> badge mapping, single source of truth so the deploy-status
// badge cannot drift between the deploys list and the live deploy-log panel.
// Colours follow the Mission Control system (see /styleguide + globals.css).

// How a finished deploy ended as far as the app being up is concerned; the
// backend computes it (backend/src/lib/deploy-log.ts, classifyDeployOutcome)
// and the live deploy log, which only has steps, uses classifyDeployOutcome
// below. Both apply the same rule.
export type DeployOutcome = "success" | "rolled_back_healthy" | "outage";

/** The step agent-relay streams after an automatic rollback has restarted the previous stack and probed it. */
export const ROLLBACK_HEALTH_STEP_NAME = "rollback: health check";

interface OutcomeStep {
  name: string;
  status: string;
  kind?: string;
}

/**
 * A failed deploy is `rolled_back_healthy` only when its LAST
 * `rollback: health check` step succeeded. Every other failed deploy is an
 * `outage`: the step failed or was skipped (rollback unhealthy), or it is
 * absent (rollback disabled, blocked or failed before the health check, or an
 * older relay that never emits the step), which is how every failed deploy
 * looked before the step existed. Healthy is never assumed without the step.
 * No verdict (null) for unfinished, interrupted and manual-rollback rows and
 * for deploys blocked at preflight or refused with a 409 conflict.
 */
export function classifyDeployOutcome(status: string, steps: readonly OutcomeStep[]): DeployOutcome | null {
  if (status === "success") return "success";
  if (status !== "failed") return null;
  if (steps.some((s) => s.kind === "preflight-check" || s.kind === "deploy-conflict")) return null;
  const health = steps.filter((s) => s.name === ROLLBACK_HEALTH_STEP_NAME).at(-1);
  return health?.status === "success" ? "rolled_back_healthy" : "outage";
}

export function deployStatusBadge(
  status: string,
  blocked = false,
  outcome?: DeployOutcome | null,
): { className: string; label: string } {
  // A deploy the relay refused at preflight never touched the app: say so instead of "Failed".
  if (blocked && status === "failed") return { className: "badge-warning", label: "Blocked (preflight)" };
  // The deploy failed but the relay restored the previous version and it passed its health check: the app is up.
  if (status === "failed" && outcome === "rolled_back_healthy") return { className: "badge-warning", label: "Rolled back (healthy)" };
  const map: Record<string, { className: string; label: string }> = {
    success: { className: "badge-success", label: "Success" },
    failed: { className: "badge-danger", label: "Failed" },
    rolled_back: { className: "badge-warning", label: "Rolled back" },
    running: { className: "badge-info", label: "Running" },
    pending: { className: "badge-neutral", label: "Pending" },
    interrupted: { className: "badge-warning", label: "Interrupted" },
  };
  return map[status] ?? { className: "badge-neutral", label: status };
}

// Server status -> badge. Auth (the relay rejected the stored token) is
// amber with an explicit label (a bare "auth" could read as "authenticated")
// and a short hint the pages render as visible text next to the badge, so
// the fix reaches every user, not only mouse users hovering the title.
// unknown (404/5xx/timeout from the relay) is neutral; unexpected values
// fall back to neutral like the deploy badge does.
export function serverStatusBadge(status: string): {
  className: string;
  label: string;
  /** Short fix text to render next to the badge (visible, not only a tooltip). */
  hint?: string;
  /** Extra tooltip; the hint above is the accessible source of this text. */
  title?: string;
} {
  switch (status) {
    case "online":
      return { className: "badge-success", label: status };
    case "offline":
      return { className: "badge-danger", label: status };
    case "no-relay":
      return { className: "badge-warning", label: status };
    case "auth":
      return {
        className: "badge-warning",
        label: "auth failed",
        hint: "check relay token",
        title: "The relay rejected the stored token; check the relay token on this server",
      };
    default:
      return { className: "badge-neutral", label: status };
  }
}
