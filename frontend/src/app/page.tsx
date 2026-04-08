"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getServers, getDeploys, deployApp, type ServerWithCount, type DeployWithRelations } from "@/lib/api";
import { getPinnedApps, type PinnedApp } from "@/lib/pinned";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";

export default function DashboardPage() {
  const [servers, setServers] = useState<ServerWithCount[]>([]);
  const [deploys, setDeploys] = useState<DeployWithRelations[]>([]);
  const [loading, setLoading] = useState(true);
  const [pinned, setPinned] = useState<PinnedApp[]>([]);
  const { toast } = useToast();
  const { confirm } = useConfirm();

  useEffect(() => {
    setPinned(getPinnedApps());
    function loadAll() {
      Promise.all([getServers(), getDeploys({ limit: 10 })])
        .then(([s, d]) => {
          setServers(s.servers);
          setDeploys(d.deploys);
        })
        .catch(console.error)
        .finally(() => setLoading(false));
    }

    loadAll();
    const interval = setInterval(loadAll, 15000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <main className="page-shell">
        <div className="page-header">
          <div>
            <div className="skeleton" style={{ width: 200, height: 28, marginBottom: "var(--space-2)" }} />
            <div className="skeleton" style={{ width: 160, height: 16 }} />
          </div>
        </div>
        <div className="grid-stats">
          {[1, 2, 3].map((i) => (
            <div key={i} className="card skeleton" style={{ height: 96 }} />
          ))}
        </div>
      </main>
    );
  }

  const online = servers.filter((s) => s.status === "online").length;
  const totalApps = servers.reduce((sum, s) => sum + s._count.apps, 0);
  const recentSuccess = deploys.filter((d) => d.status === "success").length;

  return (
    <main className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Overview of your infrastructure</p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid-stats" style={{ marginBottom: "var(--space-8)" }}>
        <div className="card stat-card">
          <div className="stat-value">{servers.length}</div>
          <div className="stat-label">Servers</div>
          {online > 0 && (
            <div className="stat-sub" style={{ color: "var(--success)" }}>
              <span className="status-dot status-dot-online" style={{ marginRight: "var(--space-1)", width: 6, height: 6 }} /> {online} online
            </div>
          )}
        </div>
        <div className="card stat-card">
          <div className="stat-value">{totalApps}</div>
          <div className="stat-label">Apps</div>
        </div>
        <div className="card stat-card">
          <div className="stat-value">{deploys.length}</div>
          <div className="stat-label">Recent Deploys</div>
          {recentSuccess > 0 && (
            <div className="stat-sub" style={{ color: "var(--success)" }}>{recentSuccess} successful</div>
          )}
        </div>
      </div>

      {/* Pinned apps — quick deploy */}
      {pinned.length > 0 && (
        <section style={{ marginBottom: "var(--space-6)" }}>
          <h2 style={{ fontSize: "var(--text-md)", fontWeight: 600, marginBottom: "var(--space-3)" }}>Pinned Apps</h2>
          <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
            {pinned.map((p) => (
              <div key={`${p.serverId}-${p.appName}`} className="card" style={{ padding: "var(--space-3) var(--space-4)", display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                <div>
                  <div style={{ fontWeight: 500, fontSize: "var(--text-sm)" }}>{p.appName}</div>
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>{p.serverName}</div>
                </div>
                <button
                  onClick={async () => {
                    const ok = await confirm({ title: "Deploy", message: `Deploy "${p.appName}" on ${p.serverName}?`, confirmLabel: "Deploy" });
                    if (!ok) return;
                    try {
                      await deployApp(p.serverId, p.appName, { force: true });
                      toast(`Deploy started: ${p.appName}`, "success");
                    } catch (err: any) {
                      toast(`Failed: ${err.message}`, "error");
                    }
                  }}
                  className="btn btn-primary btn-sm"
                >
                  Deploy
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="grid-two-col">
        {/* Server cards */}
        <section>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-3)" }}>
            <h2 style={{ fontSize: "var(--text-md)", fontWeight: 600 }}>Servers</h2>
            <Link href="/servers" className="btn btn-secondary btn-sm">View all</Link>
          </div>
          {servers.length === 0 ? (
            <div className="card empty-state" style={{ padding: "var(--space-8) var(--space-4)" }}>
              <div className="empty-state-icon">&#9881;</div>
              <div className="empty-state-title">No servers yet</div>
              <div className="empty-state-text">
                <Link href="/servers">Add your first server</Link> to start deploying.
              </div>
            </div>
          ) : (
            <div style={{ display: "grid", gap: "var(--space-2)" }}>
              {servers.map((s) => (
                <Link key={s.id} href={`/servers/${s.id}`} className="card card-interactive" style={{ padding: "var(--space-3) var(--space-4)", display: "block" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                      <span className={`status-dot status-dot-${s.status}`} />
                      <div>
                        <div style={{ fontWeight: 600, color: "var(--text)" }}>{s.name}</div>
                        <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                          {s.host} · {s._count.apps} app{s._count.apps !== 1 ? "s" : ""}
                        </div>
                      </div>
                    </div>
                    <span className={`badge badge-${s.status === "online" ? "success" : s.status === "offline" ? "danger" : "neutral"}`}>
                      {s.status}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* Recent deploys */}
        <section>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-3)" }}>
            <h2 style={{ fontSize: "var(--text-md)", fontWeight: 600 }}>Recent Deploys</h2>
            <Link href="/deploys" className="btn btn-secondary btn-sm">View all</Link>
          </div>
          {deploys.length === 0 ? (
            <div className="card empty-state" style={{ padding: "var(--space-8) var(--space-4)" }}>
              <div className="empty-state-icon">&#128640;</div>
              <div className="empty-state-title">No deployments yet</div>
              <div className="empty-state-text">Deploy an app to see activity here.</div>
            </div>
          ) : (
            <div className="card" style={{ overflow: "hidden" }}>
              {deploys.map((d, i) => (
                <div
                  key={d.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "var(--space-3) var(--space-4)",
                    borderBottom: i < deploys.length - 1 ? "1px solid var(--border)" : "none",
                    fontSize: "var(--text-sm)",
                    transition: "background var(--transition-fast)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                    <span className={`status-dot status-dot-${d.status}`} />
                    <div>
                      <span style={{ fontWeight: 500, color: "var(--text)" }}>{d.app.name}</span>
                      <span style={{ color: "var(--muted)", marginLeft: "var(--space-2)" }}>
                        on {d.server.name}
                      </span>
                    </div>
                  </div>
                  <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>
                    {timeAgo(d.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
