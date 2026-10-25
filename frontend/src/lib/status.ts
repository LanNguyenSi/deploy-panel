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
