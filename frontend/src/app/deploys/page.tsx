"use client";

import { useEffect, useState } from "react";
import { getDeploys, type DeployWithRelations } from "@/lib/api";

export default function DeploysPage() {
  const [deploys, setDeploys] = useState<DeployWithRelations[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("");

  async function load() {
    try {
      const data = await getDeploys({
        status: statusFilter || undefined,
        limit: 100,
      });
      setDeploys(data.deploys);
    } catch (err) {
      console.error("Failed to load deploys:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [statusFilter]);

  return (
    <main className="page-shell">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
        <h1 style={{ fontSize: "var(--text-lg)", fontWeight: 700 }}>Deploy History</h1>
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setLoading(true); }}
          className="input"
          style={{ width: "auto" }}
        >
          <option value="">All statuses</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
          <option value="rolled_back">Rolled back</option>
          <option value="running">Running</option>
        </select>
      </div>

      {loading ? (
        <p style={{ color: "var(--muted)" }}>Loading...</p>
      ) : deploys.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>No deployments found.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border, #333)", textAlign: "left" }}>
              <th style={{ padding: "var(--space-2)", fontSize: "var(--text-sm)", color: "var(--muted)" }}>Status</th>
              <th style={{ padding: "var(--space-2)", fontSize: "var(--text-sm)", color: "var(--muted)" }}>App</th>
              <th style={{ padding: "var(--space-2)", fontSize: "var(--text-sm)", color: "var(--muted)" }}>Server</th>
              <th style={{ padding: "var(--space-2)", fontSize: "var(--text-sm)", color: "var(--muted)" }}>Commit</th>
              <th style={{ padding: "var(--space-2)", fontSize: "var(--text-sm)", color: "var(--muted)" }}>Duration</th>
              <th style={{ padding: "var(--space-2)", fontSize: "var(--text-sm)", color: "var(--muted)" }}>When</th>
            </tr>
          </thead>
          <tbody>
            {deploys.map((d) => (
              <tr key={d.id} style={{ borderBottom: "1px solid var(--border, #222)" }}>
                <td style={{ padding: "var(--space-2)" }}>
                  <StatusBadge status={d.status} />
                </td>
                <td style={{ padding: "var(--space-2)", fontWeight: 500 }}>{d.app.name}</td>
                <td style={{ padding: "var(--space-2)", color: "var(--muted)" }}>{d.server.name}</td>
                <td style={{ padding: "var(--space-2)", fontFamily: "monospace", fontSize: "var(--text-sm)" }}>
                  {d.commitAfter ? d.commitAfter.slice(0, 7) : "—"}
                </td>
                <td style={{ padding: "var(--space-2)", color: "var(--muted)", fontSize: "var(--text-sm)" }}>
                  {d.duration ? `${(d.duration / 1000).toFixed(1)}s` : "—"}
                </td>
                <td style={{ padding: "var(--space-2)", color: "var(--muted)", fontSize: "var(--text-sm)" }}>
                  {timeAgo(d.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, { color: string; label: string }> = {
    success: { color: "#22c55e", label: "Success" },
    failed: { color: "#ef4444", label: "Failed" },
    rolled_back: { color: "#f59e0b", label: "Rolled back" },
    running: { color: "#3b82f6", label: "Running" },
    pending: { color: "#6b7280", label: "Pending" },
  };
  const s = styles[status] ?? { color: "#6b7280", label: status };
  return <span style={{ color: s.color, fontWeight: 500, fontSize: "var(--text-sm)" }}>● {s.label}</span>;
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
