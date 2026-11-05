export interface AuditAction {
  value: string;
  label: string;
  badgeClass: string;
}

export const AUDIT_ACTIONS: AuditAction[] = [
  { value: "deploy", label: "Deploy", badgeClass: "badge-success" },
  { value: "rollback", label: "Rollback", badgeClass: "badge-warning" },
  { value: "bulk-deploy", label: "Bulk deploy", badgeClass: "badge-success" },
  { value: "server.create", label: "Server created", badgeClass: "badge-info" },
  { value: "server.delete", label: "Server deleted", badgeClass: "badge-danger" },
  { value: "server.probe-vps.success", label: "Probe VPS success", badgeClass: "badge-success" },
  { value: "server.probe-vps.failed", label: "Probe VPS failed", badgeClass: "badge-danger" },
  { value: "server.install-relay.success", label: "Relay install success", badgeClass: "badge-success" },
  { value: "server.install-relay.failed", label: "Relay install failed", badgeClass: "badge-danger" },
  { value: "server.reinstall-relay.success", label: "Relay reinstall success", badgeClass: "badge-success" },
  { value: "server.reinstall-relay.failed", label: "Relay reinstall failed", badgeClass: "badge-danger" },
  { value: "server.update-relay-image.success", label: "Relay image update success", badgeClass: "badge-success" },
  { value: "server.update-relay-image.failed", label: "Relay image update failed", badgeClass: "badge-danger" },
  { value: "server.relay-self-update.success", label: "Relay self-update success", badgeClass: "badge-success" },
  { value: "server.relay-self-update.pending", label: "Relay self-update pending", badgeClass: "badge-warning" },
  { value: "server.relay-self-update.failed", label: "Relay self-update failed", badgeClass: "badge-danger" },
  { value: "api_key.create", label: "API key created", badgeClass: "badge-info" },
  { value: "api_key.revoke", label: "API key revoked", badgeClass: "badge-warning" },
  { value: "app.env.updated", label: "Env updated", badgeClass: "badge-info" },
  { value: "app.required_env_keys.updated", label: "Required env keys updated", badgeClass: "badge-info" },
  { value: "app.secret.set", label: "Secret set", badgeClass: "badge-info" },
  { value: "app.secret.delete", label: "Secret deleted", badgeClass: "badge-danger" },
  { value: "app.live_url", label: "Live URL updated", badgeClass: "badge-info" },
  { value: "schedule.create", label: "Schedule created", badgeClass: "badge-info" },
  { value: "schedule.cancel", label: "Schedule cancelled", badgeClass: "badge-warning" },
  { value: "user.login", label: "User login", badgeClass: "badge-neutral" },
];
