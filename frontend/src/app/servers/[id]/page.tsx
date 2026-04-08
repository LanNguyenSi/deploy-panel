"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { getServer, getApps, deployApp, getDeployStatus, rollbackApp, getAppLogs, getAppPreflight, syncServer, tagApp, hideApp, type AppWithCount } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { requestPermission, notifyDeployResult } from "@/lib/notifications";
import { isPinned, togglePin } from "@/lib/pinned";

type Panel = { type: "logs" | "deploy" | "preflight"; app: string };

export default function ServerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [serverName, setServerName] = useState("");
  const [apps, setApps] = useState<AppWithCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [deploying, setDeploying] = useState<string | null>(null);
  const [deployLog, setDeployLog] = useState<{ status: string; steps: Array<{ name: string; status: string; durationMs: number }> } | null>(null);
  const [preflight, setPreflight] = useState<{ passed: boolean; checks: Array<{ name: string; passed: boolean; message: string }> } | null>(null);
  const { toast } = useToast();
  const { confirm } = useConfirm();

  async function load() {
    try {
      const [serverData, appsData] = await Promise.all([
        getServer(id),
        getApps(id),
      ]);
      setServerName(serverData.server.name);
      setApps(appsData.apps);
    } catch (err) {
      console.error("Failed to load:", err);
    } finally {
      setLoading(false);
    }
  }

  async function autoSync() {
    setSyncing(true);
    try {
      await syncServer(id);
      const appsData = await getApps(id);
      setApps(appsData.apps);
    } catch {
      // Silent fail — sync is best-effort
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    load().then(() => autoSync());
  }, [id]);

  async function handleDeploy(name: string) {
    requestPermission(); // Ask once, browser remembers the answer
    const ok = await confirm({ title: "Deploy", message: `Deploy "${name}"?`, confirmLabel: "Deploy" });
    if (!ok) return;

    setDeploying(name);
    setPanel({ type: "deploy", app: name });
    setLogs(null);
    setPreflight(null);
    setDeployLog({ status: "running", steps: [] });
    setApps((prev) => prev.map((a) => a.name === name ? { ...a, status: "deploying" } : a));

    try {
      const { deploy } = await deployApp(id, name, { force: true });

      const pollInterval = setInterval(async () => {
        try {
          const { deploy: d } = await getDeployStatus(id, name, deploy.id);
          let steps: Array<{ name: string; status: string; durationMs: number }> = [];
          if (d.log) {
            try { steps = JSON.parse(d.log); } catch {}
          }
          setDeployLog({ status: d.status, steps });

          if (d.status !== "running") {
            clearInterval(pollInterval);
            setDeploying(null);
            notifyDeployResult(name, d.status);
            await load();
          }
        } catch {
          clearInterval(pollInterval);
          setDeploying(null);
          setDeployLog(null);
          await load();
        }
      }, 5000);
    } catch (err: any) {
      setDeploying(null);
      setDeployLog(null);
      toast(`Deploy failed: ${err.message ?? "unknown error"}`, "error");
      setApps((prev) => prev.map((a) => a.name === name ? { ...a, status: "unhealthy" } : a));
    }
  }

  async function handleRollback(name: string) {
    const ok = await confirm({ title: "Rollback", message: `Rollback "${name}" to previous version?`, confirmLabel: "Rollback", danger: true });
    if (!ok) return;
    try {
      await rollbackApp(id, name);
      toast("Rollback triggered", "success");
      await load();
    } catch (err: any) {
      toast(`Rollback failed: ${err.message}`, "error");
    }
  }

  async function handleLogs(name: string) {
    setPanel({ type: "logs", app: name });
    setLogs(null);
    setPreflight(null);
    try {
      const result = await getAppLogs(id, name, 100);
      setLogs(result.logs);
    } catch (err: any) {
      setLogs(`Error: ${err.message}`);
    }
  }

  async function handlePreflight(name: string) {
    setPanel({ type: "preflight", app: name });
    setPreflight(null);
    setLogs(null);
    try {
      const result = await getAppPreflight(id, name);
      setPreflight(result);
    } catch (err: any) {
      setPreflight({ passed: false, checks: [{ name: "error", passed: false, message: err.message }] });
    }
  }

  function closePanel() {
    setPanel(null);
    setLogs(null);
    setDeployLog(null);
    setPreflight(null);
  }

  return (
    <main className="page-shell">
      <div style={{ marginBottom: "var(--space-4)" }}>
        <Link href="/servers" style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>
          ← Back to Servers
        </Link>
      </div>

      <div className="page-header">
        <div>
          <h1 className="page-title">{serverName || "Server"}</h1>
          <p className="page-subtitle">{apps.length} app{apps.length !== 1 ? "s" : ""} registered</p>
        </div>
        <button
          onClick={async () => {
            setSyncing(true);
            try { await syncServer(id); await load(); toast("Synced successfully", "success"); }
            catch (err: any) { toast(`Sync failed: ${err.message}`, "error"); }
            finally { setSyncing(false); }
          }}
          disabled={syncing}
          className="btn btn-secondary"
        >
          {syncing ? "Syncing..." : "Sync from Relay"}
        </button>
      </div>

      {loading ? (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="card skeleton" style={{ height: 100 }} />
          ))}
        </div>
      ) : apps.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-state-icon">&#128230;</div>
          <div className="empty-state-title">No apps found</div>
          <div className="empty-state-text">Deploy an app via agent-relay to see it here.</div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {apps.map((app) => (
            <div key={app.id} className="card" style={{ padding: "var(--space-4) var(--space-5)" }}>
              {/* App header */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-3)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                  <span className={`status-dot status-dot-${app.status}`} />
                  <span style={{ fontWeight: 600, fontSize: "var(--text-md)" }}>{app.name}</span>
                  <button
                    onClick={() => { togglePin(id, serverName, app.name); setApps([...apps]); }}
                    title={isPinned(id, app.name) ? "Unpin from dashboard" : "Pin to dashboard"}
                    style={{ background: "none", border: "none", cursor: "pointer", fontSize: "var(--text-sm)", color: isPinned(id, app.name) ? "var(--warning)" : "var(--muted)", padding: 0 }}
                  >
                    {isPinned(id, app.name) ? "★" : "☆"}
                  </button>
                  <TagBadge tag={app.tag} />
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                    {app._count.deploys} deploy{app._count.deploys !== 1 ? "s" : ""}
                  </span>
                </div>
                <span className={`badge badge-${app.status === "healthy" ? "success" : app.status === "unhealthy" ? "danger" : app.status === "deploying" ? "info" : "neutral"}`}>
                  {app.status}
                </span>
              </div>

              {/* Action buttons — primary separated from secondary */}
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
                <button onClick={() => handleDeploy(app.name)} disabled={deploying === app.name} className="btn btn-primary btn-sm">
                  {deploying === app.name ? "Deploying..." : "Deploy"}
                </button>

                <div className="action-group-secondary">
                  <button onClick={() => handleRollback(app.name)} className="btn btn-secondary btn-sm">Rollback</button>
                  <button onClick={() => handleLogs(app.name)} className="btn btn-secondary btn-sm">Logs</button>
                  <button onClick={() => handlePreflight(app.name)} className="btn btn-secondary btn-sm">Preflight</button>
                </div>

                <div className="action-group-secondary">
                  <select
                    value={app.tag ?? ""}
                    onChange={async (e) => {
                      const val = e.target.value || null;
                      await tagApp(id, app.name, val);
                      await load();
                    }}
                    className="select-native"
                  >
                    <option value="">No tag</option>
                    <option value="production">Production</option>
                    <option value="development">Development</option>
                    <option value="ignored">Ignored</option>
                  </select>
                  <button
                    onClick={async () => {
                      const ok = await confirm({ title: "Hide App", message: `Hide "${app.name}" from this server?`, confirmLabel: "Hide", danger: true });
                      if (!ok) return;
                      await hideApp(id, app.name);
                      toast(`"${app.name}" hidden`, "info");
                      await load();
                    }}
                    className="btn btn-danger btn-sm"
                  >
                    Hide
                  </button>
                </div>
              </div>

              {/* Expandable panels */}
              {panel?.app === app.name && (
                <div className="animate-slide-up" style={{ marginTop: "var(--space-4)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-2)" }}>
                    <span style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-secondary)" }}>
                      {panel.type === "logs" && "Application Logs"}
                      {panel.type === "deploy" && "Deploy Progress"}
                      {panel.type === "preflight" && "Preflight Checks"}
                    </span>
                    <button onClick={closePanel} className="btn btn-secondary btn-sm">Close</button>
                  </div>

                  {/* Logs */}
                  {panel.type === "logs" && (
                    <pre className="log-panel">
                      {logs === null ? "Loading logs..." : logs}
                    </pre>
                  )}

                  {/* Deploy log */}
                  {panel.type === "deploy" && deployLog && (
                    <div className="log-panel" style={{ fontFamily: "inherit", whiteSpace: "normal" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
                        <span style={{ fontWeight: 600 }}>Status:</span>
                        <span className={`badge badge-${deployLog.status === "running" ? "info" : deployLog.status === "success" ? "success" : "danger"}`}>
                          {deployLog.status}
                        </span>
                      </div>
                      {deployLog.steps.length === 0 && deployLog.status === "running" && (
                        <div style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>Waiting for steps...</div>
                      )}
                      <div style={{ display: "grid", gap: "var(--space-1)" }}>
                        {deployLog.steps.map((step, i) => (
                          <div key={i} className={`deploy-step deploy-step-${step.status === "success" ? "success" : step.status === "skipped" ? "skipped" : "failed"}`}>
                            <span className="deploy-step-icon">
                              {step.status === "success" ? "✓" : step.status === "skipped" ? "—" : "✗"}
                            </span>
                            <span style={{ color: "var(--text)" }}>{step.name}</span>
                            {step.durationMs > 0 && (
                              <span className="deploy-step-duration">{(step.durationMs / 1000).toFixed(1)}s</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Preflight */}
                  {panel.type === "preflight" && preflight && (
                    <div className="log-panel" style={{ fontFamily: "inherit", whiteSpace: "normal" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
                        <span className={`badge badge-${preflight.passed ? "success" : "danger"}`}>
                          {preflight.passed ? "✓ All checks passed" : "✗ Checks failed"}
                        </span>
                      </div>
                      <div style={{ display: "grid", gap: "var(--space-2)" }}>
                        {preflight.checks.map((check, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-2)", fontSize: "var(--text-sm)" }}>
                            <span style={{ color: check.passed ? "var(--success)" : "var(--danger)", flexShrink: 0, marginTop: 2 }}>
                              {check.passed ? "✓" : "✗"}
                            </span>
                            <div>
                              <span style={{ fontWeight: 500, color: "var(--text)" }}>{check.name}</span>
                              <span style={{ color: "var(--muted)", marginLeft: "var(--space-2)" }}>{check.message}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

function TagBadge({ tag }: { tag: string | null }) {
  if (!tag) return null;
  return <span className={`tag tag-${tag}`}>{tag}</span>;
}
