// Canonical status -> badge mapping, single source of truth so the deploy-status
// badge cannot drift between the deploys list and the live deploy-log panel.
// Colours follow the Mission Control system (see /styleguide + globals.css).

export function deployStatusBadge(status: string, blocked = false): { className: string; label: string } {
  // A deploy the relay refused at preflight never touched the app: say so instead of "Failed".
  if (blocked && status === "failed") return { className: "badge-warning", label: "Blocked (preflight)" };
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
