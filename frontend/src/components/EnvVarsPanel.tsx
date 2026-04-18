"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getAppEnv,
  setAppEnv,
  getAppEnvHistory,
  type EnvEntry,
  type EnvVarChange,
} from "@/lib/api";

export interface EnvVarsPanelProps {
  serverId: string;
  appName: string;
  onError: (message: string) => void;
  onSaved?: () => void;
}

interface EditableEntry {
  key: string;
  value: string;
  sensitive: boolean;
  // Tracks whether the value has been revealed by the user (sensitive entries
  // start hidden). Non-sensitive entries are always visible.
  revealed: boolean;
}

function classify(key: string): boolean {
  return /(PASSWORD|PASSWD|PWD|SECRET|TOKEN|KEY|DSN|AUTH|CREDENTIAL|PRIVATE)/i.test(
    key,
  );
}

export default function EnvVarsPanel({
  serverId,
  appName,
  onError,
  onSaved,
}: EnvVarsPanelProps) {
  const [entries, setEntries] = useState<EditableEntry[]>([]);
  const [initialKey, setInitialKey] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedHint, setSavedHint] = useState(false);
  const [history, setHistory] = useState<EnvVarChange[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAppEnv(serverId, appName);
      const rows = data.entries.map((e: EnvEntry) => ({
        key: e.key,
        value: e.value,
        sensitive: e.sensitive,
        revealed: !e.sensitive,
      }));
      setEntries(rows);
      setInitialKey(new Map(rows.map((r) => [r.key, r.value])));
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [serverId, appName, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => {
    if (entries.length !== initialKey.size) return true;
    for (const e of entries) {
      if (!initialKey.has(e.key)) return true;
      if (initialKey.get(e.key) !== e.value) return true;
    }
    return false;
  }, [entries, initialKey]);

  const duplicateKeys = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.key, (counts.get(e.key) ?? 0) + 1);
    return new Set(Array.from(counts.entries()).filter(([, n]) => n > 1).map(([k]) => k));
  }, [entries]);

  const invalidKey = useMemo(
    () => entries.some((e) => e.key && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.key)),
    [entries],
  );

  const addRow = () => {
    setEntries((prev) => [
      ...prev,
      { key: "", value: "", sensitive: false, revealed: true },
    ]);
  };

  const removeRow = (idx: number) => {
    setEntries((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateKey = (idx: number, key: string) => {
    setEntries((prev) =>
      prev.map((row, i) =>
        i === idx
          ? {
              ...row,
              key,
              sensitive: classify(key),
              // If the row is new (not originally sensitive), don't flip its
              // revealed state — the user typed it, they already see it.
            }
          : row,
      ),
    );
  };

  const updateValue = (idx: number, value: string) => {
    setEntries((prev) =>
      prev.map((row, i) => (i === idx ? { ...row, value } : row)),
    );
  };

  const toggleReveal = (idx: number) => {
    setEntries((prev) =>
      prev.map((row, i) => (i === idx ? { ...row, revealed: !row.revealed } : row)),
    );
  };

  const save = async () => {
    if (duplicateKeys.size > 0 || invalidKey) return;
    setSaving(true);
    try {
      // Drop rows with empty keys (user clicked Add then didn't fill it in).
      const toSend = entries
        .filter((e) => e.key.trim() !== "")
        .map((e) => ({ key: e.key, value: e.value }));
      const result = await setAppEnv(serverId, appName, toSend);
      setInitialKey(new Map(result.entries.map((e) => [e.key, e.value])));
      setEntries(
        result.entries.map((e) => ({
          key: e.key,
          value: e.value,
          sensitive: e.sensitive,
          revealed: !e.sensitive,
        })),
      );
      if (result.needsRedeploy) setSavedHint(true);
      onSaved?.();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const openHistory = async () => {
    setShowHistory(true);
    try {
      const data = await getAppEnvHistory(serverId, appName);
      setHistory(data.changes);
    } catch (err) {
      onError((err as Error).message);
    }
  };

  if (loading) {
    return (
      <div style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>Loading env vars…</div>
    );
  }

  return (
    <div>
      {savedHint && (
        <div
          role="status"
          style={{
            marginBottom: "var(--space-2)",
            padding: "var(--space-2) var(--space-3)",
            background: "var(--warning-bg, #fef3c7)",
            border: "1px solid var(--warning, #f59e0b)",
            borderRadius: "6px",
            color: "var(--warning-fg, #92400e)",
            fontSize: "var(--text-sm)",
          }}
        >
          Saved. Re-deploy required for the new values to take effect.
        </div>
      )}

      {entries.length === 0 ? (
        <p style={{ fontSize: "var(--text-sm)", color: "var(--muted)", marginBottom: "var(--space-2)" }}>
          No environment variables set.
        </p>
      ) : (
        <table
          style={{
            width: "100%",
            fontSize: "var(--text-sm)",
            borderCollapse: "collapse",
            marginBottom: "var(--space-2)",
          }}
        >
          <thead>
            <tr style={{ color: "var(--muted)", textAlign: "left" }}>
              <th style={{ padding: "var(--space-1) 0", width: "30%" }}>Key</th>
              <th style={{ padding: "var(--space-1) 0" }}>Value</th>
              <th style={{ padding: "var(--space-1) 0", width: "6rem" }}></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, idx) => {
              const dup = duplicateKeys.has(e.key);
              const invalid = e.key && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.key);
              return (
                <tr key={idx}>
                  <td style={{ padding: "var(--space-1) var(--space-2) var(--space-1) 0" }}>
                    <input
                      value={e.key}
                      onChange={(ev) => updateKey(idx, ev.target.value)}
                      placeholder="KEY"
                      className="input-native"
                      style={{
                        width: "100%",
                        fontFamily: "var(--font-mono, monospace)",
                        borderColor: dup || invalid ? "var(--danger)" : undefined,
                      }}
                    />
                  </td>
                  <td style={{ padding: "var(--space-1) var(--space-2) var(--space-1) 0" }}>
                    <input
                      type={e.sensitive && !e.revealed ? "password" : "text"}
                      value={e.value}
                      onChange={(ev) => updateValue(idx, ev.target.value)}
                      placeholder="value"
                      className="input-native"
                      style={{ width: "100%", fontFamily: "var(--font-mono, monospace)" }}
                    />
                  </td>
                  <td style={{ padding: "var(--space-1) 0", whiteSpace: "nowrap" }}>
                    {e.sensitive ? (
                      <button
                        type="button"
                        onClick={() => toggleReveal(idx)}
                        className="btn btn-secondary btn-sm"
                        title={e.revealed ? "Hide value" : "Reveal value"}
                      >
                        {e.revealed ? "Hide" : "Reveal"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => removeRow(idx)}
                      className="btn btn-danger btn-sm"
                      style={{ marginLeft: "var(--space-1)" }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {(duplicateKeys.size > 0 || invalidKey) && (
        <p style={{ color: "var(--danger)", fontSize: "var(--text-xs)", marginBottom: "var(--space-2)" }}>
          {duplicateKeys.size > 0 && `Duplicate keys: ${Array.from(duplicateKeys).join(", ")}. `}
          {invalidKey && "Keys must start with a letter or _ and contain only letters, digits, or _."}
        </p>
      )}

      <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
        <button type="button" onClick={addRow} className="btn btn-secondary btn-sm">
          + Add variable
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || saving || duplicateKeys.size > 0 || invalidKey}
          className="btn btn-primary btn-sm"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={() => void openHistory()} className="btn btn-secondary btn-sm">
          History
        </button>
        {dirty && (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
            unsaved changes
          </span>
        )}
      </div>

      {showHistory && (
        <div
          style={{
            marginTop: "var(--space-3)",
            padding: "var(--space-2)",
            background: "var(--surface-alt, #f3f4f6)",
            borderRadius: "6px",
            fontSize: "var(--text-xs)",
            maxHeight: "12rem",
            overflow: "auto",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--space-1)" }}>
            <strong>Change history (last 100)</strong>
            <button
              type="button"
              onClick={() => setShowHistory(false)}
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)" }}
            >
              close
            </button>
          </div>
          {history.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>No recorded changes.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: "var(--space-3)" }}>
              {history.map((h) => (
                <li key={h.id}>
                  <code>{h.key}</code> {h.changeType}
                  {h.actor ? ` by ${h.actor}` : ""} · {new Date(h.createdAt).toLocaleString()}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
