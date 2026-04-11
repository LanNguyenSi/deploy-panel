"use client";

import { Fragment, useEffect, useState } from "react";
import { getDeploys, getDeployDetail, type DeployWithRelations, type DeployDetail } from "@/lib/api";

export default function DeploysPage() {
  const [deploys, setDeploys] = useState<DeployWithRelations[]>([]);
  const [chartDeploys, setChartDeploys] = useState<DeployWithRelations[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [page, setPage] = useState(0);
  const limit = 25;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DeployDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  async function load() {
    try {
      const [data, chartData] = await Promise.all([
        getDeploys({ status: statusFilter || undefined, limit, offset: page * limit }),
        page === 0 && !statusFilter
          ? getDeploys({ limit: 100 })
          : Promise.resolve(null),
      ]);
      setDeploys(data.deploys);
      setTotal(data.total);
      if (chartData) setChartDeploys(chartData.deploys);
      // Auto-recover if current page is empty but there are results
      if (data.deploys.length === 0 && data.total > 0 && page > 0) {
        setPage(Math.max(0, Math.ceil(data.total / limit) - 1));
      }
    } catch (err) {
      console.error("Failed to load deploys:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [statusFilter, page]);

  async function toggleDetail(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const data = await getDeployDetail(id);
      setDetail(data.deploy);
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }

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
          <p className="page-subtitle">{total} deployment{total !== 1 ? "s" : ""}</p>
        </div>
        <div className="filter-group" role="group" aria-label="Filter by status">
          {statusOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => { setStatusFilter(opt.value); setPage(0); setLoading(true); }}
              className={`btn btn-sm ${statusFilter === opt.value ? "btn-primary" : "btn-secondary"}`}
              aria-pressed={statusFilter === opt.value}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Duration trend chart */}
      {!loading && chartDeploys.filter((d) => d.duration).length >= 3 && (
        <DurationChart deploys={chartDeploys} />
      )}

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
        <>
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
                  <Fragment key={d.id}>
                    <tr
                      onClick={() => toggleDetail(d.id)}
                      style={{ cursor: "pointer" }}
                      className={expandedId === d.id ? "row-expanded" : ""}
                    >
                      <td><StatusBadge status={d.status} /></td>
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
                      <td style={{ color: "var(--muted)" }}>{timeAgo(d.createdAt)}</td>
                    </tr>
                    {expandedId === d.id && (
                      <tr key={`${d.id}-detail`}>
                        <td colSpan={6} style={{ padding: 0, borderBottom: "1px solid var(--border)" }}>
                          <DeployDetailPanel detail={detail} loading={detailLoading} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
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

function DurationChart({ deploys }: { deploys: DeployWithRelations[] }) {
  // Take deploys with duration, reverse to chronological order
  const withDuration = deploys
    .filter((d) => d.duration && d.duration > 0)
    .reverse()
    .slice(-30);

  if (withDuration.length < 3) return null;

  const durations = withDuration.map((d) => d.duration! / 1000);
  const max = Math.max(...durations);
  const min = Math.min(...durations);
  const avg = durations.reduce((s, v) => s + v, 0) / durations.length;

  const W = 600;
  const H = 80;
  const PAD = 2;
  const step = (W - PAD * 2) / (durations.length - 1);

  const points = durations.map((d, i) => {
    const x = PAD + i * step;
    const y = max === min ? H / 2 : PAD + (1 - (d - min) / (max - min)) * (H - PAD * 2);
    return `${x},${y}`;
  });

  const polyline = points.join(" ");
  // Gradient area
  const area = `${PAD},${H} ${polyline} ${PAD + (durations.length - 1) * step},${H}`;

  return (
    <div className="card" style={{ padding: "var(--space-4) var(--space-5)", marginBottom: "var(--space-4)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-3)" }}>
        <h3 style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-secondary)" }}>Deploy Duration Trend</h3>
        <div style={{ display: "flex", gap: "var(--space-4)", fontSize: "var(--text-xs)", color: "var(--muted)" }}>
          <span>Avg: <strong style={{ color: "var(--text-secondary)" }}>{avg.toFixed(1)}s</strong></span>
          <span>Min: <strong style={{ color: "var(--success)" }}>{min.toFixed(1)}s</strong></span>
          <span>Max: <strong style={{ color: "var(--warning)" }}>{max.toFixed(1)}s</strong></span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 80 }}>
        <defs>
          <linearGradient id="duration-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.2" />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={area} fill="url(#duration-fill)" />
        <polyline points={polyline} fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {/* Dots on each point */}
        {durations.map((d, i) => {
          const x = PAD + i * step;
          const y = max === min ? H / 2 : PAD + (1 - (d - min) / (max - min)) * (H - PAD * 2);
          return (
            <circle key={i} cx={x} cy={y} r="3" fill="var(--surface)" stroke="var(--primary)" strokeWidth="1.5">
              <title>{withDuration[i].app.name}: {d.toFixed(1)}s</title>
            </circle>
          );
        })}
      </svg>
    </div>
  );
}

function DeployDetailPanel({ detail, loading }: { detail: DeployDetail | null; loading: boolean }) {
  if (loading) {
    return (
      <div style={{ padding: "var(--space-4) var(--space-5)" }}>
        <div className="skeleton" style={{ height: 80 }} />
      </div>
    );
  }

  if (!detail) {
    return (
      <div style={{ padding: "var(--space-4) var(--space-5)", color: "var(--muted)" }}>
        Failed to load details.
      </div>
    );
  }

  const hasCommits = detail.commitBefore || detail.commitAfter;

  return (
    <div className="animate-slide-up" style={{ padding: "var(--space-4) var(--space-5)", background: "var(--bg-subtle)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-6)" }}>
        {/* Left: Commit info */}
        <div>
          <h4 style={{ fontSize: "var(--text-sm)", fontWeight: 600, marginBottom: "var(--space-3)", color: "var(--text-secondary)" }}>
            Commit Range
          </h4>
          {hasCommits ? (
            <div style={{ display: "grid", gap: "var(--space-2)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--text-sm)" }}>
                <span style={{ color: "var(--muted)", width: 50 }}>Before</span>
                <code style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", background: "var(--surface)", padding: "0.2rem 0.5rem", borderRadius: "var(--radius-sm)" }}>
                  {detail.commitBefore ? detail.commitBefore.slice(0, 12) : "—"}
                </code>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--text-sm)" }}>
                <span style={{ color: "var(--muted)", width: 50 }}>After</span>
                <code style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", background: "var(--surface)", padding: "0.2rem 0.5rem", borderRadius: "var(--radius-sm)" }}>
                  {detail.commitAfter ? detail.commitAfter.slice(0, 12) : "—"}
                </code>
              </div>
              {detail.compareUrl && (
                <a
                  href={detail.compareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-secondary btn-sm"
                  style={{ marginTop: "var(--space-2)", justifySelf: "start" }}
                >
                  View diff on GitHub
                </a>
              )}
            </div>
          ) : (
            <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>No commit data available.</p>
          )}

          {/* Meta info */}
          <div style={{ marginTop: "var(--space-4)", display: "grid", gap: "var(--space-1)", fontSize: "var(--text-xs)", color: "var(--muted)" }}>
            {detail.triggeredBy && <div>Triggered by: <span style={{ color: "var(--text-secondary)" }}>{detail.triggeredBy}</span></div>}
            {detail.duration && <div>Duration: <span style={{ color: "var(--text-secondary)" }}>{(detail.duration / 1000).toFixed(1)}s</span></div>}
            <div>Time: <span style={{ color: "var(--text-secondary)" }}>{new Date(detail.createdAt).toLocaleString()}</span></div>
          </div>
        </div>

        {/* Right: Deploy steps */}
        <div>
          <h4 style={{ fontSize: "var(--text-sm)", fontWeight: 600, marginBottom: "var(--space-3)", color: "var(--text-secondary)" }}>
            Deploy Steps
          </h4>
          {detail.steps.length > 0 ? (
            <div style={{ display: "grid", gap: "var(--space-1)" }}>
              {detail.steps.map((step, i) => (
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
          ) : (
            <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>No step data available.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { className: string; label: string }> = {
    success: { className: "badge-success", label: "Success" },
    failed: { className: "badge-danger", label: "Failed" },
    rolled_back: { className: "badge-warning", label: "Rolled back" },
    running: { className: "badge-info", label: "Running" },
    pending: { className: "badge-neutral", label: "Pending" },
    interrupted: { className: "badge-warning", label: "Interrupted" },
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
