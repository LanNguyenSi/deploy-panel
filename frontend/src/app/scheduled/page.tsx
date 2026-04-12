"use client";

// Fleet-wide "what's going to deploy soon" overview. Complements the
// per-app ScheduleDialog, which answers "what's queued for this app?" —
// this page answers "what's queued across everything, and do I want any
// of it?". Backed by the existing `GET /api/scheduled` endpoint, which
// is already fleet-wide.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  cancelScheduledDeploy,
  getScheduledDeploys,
  type ScheduledDeployInfo,
} from "@/lib/api";
import { useConfirm } from "@/components/ConfirmDialog";
import { useScheduleDialog } from "@/components/ScheduleDialog";
import { useToast } from "@/components/Toast";

type Window = "1h" | "24h" | "7d" | "all";

const WINDOW_OPTIONS: Array<{ value: Window; label: string; ms: number | null }> = [
  { value: "1h", label: "Next 1h", ms: 60 * 60 * 1000 },
  { value: "24h", label: "Next 24h", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "Next 7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "all", label: "All", ms: null },
];

const REFRESH_INTERVAL_MS = 30_000;

export default function ScheduledPage() {
  const [items, setItems] = useState<ScheduledDeployInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [window, setWindow] = useState<Window>("24h");
  const [forceOnly, setForceOnly] = useState(false);
  const [selectedServers, setSelectedServers] = useState<Set<string>>(new Set());

  const confirmHook = useConfirm();
  const scheduleDialog = useScheduleDialog();
  const { toast } = useToast();

  const load = useCallback(async () => {
    try {
      const { scheduled } = await getScheduledDeploys("pending");
      setItems(scheduled);
      setError(null);
    } catch (err) {
      setError((err as Error).message || "Failed to load scheduled deploys");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [load]);

  // Unique server list for the filter, derived from the current data.
  // Using the data itself (instead of a separate /api/servers fetch)
  // keeps the filter honest: a server with zero pending items simply
  // doesn't appear, which matches what the table can actually show.
  const servers = useMemo(() => {
    const map = new Map<string, string>();
    for (const it of items) map.set(it.serverId, it.server.name);
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [items]);

  const filtered = useMemo(() => {
    const windowMs = WINDOW_OPTIONS.find((w) => w.value === window)?.ms ?? null;
    const cutoff = windowMs == null ? Infinity : Date.now() + windowMs;
    return items
      .filter((it) => new Date(it.scheduledFor).getTime() <= cutoff)
      .filter((it) => !forceOnly || it.force)
      .filter((it) => selectedServers.size === 0 || selectedServers.has(it.serverId))
      .sort(
        (a, b) =>
          new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime(),
      );
  }, [items, window, forceOnly, selectedServers]);

  function toggleServer(id: string) {
    setSelectedServers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleCancel(item: ScheduledDeployInfo) {
    const ok = await confirmHook.confirm({
      title: "Cancel scheduled deploy",
      message: `Cancel the scheduled deploy of ${item.appName} on ${item.server.name} at ${new Date(item.scheduledFor).toLocaleString()}?`,
      confirmLabel: "Cancel deploy",
      danger: true,
    });
    if (!ok) return;
    try {
      await cancelScheduledDeploy(item.id);
      // Optimistic local removal so the row disappears before the next
      // 30s poll without waiting on a round-trip.
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      toast("Scheduled deploy cancelled", "success");
    } catch (err) {
      toast((err as Error).message || "Cancel failed", "error");
    }
  }

  async function handleReschedule(item: ScheduledDeployInfo) {
    // Reuse the shared ScheduleDialog — operator picks a new time and
    // optionally cancels the old row themselves from the dialog's
    // "Pending schedules for this app" list. We deliberately do NOT
    // auto-cancel the old row: silently deleting the original would
    // look like a bug if the reschedule submission fails.
    await scheduleDialog(item.serverId, item.appName);
    // Dialog closes → refresh so any new/cancelled rows from inside
    // the dialog show up immediately.
    load();
  }

  return (
    <main className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">Scheduled</h1>
          <p className="page-subtitle">
            {filtered.length} pending deploy{filtered.length === 1 ? "" : "s"}
            {items.length !== filtered.length && ` (of ${items.length})`}
          </p>
        </div>
        <div className="filter-group" role="group" aria-label="Time window">
          {WINDOW_OPTIONS.map((w) => (
            <button
              key={w.value}
              onClick={() => setWindow(w.value)}
              className={`btn btn-sm ${window === w.value ? "btn-primary" : "btn-secondary"}`}
              aria-pressed={window === w.value}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {servers.length > 0 && (
        <div
          className="card"
          style={{
            padding: "var(--space-3)",
            marginBottom: "var(--space-4)",
            display: "flex",
            gap: "var(--space-3)",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              fontSize: "var(--text-xs)",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "var(--muted)",
            }}
          >
            Servers
          </div>
          {servers.map((s) => {
            const active = selectedServers.has(s.id);
            return (
              <button
                key={s.id}
                onClick={() => toggleServer(s.id)}
                className={`btn btn-sm ${active ? "btn-primary" : "btn-secondary"}`}
                aria-pressed={active}
              >
                {s.name}
              </button>
            );
          })}
          {selectedServers.size > 0 && (
            <button
              onClick={() => setSelectedServers(new Set())}
              className="btn btn-sm btn-secondary"
            >
              Clear
            </button>
          )}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              fontSize: "var(--text-sm)",
              marginLeft: "auto",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={forceOnly}
              onChange={(e) => setForceOnly(e.target.checked)}
            />
            Force only
          </label>
        </div>
      )}

      {error && (
        <div
          className="card"
          style={{
            padding: "var(--space-3)",
            marginBottom: "var(--space-3)",
            borderColor: "var(--danger, #dc2626)",
            color: "var(--danger, #dc2626)",
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton" style={{ height: 48 }} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-state-icon">&#128197;</div>
          <div className="empty-state-title">No deploys scheduled</div>
          <div className="empty-state-text">
            Schedule one from a server page or from an app card.
          </div>
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Server</th>
                <th>App</th>
                <th>Force</th>
                <th>Created</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div style={{ fontFamily: "var(--font-mono, monospace)" }}>
                      {new Date(item.scheduledFor).toLocaleString()}
                    </div>
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                      {relativeLabel(item.scheduledFor)}
                    </div>
                  </td>
                  <td style={{ fontWeight: 500 }}>{item.server.name}</td>
                  <td style={{ fontFamily: "var(--font-mono, monospace)" }}>
                    {item.appName}
                  </td>
                  <td>
                    {item.force ? (
                      <span className="badge badge-warning">force</span>
                    ) : (
                      <span style={{ color: "var(--muted)" }}>—</span>
                    )}
                  </td>
                  <td style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>
                    {timeAgo(item.createdAt)}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button
                      onClick={() => handleReschedule(item)}
                      className="btn btn-sm btn-secondary"
                      style={{ marginRight: "var(--space-2)" }}
                    >
                      Reschedule
                    </button>
                    <button
                      onClick={() => handleCancel(item)}
                      className="btn btn-sm btn-secondary"
                    >
                      Cancel
                    </button>
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

function relativeLabel(iso: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  if (diff < 0) return "past";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "imminent";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
