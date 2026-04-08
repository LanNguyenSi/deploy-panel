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

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [statusFilter]);

  const statusOptions = [
    { value: "", label: "All statuses" },
    { value: "success", label: "Success" },
    { value: "failed", label: "Failed" },
    { value: "rolled_back", label: "Rolled back" },
    { value: "running", label: "Running" },
  ];

  return (
    <main className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">Deploy History</h1>
          <p className="page-subtitle">{deploys.length} deployment{deploys.length !== 1 ? "s" : ""}</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <div style={{ display: "flex", gap: "var(--space-1)" }}>
            {statusOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => { setStatusFilter(opt.value); setLoading(true); }}
                className={`btn btn-sm ${statusFilter === opt.value ? "btn-primary" : "btn-secondary"}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="skeleton" style={{ height: 48 }} />
          ))}
        </div>
      ) : deploys.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-state-icon">&#128640;</div>
          <div className="empty-state-title">No deployments found</div>
          <div className="empty-state-text">
            {statusFilter ? "Try a different filter." : "Deploy an app to see history here."}
          </div>
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Status</th>
                <th>App</th>
                <th>Server</th>
                <th>Commit</th>
                <th>Duration</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {deploys.map((d) => (
                <tr key={d.id} style={{ cursor: "default" }}>
                  <td>
                    <StatusBadge status={d.status} />
                  </td>
                  <td style={{ fontWeight: 500, color: "var(--text)" }}>{d.app.name}</td>
                  <td style={{ color: "var(--text-secondary)" }}>{d.server.name}</td>
                  <td>
                    <code style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", background: "var(--bg-subtle)", padding: "0.125rem 0.375rem", borderRadius: "var(--radius-sm)" }}>
                      {d.commitAfter ? d.commitAfter.slice(0, 7) : "—"}
                    </code>
                  </td>
                  <td style={{ color: "var(--muted)" }}>
                    {d.duration ? `${(d.duration / 1000).toFixed(1)}s` : "—"}
                  </td>
                  <td style={{ color: "var(--muted)" }}>
                    {timeAgo(d.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { className: string; label: string }> = {
    success: { className: "badge-success", label: "Success" },
    failed: { className: "badge-danger", label: "Failed" },
    rolled_back: { className: "badge-warning", label: "Rolled back" },
    running: { className: "badge-info", label: "Running" },
    pending: { className: "badge-neutral", label: "Pending" },
  };
  const s = map[status] ?? { className: "badge-neutral", label: status };
  return <span className={`badge ${s.className}`}>{s.label}</span>;
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
