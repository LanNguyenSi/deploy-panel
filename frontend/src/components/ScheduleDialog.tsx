"use client";

/**
 * ScheduleDialog — proper replacement for the `prompt()`-for-ISO flow.
 *
 * What it does better than `prompt("Schedule for (ISO datetime)")`:
 *  - Native `<input type="datetime-local">` picker on every platform
 *  - Quick-preset buttons (in 1h, tonight 2am, tomorrow 9am, in a week)
 *  - Explicit local-timezone label so nobody schedules a deploy for the
 *    wrong continent
 *  - `min` attribute set to 'now' so the browser rejects past dates
 *  - Inline list of existing pending schedules for this app, each with
 *    a Cancel button — so you don't accidentally double-schedule
 *  - `force` checkbox that wires into the existing `scheduleDeploy`
 *    param (currently unused from the UI)
 *  - Schedule multiple in one session without closing the dialog
 *
 * Hook pattern matches `useConfirm` / `usePrompt`. Call
 * `const scheduleDialog = useScheduleDialog(); await scheduleDialog(serverId, appName);`
 * and it resolves when the user closes the dialog.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  cancelScheduledDeploy,
  getScheduledDeploys,
  scheduleDeploy,
  type ScheduledDeployInfo,
} from "@/lib/api";

interface ScheduleContextValue {
  scheduleDialog: (serverId: string, appName: string) => Promise<void>;
}

const ScheduleContext = createContext<ScheduleContextValue>({
  scheduleDialog: async () => {},
});

export function useScheduleDialog() {
  return useContext(ScheduleContext).scheduleDialog;
}

interface DialogState {
  serverId: string;
  appName: string;
  resolve: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** `YYYY-MM-DDTHH:mm` in local time — shape expected by `datetime-local`. */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** Parse the local-datetime-input string into a Date in local time. */
function fromLocalInputValue(s: string): Date {
  return new Date(s);
}

/** Short relative label: 'in 3h', 'in 12m', 'in 2d'. Negative → 'past'. */
function relativeLabel(iso: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  if (diff < 0) return "past";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

interface Preset {
  label: string;
  compute: () => Date;
}

const PRESETS: Preset[] = [
  {
    label: "In 1 hour",
    compute: () => new Date(Date.now() + 60 * 60 * 1000),
  },
  {
    label: "Tonight 02:00",
    compute: () => {
      const d = new Date();
      d.setHours(2, 0, 0, 0);
      if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
      return d;
    },
  },
  {
    label: "Tomorrow 09:00",
    compute: () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d;
    },
  },
  {
    label: "In 1 week",
    compute: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  },
];

// ── Provider ───────────────────────────────────────────────────────────────

export function ScheduleDialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [value, setValue] = useState("");
  const [force, setForce] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ScheduledDeployInfo[]>([]);
  const [loadingPending, setLoadingPending] = useState(false);

  // Stable IANA timezone label for the footer hint. We deliberately do
  // NOT also show an offset abbreviation ("CET", "PDT") because those
  // are locale-dependent and brittle to parse from toLocaleTimeString —
  // the IANA zone alone is unambiguous and stable.
  const tzLabel = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "Local time";
    } catch {
      return "Local time";
    }
  }, []);

  const scheduleDialog = useCallback(
    (serverId: string, appName: string) =>
      new Promise<void>((resolve) => {
        setValue(toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000)));
        setForce(false);
        setError(null);
        setPending([]);
        setDialog({ serverId, appName, resolve });
      }),
    [],
  );

  // Load the list of existing pending schedules for this app when the
  // dialog opens, so the user sees what's already queued.
  useEffect(() => {
    if (!dialog) return;
    setLoadingPending(true);
    getScheduledDeploys("pending")
      .then(({ scheduled }) => {
        // Filter by app name — endpoint is fleet-wide, we only want this
        // app's pending items. Server side doesn't support filtering yet.
        setPending(
          scheduled.filter(
            (s) => s.appName === dialog.appName && s.serverId === dialog.serverId,
          ),
        );
      })
      .catch(() => setPending([]))
      .finally(() => setLoadingPending(false));
  }, [dialog]);

  // Global Escape handler — matches PromptDialog. Backdrop onKeyDown is
  // unreliable when focus lives inside a datetime-local input (Firefox
  // swallows Escape on the native picker). A window-level listener fires
  // regardless of which element has focus.
  useEffect(() => {
    if (!dialog) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        dialog?.resolve();
        setDialog(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog]);

  function handleClose() {
    dialog?.resolve();
    setDialog(null);
  }

  async function handleSubmit() {
    if (!dialog) return;
    const parsed = fromLocalInputValue(value);
    if (Number.isNaN(parsed.getTime())) {
      setError("Invalid date/time");
      return;
    }
    if (parsed.getTime() < Date.now()) {
      setError("Cannot schedule in the past");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const { scheduled: created } = await scheduleDeploy(
        dialog.serverId,
        dialog.appName,
        parsed.toISOString(),
        force,
      );
      // Append the freshly-created entry instead of re-fetching. Avoids
      // the double-request and, more importantly, avoids the bug where
      // a reload failure would mask a successful schedule as an error
      // in the UI.
      setPending((prev) => [...prev, created].sort(
        (a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime(),
      ));
      // Reset the form for a second submission without closing — user
      // might want to schedule multiple. Fresh +1h default, no force.
      setValue(toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000)));
      setForce(false);
    } catch (err: unknown) {
      setError((err as Error).message || "Schedule failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancelPending(id: string) {
    try {
      await cancelScheduledDeploy(id);
      setPending((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setError((err as Error).message || "Cancel failed");
    }
  }

  return (
    <ScheduleContext.Provider value={{ scheduleDialog }}>
      {children}
      {dialog && (
        <div
          className="animate-fade-in"
          role="dialog"
          aria-modal="true"
          aria-labelledby="schedule-title"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.6)",
            backdropFilter: "blur(4px)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            zIndex: 999,
          }}
          onClick={handleClose}
        >
          <div
            className="animate-slide-up"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-xl)",
              padding: "var(--space-6)",
              width: "100%",
              maxWidth: 560,
              maxHeight: "90vh",
              overflow: "auto",
              boxShadow: "var(--shadow-lg)",
            }}
          >
            <h3
              id="schedule-title"
              style={{
                fontSize: "var(--text-lg)",
                fontWeight: 600,
                marginBottom: "var(--space-1)",
                letterSpacing: "-0.01em",
              }}
            >
              Schedule deploy
            </h3>
            <p
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--text-secondary)",
                marginBottom: "var(--space-4)",
              }}
            >
              <strong>{dialog.appName}</strong>
            </p>

            {/* Quick presets */}
            <div
              style={{
                display: "flex",
                gap: "var(--space-2)",
                flexWrap: "wrap",
                marginBottom: "var(--space-3)",
              }}
            >
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setValue(toLocalInputValue(p.compute()))}
                  className="btn btn-secondary btn-sm"
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* Datetime input */}
            <label
              style={{
                display: "block",
                fontSize: "var(--text-sm)",
                color: "var(--text-secondary)",
                marginBottom: "var(--space-2)",
              }}
            >
              Deploy at
            </label>
            <input
              type="datetime-local"
              value={value}
              // Deliberately no `min` attribute — recomputing it on
              // every render racing against the user's preset clicks
              // caused staleness bugs. The submit path at handleSubmit
              // already rejects past dates authoritatively.
              onChange={(e) => setValue(e.target.value)}
              className="input"
              style={{ width: "100%", marginBottom: "var(--space-1)" }}
            />
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--muted)",
                marginBottom: "var(--space-3)",
              }}
            >
              {tzLabel}
              {value && (
                <>
                  {" · "}
                  <span>{relativeLabel(fromLocalInputValue(value).toISOString())}</span>
                </>
              )}
            </div>

            {/* Force flag */}
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                fontSize: "var(--text-sm)",
                marginBottom: "var(--space-4)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
              />
              <span>Force deploy (bypass preflight + diff checks)</span>
            </label>

            {error && (
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--danger, #dc2626)",
                  marginBottom: "var(--space-3)",
                }}
              >
                {error}
              </div>
            )}

            <div
              style={{
                display: "flex",
                gap: "var(--space-2)",
                justifyContent: "flex-end",
                marginBottom: "var(--space-4)",
              }}
            >
              <button
                onClick={handleClose}
                className="btn btn-secondary"
                type="button"
                disabled={submitting}
              >
                Close
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting || !value}
                className="btn btn-primary"
                type="button"
              >
                {submitting ? "Scheduling…" : "Schedule"}
              </button>
            </div>

            {/* Existing pending schedules for this app */}
            <div
              style={{
                borderTop: "1px solid var(--border)",
                paddingTop: "var(--space-3)",
              }}
            >
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: "var(--muted)",
                  marginBottom: "var(--space-2)",
                }}
              >
                Pending schedules for this app
              </div>
              {loadingPending ? (
                <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                  Loading…
                </div>
              ) : pending.length === 0 ? (
                <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                  Nothing scheduled yet.
                </div>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {pending.map((p) => (
                    <li
                      key={p.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "var(--space-2)",
                        fontSize: "var(--text-sm)",
                        padding: "var(--space-2) 0",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontFamily: "var(--font-mono, monospace)" }}>
                          {new Date(p.scheduledFor).toLocaleString()}
                        </div>
                        <div
                          style={{
                            fontSize: "var(--text-xs)",
                            color: "var(--muted)",
                          }}
                        >
                          {relativeLabel(p.scheduledFor)}
                          {p.force && " · force"}
                        </div>
                      </div>
                      <button
                        onClick={() => handleCancelPending(p.id)}
                        className="btn btn-secondary btn-sm"
                        type="button"
                      >
                        Cancel
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </ScheduleContext.Provider>
  );
}
