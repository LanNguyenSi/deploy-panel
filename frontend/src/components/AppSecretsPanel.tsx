"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getAppSecrets,
  setAppSecret,
  deleteAppSecret,
  setRequiredEnvKeys,
  type MaskedSecret,
} from "@/lib/api";

export interface AppSecretsPanelProps {
  serverId: string;
  appName: string;
  onError: (message: string) => void;
}

// Secrets are write-only: unlike EnvVarsPanel, there is no "reveal" toggle
// here and never will be — the panel never receives a plaintext value back
// from the API once one is set, so there is nothing to reveal. This is what
// makes deploy-time provisioning safe to re-apply the panel's own state into
// the deploy dir's .env even after `git clean -fdx` wipes it.
export default function AppSecretsPanel({ serverId, appName, onError }: AppSecretsPanelProps) {
  const [secrets, setSecrets] = useState<MaskedSecret[]>([]);
  const [requiredEnvKeys, setRequiredKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [requiredInput, setRequiredInput] = useState("");
  const [savingRequired, setSavingRequired] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAppSecrets(serverId, appName);
      setSecrets(data.secrets);
      setRequiredKeys(data.requiredEnvKeys);
      setRequiredInput(data.requiredEnvKeys.join(", "));
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [serverId, appName, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const addSecret = async () => {
    const key = newKey.trim();
    if (!key || !newValue) return;
    setSaving(true);
    try {
      await setAppSecret(serverId, appName, key, newValue);
      setNewKey("");
      setNewValue("");
      await load();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const removeSecret = async (key: string) => {
    try {
      await deleteAppSecret(serverId, appName, key);
      await load();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const saveRequiredKeys = async () => {
    const keys = requiredInput
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    setSavingRequired(true);
    try {
      const result = await setRequiredEnvKeys(serverId, appName, keys);
      setRequiredKeys(result.requiredEnvKeys);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setSavingRequired(false);
    }
  };

  if (loading) {
    return (
      <div style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>Loading secrets…</div>
    );
  }

  return (
    <div>
      <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "var(--space-3)" }}>
        Secrets are stored encrypted in the panel and re-applied into the deploy dir&apos;s .env on
        every deploy — they survive a git clean / re-clone on the VPS. Values are write-only: once
        set, they are never shown again.
      </p>

      {secrets.length === 0 ? (
        <p style={{ fontSize: "var(--text-sm)", color: "var(--muted)", marginBottom: "var(--space-2)" }}>
          No secrets stored for this app.
        </p>
      ) : (
        <table
          style={{
            width: "100%",
            fontSize: "var(--text-sm)",
            borderCollapse: "collapse",
            marginBottom: "var(--space-3)",
          }}
        >
          <thead>
            <tr style={{ color: "var(--muted)", textAlign: "left" }}>
              <th style={{ padding: "var(--space-1) 0", width: "40%" }}>Key</th>
              <th style={{ padding: "var(--space-1) 0" }}>Status</th>
              <th style={{ padding: "var(--space-1) 0" }}>Updated</th>
              <th style={{ padding: "var(--space-1) 0", width: "6rem" }}></th>
            </tr>
          </thead>
          <tbody>
            {secrets.map((s) => (
              <tr key={s.key}>
                <td style={{ padding: "var(--space-1) var(--space-2) var(--space-1) 0", fontFamily: "var(--font-mono, monospace)" }}>
                  {s.key}
                </td>
                <td style={{ padding: "var(--space-1) var(--space-2) var(--space-1) 0" }}>
                  <span className="badge badge-success">set · ••••••••</span>
                </td>
                <td style={{ padding: "var(--space-1) var(--space-2) var(--space-1) 0", color: "var(--muted)" }}>
                  {new Date(s.updatedAt).toLocaleString()}
                </td>
                <td style={{ padding: "var(--space-1) 0" }}>
                  <button
                    type="button"
                    onClick={() => void removeSecret(s.key)}
                    className="btn btn-danger btn-sm"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", marginBottom: "var(--space-4)" }}>
        <input
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="KEY (e.g. METRICS_API_TOKEN)"
          className="input-native"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        />
        <input
          type="password"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          placeholder="value"
          className="input-native"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        />
        <button
          type="button"
          onClick={() => void addSecret()}
          disabled={saving || !newKey.trim() || !newValue}
          className="btn btn-primary btn-sm"
        >
          {saving ? "Saving…" : "Set secret"}
        </button>
      </div>

      <div>
        <label style={{ display: "block", fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "var(--space-1)" }}>
          Required env keys (comma-separated) — preflight and every deploy hard-fail if one of these
          resolves empty
        </label>
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
          <input
            value={requiredInput}
            onChange={(e) => setRequiredInput(e.target.value)}
            placeholder="METRICS_API_TOKEN, DB_PASSWORD"
            className="input-native"
            style={{ flex: 1, fontFamily: "var(--font-mono, monospace)" }}
          />
          <button
            type="button"
            onClick={() => void saveRequiredKeys()}
            disabled={savingRequired}
            className="btn btn-secondary btn-sm"
          >
            {savingRequired ? "Saving…" : "Save"}
          </button>
        </div>
        {requiredEnvKeys.length > 0 && (
          <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginTop: "var(--space-1)" }}>
            Currently required: {requiredEnvKeys.join(", ")}
          </p>
        )}
      </div>
    </div>
  );
}
