"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getServers, getDeploys, type ServerWithCount, type DeployWithRelations } from "@/lib/api";

export default function DashboardPage() {
  const [servers, setServers] = useState<ServerWithCount[]>([]);
  const [deploys, setDeploys] = useState<DeployWithRelations[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getServers(), getDeploys({ limit: 10 })])
      .then(([s, d]) => {
        setServers(s.servers);
        setDeploys(d.deploys);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <main className="page-shell">
        <p style={{ color: "var(--muted)" }}>Loading dashboard...</p>
      </main>
    );
  }

  const online = servers.filter((s) => s.status === "online").length;
  const totalApps = servers.reduce((sum, s) => sum + s._count.apps, 0);

  return (
    <main className="page-shell">
      <h1 style={{ fontSize: "var(--text-lg)", fontWeight: 700, marginBottom: "var(--space-4)" }}>
        Deploy Panel
      </h1>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--space-3)", marginBottom: "var(--space-4)" }}>
        <StatCard label="Servers" value={servers.length} sub={`${online} online`} />
        <StatCard label="Apps" value={totalApps} />
        <StatCard label="Recent Deploys" value={deploys.length} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
        {/* Server cards */}
        <div>
          <h2 style={{ fontSize: "var(--text-md)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
            Servers
          </h2>
          {servers.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>
              No servers. <Link href="/servers" style={{ color: "var(--accent)" }}>Add one →</Link>
            </p>
          ) : (
            <div style={{ display: "grid", gap: "var(--space-2)" }}>
              {servers.map((s) => (
                <Link key={s.id} href={`/servers/${s.id}`} className="card" style={{ padding: "var(--space-2)", textDecoration: "none", display: "block" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <span style={{ fontWeight: 600 }}>{s.name}</span>
                      <span style={{ marginLeft: "var(--space-2)", fontSize: "var(--text-sm)", color: "var(--muted)" }}>
                        {s.host}
                      </span>
                    </div>
                    <StatusDot status={s.status} />
                  </div>
                  <div style={{ fontSize: "var(--text-sm)", color: "var(--muted)", marginTop: "2px" }}>
                    {s._count.apps} app{s._count.apps !== 1 ? "s" : ""}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Recent deploys */}
        <div>
          <h2 style={{ fontSize: "var(--text-md)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
            Recent Deploys
          </h2>
          {deploys.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>No deployments yet.</p>
          ) : (
            <div style={{ display: "grid", gap: "var(--space-1)" }}>
              {deploys.map((d) => (
                <div key={d.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "var(--text-sm)", padding: "4px 0" }}>
                  <div>
                    <StatusDot status={d.status} />
                    <span style={{ marginLeft: "var(--space-1)" }}>{d.app.name}</span>
                    <span style={{ color: "var(--muted)", marginLeft: "var(--space-1)" }}>
                      on {d.server.name}
                    </span>
                  </div>
                  <span style={{ color: "var(--muted)" }}>
                    {timeAgo(d.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {deploys.length > 0 && (
            <Link href="/deploys" style={{ color: "var(--accent)", fontSize: "var(--text-sm)", marginTop: "var(--space-2)", display: "inline-block" }}>
              View all →
            </Link>
          )}
        </div>
      </div>
    </main>
  );
}

function StatCard({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="card" style={{ padding: "var(--space-3)", textAlign: "center" }}>
      <div style={{ fontSize: "var(--text-lg)", fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>{label}</div>
      {sub && <div style={{ fontSize: "var(--text-sm)", color: "var(--success, #22c55e)" }}>{sub}</div>}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    online: "#22c55e", success: "#22c55e", healthy: "#22c55e",
    offline: "#ef4444", failed: "#ef4444", unhealthy: "#ef4444",
    "no-relay": "#f59e0b", deploying: "#3b82f6", running: "#3b82f6", pending: "#6b7280",
    rolled_back: "#f59e0b", unknown: "#6b7280",
  };
  return <span style={{ color: colors[status] ?? "#6b7280" }}>●</span>;
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
