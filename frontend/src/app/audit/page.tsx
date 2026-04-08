"use client";

import { useEffect, useState } from "react";
import { getAuditLog, type AuditEntry } from "@/lib/api";

const ACTION_OPTIONS = [
  { value: "", label: "All actions" },
  { value: "deploy", label: "Deploy" },
  { value: "rollback", label: "Rollback" },
  { value: "server.create", label: "Server created" },
  { value: "server.delete", label: "Server deleted" },
  { value: "api_key.create", label: "API key created" },
  { value: "api_key.revoke", label: "API key revoked" },
];

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState("");
  const [page, setPage] = useState(0);
  const limit = 50;

  async function load() {
    try {
      const data = await getAuditLog({ action: actionFilter || undefined, limit, offset: page * limit });
      setEntries(data.entries);
      setTotal(data.total);
    } catch (err) {
      console.error("Failed to load audit log:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    load();
  }, [actionFilter, page]);

  return (
    <main className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">Audit Log</h1>
          <p className="page-subtitle">{total} event{total !== 1 ? "s" : ""}</p>
        </div>
        <div className="filter-group" role="group" aria-label="Filter by action">
          {ACTION_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => { setActionFilter(opt.value); setPage(0); setLoading(true); }}
              className={`btn btn-sm ${actionFilter === opt.value ? "btn-primary" : "btn-secondary"}`}
              aria-pressed={actionFilter === opt.value}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="skeleton" style={{ height: 48 }} />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-state-icon">&#128220;</div>
          <div className="empty-state-title">No audit entries</div>
          <div className="empty-state-text">
            {actionFilter ? "Try a different filter." : "Actions will appear here as they happen."}
          </div>
        </div>
      ) : (
        <>
          <div className="card" style={{ overflow: "hidden" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Target</th>
                  <th>Detail</th>
                  <th>Actor</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td><ActionBadge action={e.action} /></td>
                    <td style={{ color: "var(--text)", fontWeight: 500 }}>{e.target ?? "—"}</td>
                    <td style={{ color: "var(--text-secondary)", fontSize: "var(--text-xs)" }}>
                      {e.detail ?? "—"}
                    </td>
                    <td><ActorBadge actor={e.actor} /></td>
                    <td style={{ color: "var(--muted)" }}>{timeAgo(e.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {total > limit && (
            <div style={{ display: "flex", justifyContent: "center", gap: "var(--space-2)", marginTop: "var(--space-4)" }}>
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="btn btn-secondary btn-sm"
              >
                Previous
              </button>
              <span style={{ fontSize: "var(--text-sm)", color: "var(--muted)", display: "flex", alignItems: "center" }}>
                Page {page + 1} of {Math.ceil(total / limit)}
              </span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={(page + 1) * limit >= total}
                className="btn btn-secondary btn-sm"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function ActionBadge({ action }: { action: string }) {
  const map: Record<string, string> = {
    deploy: "badge-success",
    rollback: "badge-warning",
    "server.create": "badge-info",
    "server.delete": "badge-danger",
    "api_key.create": "badge-info",
    "api_key.revoke": "badge-warning",
    login: "badge-neutral",
    logout: "badge-neutral",
  };
  return <span className={`badge ${map[action] ?? "badge-neutral"}`}>{action}</span>;
}

function ActorBadge({ actor }: { actor: string | null }) {
  if (!actor) return <span style={{ color: "var(--muted)" }}>—</span>;
  if (actor.startsWith("api:")) {
    return <span className="badge badge-info">{actor.slice(4)}</span>;
  }
  return <span className="badge badge-neutral">{actor}</span>;
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
