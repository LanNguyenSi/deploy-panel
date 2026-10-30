"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  getServers,
  createServer,
  deleteServer,
  testServer,
  getServerSystem,
  getServerRelayStatus,
  selfUpdateServerRelay,
  type ServerWithCount,
  type SystemMetrics,
  type ServerRelayStatus,
} from "@/lib/api";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { serverStatusBadge } from "@/lib/status";
import { ServerInstallWizard } from "@/components/ServerInstallWizard";
import { ServerUpdateImageDialog } from "@/components/ServerUpdateImageDialog";
import { EmptyStateIcon } from "@/components/EmptyStateIcon";

function shortRev(rev: string | null | undefined): string {
  return rev ? rev.slice(0, 7) : "unknown";
}

export default function ServersPage() {
  const [servers, setServers] = useState<ServerWithCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [updatingRelay, setUpdatingRelay] = useState<string | null>(null);
  const [sshFallbackServer, setSshFallbackServer] = useState<ServerWithCount | null>(null);
  const [metrics, setMetrics] = useState<Record<string, SystemMetrics>>({});
  const [relayStatuses, setRelayStatuses] = useState<Record<string, ServerRelayStatus>>({});
  const { toast } = useToast();
  const { confirm } = useConfirm();

  async function load() {
    try {
      const data = await getServers();
      setServers(data.servers);
      // Fetch metrics and relay revision status for each server in parallel
      const metricsMap: Record<string, SystemMetrics> = {};
      const relayMap: Record<string, ServerRelayStatus> = {};
      await Promise.allSettled(
        data.servers.map(async (s) => {
          await Promise.allSettled([
            (async () => {
              try {
                metricsMap[s.id] = await getServerSystem(s.id);
              } catch { /* ignore — server may not have relay */ }
            })(),
            (async () => {
              try {
                relayMap[s.id] = await getServerRelayStatus(s.id);
              } catch { /* ignore — fail soft to unknown */ }
            })(),
          ]);
        }),
      );
      setMetrics(metricsMap);
      setRelayStatuses(relayMap);
    } catch (err) {
      console.error("Failed to load servers:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, []);

  async function handleTest(id: string) {
    setTesting(id);
    try {
      const result = await testServer(id);
      toast(`Server ${result.status}${result.message ? ` — ${result.message}` : ""}`, result.status === "online" ? "success" : "error");
      await load();
    } catch (err: any) {
      toast(`Test failed: ${err.message}`, "error");
    } finally {
      setTesting(null);
    }
  }

  async function handleRelaySelfUpdate(server: ServerWithCount) {
    setUpdatingRelay(server.id);
    try {
      const result = await selfUpdateServerRelay(server.id);
      toast(
        `Relay on "${server.name}" updated (${shortRev(result.previousRevision)} → ${shortRev(result.relayRevision)})`,
        "success",
      );
      await load();
    } catch (err: any) {
      toast(`Relay self-update failed: ${err.message}`, "error");
    } finally {
      setUpdatingRelay(null);
    }
  }

  async function handleDelete(id: string, name: string) {
    const ok = await confirm({
      title: "Delete Server",
      message: `Delete "${name}"? This also removes all associated apps and deploy history.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteServer(id);
      toast(`Server "${name}" deleted`, "success");
      await load();
    } catch (err: any) {
      toast(`Delete failed: ${err.message}`, "error");
    }
  }

  return (
    <main className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">Servers</h1>
          <p className="page-subtitle">{servers.length} server{servers.length !== 1 ? "s" : ""} configured</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="btn btn-primary">
          {showForm ? "Cancel" : "+ Add Server"}
        </button>
      </div>

      {showForm && (
        <div className="animate-slide-up">
          <ServerAddPanel
            onDone={() => {
              setShowForm(false);
              toast("Server added", "success");
              load();
            }}
            onCancel={() => setShowForm(false)}
          />
        </div>
      )}

      {loading ? (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {[1, 2].map((i) => (
            <div key={i} className="card skeleton" style={{ height: 80 }} />
          ))}
        </div>
      ) : servers.length === 0 ? (
        <div className="card empty-state">
          <EmptyStateIcon name="server" />
          <div className="empty-state-title">No servers configured</div>
          <div className="empty-state-text">Add a server to start managing your deployments.</div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {servers.map((s) => {
            const rs = relayStatuses[s.id];
            const isOutdated = rs?.relayOutdated === true;
            const badge = serverStatusBadge(s.status);
            return (
            <div key={s.id} className="card" style={{ padding: "var(--space-4) var(--space-5)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "var(--space-3)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", minWidth: 0 }}>
                  <span className={`status-dot status-dot-${s.status}`} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--space-2)" }}>
                      <Link href={`/servers/${s.id}`} style={{ fontWeight: 600, color: "var(--text)", fontSize: "var(--text-md)" }}>
                        {s.name}
                      </Link>
                      {isOutdated && (
                        <span
                          data-testid={`relay-outdated-${s.id}`}
                          className="badge badge-warning"
                          title={`Running relay commit ${rs?.relayRevision ?? "unknown"} is behind published latest ${rs?.latestRevision ?? "unknown"}`}
                        >
                          <span aria-hidden="true">▲</span> Relay outdated ({shortRev(rs?.relayRevision)} → {shortRev(rs?.latestRevision)})
                        </span>
                      )}
                      {rs?.relayOutdated === false && rs.relayRevision && (
                        <span
                          data-testid={`relay-current-${s.id}`}
                          className="badge badge-neutral"
                          title={`Relay image revision ${rs.relayRevision} matches latest published image`}
                        >
                          Relay {shortRev(rs.relayRevision)}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: "var(--text-sm)", color: "var(--muted)", marginTop: 2 }}>
                      {s.host} · {s._count.apps} app{s._count.apps !== 1 ? "s" : ""}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--space-2)" }}>
                  <span className={`badge ${badge.className}`} title={badge.title}>
                    {badge.label}
                  </span>
                  {badge.hint && (
                    <span
                      data-testid={`status-hint-${s.id}`}
                      style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}
                    >
                      {badge.hint}
                    </span>
                  )}
                  {isOutdated && (
                    <button
                      type="button"
                      onClick={() => void handleRelaySelfUpdate(s)}
                      disabled={updatingRelay === s.id}
                      className="btn btn-primary btn-sm"
                    >
                      {updatingRelay === s.id ? "Updating relay..." : "Update relay"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setSshFallbackServer(s)}
                    className="btn btn-ghost btn-sm"
                  >
                    Update via SSH (fallback)
                  </button>
                  <button onClick={() => handleTest(s.id)} disabled={testing === s.id} className="btn btn-secondary btn-sm">
                    {testing === s.id ? "Testing..." : "Test"}
                  </button>
                  <button onClick={() => handleDelete(s.id, s.name)} className="btn btn-danger btn-sm">
                    Delete
                  </button>
                </div>
              </div>
              {/* Health metrics */}
              {metrics[s.id] && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-4)", marginTop: "var(--space-3)", paddingTop: "var(--space-3)", borderTop: "1px solid var(--border)" }}>
                  <MetricBar label="CPU" value={metrics[s.id].cpu.usage} max={100} unit="%" />
                  <MetricBar label="RAM" value={metrics[s.id].memory.usedMb} max={metrics[s.id].memory.totalMb} unit="MB" />
                  <MetricBar label="Disk" value={parseInt(metrics[s.id].disk.percent)} max={100} unit="%" />
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}

      {sshFallbackServer && (
        <ServerUpdateImageDialog
          serverId={sshFallbackServer.id}
          serverName={sshFallbackServer.name}
          serverHost={sshFallbackServer.host}
          defaultRelayDir={sshFallbackServer.relayDir ?? null}
          defaultRelayComposeFile={sshFallbackServer.relayComposeFile ?? null}
          onClose={() => setSshFallbackServer(null)}
          onUpdated={() => {
            void load();
            toast("Relay image updated", "success");
          }}
        />
      )}
    </main>
  );
}

/**
 * Parent panel for the add-server flow. Offers two entry points:
 * "Install relay for me" (SSH-wizard from ServerInstallWizard) and
 * "I already have a relay" (legacy manual form). The choice is
 * local state — no deep links, no cookies; refresh resets to the
 * chooser.
 */
function ServerAddPanel({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [mode, setMode] = useState<"choose" | "wizard" | "manual">("choose");

  if (mode === "wizard") {
    return (
      <ServerInstallWizard
        onCreated={onDone}
        onCancel={onCancel}
        onSwitchToManual={() => setMode("manual")}
      />
    );
  }
  if (mode === "manual") {
    return <AddServerForm onCreated={onDone} onCancel={onCancel} onSwitchToWizard={() => setMode("wizard")} />;
  }
  return (
    <div className="card" style={{ padding: "var(--space-5)", marginBottom: "var(--space-6)" }}>
      <h3 style={{ fontSize: "var(--text-md)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
        Add Server
      </h3>
      <p style={{ fontSize: "var(--text-sm)", color: "var(--muted)", marginBottom: "var(--space-4)" }}>
        How do you want to connect this server?
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-3)" }}>
        <button
          type="button"
          className="card"
          onClick={() => setMode("wizard")}
          style={{
            padding: "var(--space-4)",
            textAlign: "left",
            cursor: "pointer",
            border: "1px solid var(--border)",
            background: "var(--surface)",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Install relay for me</div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
            Runs agent-relay&apos;s installer on a fresh VPS via ephemeral SSH.
            Credentials are used once and discarded.
          </div>
        </button>
        <button
          type="button"
          className="card"
          onClick={() => setMode("manual")}
          style={{
            padding: "var(--space-4)",
            textAlign: "left",
            cursor: "pointer",
            border: "1px solid var(--border)",
            background: "var(--surface)",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>I already have a relay</div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
            Paste the URL and token from a relay you already installed.
          </div>
        </button>
      </div>
      <div style={{ marginTop: "var(--space-3)", textAlign: "right" }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function AddServerForm({
  onCreated,
  onCancel,
  onSwitchToWizard,
}: {
  onCreated: () => void;
  onCancel?: () => void;
  onSwitchToWizard?: () => void;
}) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [relayUrl, setRelayUrl] = useState("");
  const [relayToken, setRelayToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await createServer({ name, host, relayUrl: relayUrl || undefined, relayToken: relayToken || undefined });
      onCreated();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card" style={{ padding: "var(--space-5)", marginBottom: "var(--space-6)" }}>
      <h3 style={{ fontSize: "var(--text-md)", fontWeight: 600, marginBottom: "var(--space-4)" }}>Add Server</h3>
      <div className="grid-form">
        <div>
          <label htmlFor="srv-name" style={{ display: "block", fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "var(--space-1)", fontWeight: 500 }}>
            Server name
          </label>
          <input id="srv-name" type="text" placeholder="e.g. Production VPS" value={name} onChange={(e) => setName(e.target.value)} required className="input" />
        </div>
        <div>
          <label htmlFor="srv-host" style={{ display: "block", fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "var(--space-1)", fontWeight: 500 }}>
            Host
          </label>
          <input id="srv-host" type="text" placeholder="e.g. 192.168.1.100" value={host} onChange={(e) => setHost(e.target.value)} required className="input" />
        </div>
        <div>
          <label htmlFor="srv-relay-url" style={{ display: "block", fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "var(--space-1)", fontWeight: 500 }}>
            Relay URL <span style={{ color: "var(--muted)" }}>(optional)</span>
          </label>
          <input id="srv-relay-url" type="url" placeholder="https://relay.example.com" value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)} className="input" />
        </div>
        <div>
          <label htmlFor="srv-relay-token" style={{ display: "block", fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "var(--space-1)", fontWeight: 500 }}>
            Relay token <span style={{ color: "var(--muted)" }}>(optional)</span>
          </label>
          <input id="srv-relay-token" type="text" placeholder="Token" value={relayToken} onChange={(e) => setRelayToken(e.target.value)} className="input" />
        </div>
      </div>
      {error && <p className="form-error" style={{ marginTop: "var(--space-3)" }}>{error}</p>}
      <div style={{ marginTop: "var(--space-4)", display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
        <button type="submit" disabled={submitting} className="btn btn-primary">
          {submitting ? "Adding..." : "Add Server"}
        </button>
        {onSwitchToWizard && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onSwitchToWizard}>
            Or install a relay via SSH
          </button>
        )}
        {onCancel && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} style={{ marginLeft: "auto" }}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function MetricBar({ label, value, max, unit }: { label: string; value: number; max: number; unit: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const color = pct > 90 ? "var(--danger)" : pct > 75 ? "var(--warning)" : "var(--primary)";

  return (
    <div style={{ flex: "1 1 120px", minWidth: 120 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-2)", fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: 4 }}>
        <span>{label}</span>
        <span style={{ whiteSpace: "nowrap" }}>{unit === "MB" ? `${value}/${max} ${unit}` : `${Math.round(pct)}${unit}`}</span>
      </div>
      <div style={{ height: 4, background: "var(--border)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 2, transition: "width 0.3s ease" }} />
      </div>
    </div>
  );
}
