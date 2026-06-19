// Canonical status -> badge mapping, single source of truth so the deploy-status
// badge cannot drift between the deploys list and the live deploy-log panel.
// Colours follow the Mission Control system (see /styleguide + globals.css).

export function deployStatusBadge(status: string): { className: string; label: string } {
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
