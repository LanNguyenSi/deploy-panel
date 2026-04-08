"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { getServer, getApps, deployApp, rollbackApp, getAppLogs, getAppPreflight, syncServer, tagApp, hideApp, type AppWithCount } from "@/lib/api";

export default function ServerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [serverName, setServerName] = useState("");
  const [apps, setApps] = useState<AppWithCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeApp, setActiveApp] = useState<string | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [preflight, setPreflight] = useState<{ passed: boolean; checks: Array<{ name: string; passed: boolean; message: string }> } | null>(null);

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
    if (!confirm(`Deploy "${name}"?`)) return;
    try {
      const result = await deployApp(id, name, { force: true });
      alert(result.deploy?.success !== false ? "Deploy successful!" : "Deploy failed.");
      await load();
    } catch (err: any) {
      alert(`Deploy failed: ${err.message}`);
    }
  }

  async function handleRollback(name: string) {
    if (!confirm(`Rollback "${name}" to previous version?`)) return;
    try {
      await rollbackApp(id, name);
      alert("Rollback triggered.");
      await load();
    } catch (err: any) {
      alert(`Rollback failed: ${err.message}`);
    }
  }

  async function handleLogs(name: string) {
    setActiveApp(name);
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
    setActiveApp(name);
    setPreflight(null);
    setLogs(null);
    try {
      const result = await getAppPreflight(id, name);
      setPreflight(result);
    } catch (err: any) {
      setPreflight({ passed: false, checks: [{ name: "error", passed: false, message: err.message }] });
    }
  }

  return (
    <main className="page-shell">
      <div style={{ marginBottom: "var(--space-3)" }}>
        <Link href="/servers" style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>← Servers</Link>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
        <h1 style={{ fontSize: "var(--text-lg)", fontWeight: 700 }}>
          {serverName || "Server"} — Apps
        </h1>
        <button onClick={async () => {
          setSyncing(true);
          try { await syncServer(id); await load(); }
          catch (err: any) { alert(`Sync failed: ${err.message}`); }
          finally { setSyncing(false); }
        }} disabled={syncing} className="btn btn-secondary">
          {syncing ? "Syncing..." : "Sync from Relay"}
        </button>
      </div>

      {loading ? (
        <p style={{ color: "var(--muted)" }}>Loading...</p>
      ) : apps.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>No apps found. Deploy an app via agent-relay to see it here.</p>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {apps.map((app) => (
            <div key={app.id} className="card" style={{ padding: "var(--space-3)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-2)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <span style={{ fontWeight: 600 }}>{app.name}</span>
                  <TagBadge tag={app.tag} />
                  <span style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>
                    {app._count.deploys} deploy{app._count.deploys !== 1 ? "s" : ""}
                  </span>
                </div>
                <StatusBadge status={app.status} />
              </div>
              <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center" }}>
                <button onClick={() => handleDeploy(app.name)} className="btn btn-primary">Deploy</button>
                <button onClick={() => handleRollback(app.name)} className="btn btn-secondary">Rollback</button>
                <button onClick={() => handleLogs(app.name)} className="btn btn-secondary">Logs</button>
                <button onClick={() => handlePreflight(app.name)} className="btn btn-secondary">Preflight</button>
                <select
                  value={app.tag ?? ""}
                  onChange={async (e) => {
                    const val = e.target.value || null;
                    await tagApp(id, app.name, val);
                    await load();
                  }}
                  className="input"
                  style={{ width: "auto", fontSize: "var(--text-xs)", padding: "0.25rem 0.5rem" }}
                >
                  <option value="">No tag</option>
                  <option value="production">Production</option>
                  <option value="development">Development</option>
                  <option value="ignored">Ignored</option>
                </select>
                <button onClick={async () => {
                  if (!confirm(`Hide "${app.name}" from this server?`)) return;
                  await hideApp(id, app.name);
                  await load();
                }} className="btn btn-danger" style={{ fontSize: "var(--text-xs)", padding: "0.25rem 0.5rem" }}>Hide</button>
              </div>

              {activeApp === app.name && logs !== null && (
                <pre style={{
                  marginTop: "var(--space-2)",
                  padding: "var(--space-2)",
                  background: "var(--bg-muted, #1a1a2e)",
                  borderRadius: "var(--radius)",
                  fontSize: "var(--text-sm)",
                  overflow: "auto",
                  maxHeight: "300px",
                  whiteSpace: "pre-wrap",
                }}>
                  {logs}
                </pre>
              )}

              {activeApp === app.name && preflight !== null && (
                <div style={{ marginTop: "var(--space-2)", padding: "var(--space-2)", background: "var(--bg-muted, #1a1a2e)", borderRadius: "var(--radius)" }}>
                  <div style={{ fontWeight: 600, marginBottom: "var(--space-1)" }}>
                    Preflight: {preflight.passed ? "✓ Passed" : "✗ Failed"}
                  </div>
                  {preflight.checks.map((check, i) => (
                    <div key={i} style={{ fontSize: "var(--text-sm)", color: check.passed ? "var(--success, #22c55e)" : "var(--danger, #ef4444)" }}>
                      {check.passed ? "✓" : "✗"} {check.name}: {check.message}
                    </div>
                  ))}
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
  const styles: Record<string, { bg: string; color: string }> = {
    production: { bg: "rgba(34,197,94,0.15)", color: "#22c55e" },
    development: { bg: "rgba(59,130,246,0.15)", color: "#3b82f6" },
    ignored: { bg: "rgba(107,114,128,0.15)", color: "#6b7280" },
  };
  const s = styles[tag] ?? styles.ignored;
  return (
    <span style={{ fontSize: "var(--text-xs)", padding: "0.125rem 0.375rem", borderRadius: "4px", background: s.bg, color: s.color, fontWeight: 500 }}>
      {tag}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    healthy: "#22c55e",
    unhealthy: "#ef4444",
    deploying: "#3b82f6",
    unknown: "#6b7280",
  };
  return <span style={{ color: colors[status] ?? colors.unknown, fontWeight: 500 }}>● {status}</span>;
}
