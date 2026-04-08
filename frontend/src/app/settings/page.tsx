"use client";

import { useEffect, useState } from "react";
import { getApiKeys, createApiKey, revokeApiKey, type ApiKeyInfo } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";

export default function SettingsPage() {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKeyName, setNewKeyName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const { toast } = useToast();
  const { confirm } = useConfirm();

  async function load() {
    try {
      const data = await getApiKeys();
      setKeys(data.keys);
    } catch (err) {
      console.error("Failed to load API keys:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newKeyName.trim()) return;
    setCreating(true);
    try {
      const result = await createApiKey(newKeyName.trim());
      setNewSecret(result.key.secret);
      setNewKeyName("");
      toast("API key created", "success");
      await load();
    } catch (err: any) {
      toast(`Failed: ${err.message}`, "error");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(key: ApiKeyInfo) {
    const ok = await confirm({
      title: "Revoke API Key",
      message: `Revoke "${key.name}" (${key.keyPrefix}...)? This cannot be undone. Any CI/CD pipelines using this key will stop working.`,
      confirmLabel: "Revoke",
      danger: true,
    });
    if (!ok) return;
    try {
      await revokeApiKey(key.id);
      toast(`Key "${key.name}" revoked`, "success");
      await load();
    } catch (err: any) {
      toast(`Failed: ${err.message}`, "error");
    }
  }

  return (
    <main className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">API keys and configuration</p>
        </div>
      </div>

      {/* Create key */}
      <section className="card" style={{ padding: "var(--space-5)", marginBottom: "var(--space-6)" }}>
        <h2 style={{ fontSize: "var(--text-md)", fontWeight: 600, marginBottom: "var(--space-1)" }}>API Keys</h2>
        <p style={{ fontSize: "var(--text-sm)", color: "var(--muted)", marginBottom: "var(--space-4)" }}>
          Create keys for CI/CD pipelines, MCP servers, or external integrations.
        </p>

        <form onSubmit={handleCreate} style={{ display: "flex", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
          <input
            type="text"
            placeholder="Key name (e.g. github-actions-prod)"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            required
            className="input"
            style={{ flex: 1 }}
          />
          <button type="submit" disabled={creating} className="btn btn-primary">
            {creating ? "Creating..." : "Create Key"}
          </button>
        </form>

        {/* New key secret banner */}
        {newSecret && (
          <div className="animate-slide-up" style={{
            padding: "var(--space-4)",
            background: "var(--success-muted)",
            border: "1px solid rgba(34,197,94,0.25)",
            borderRadius: "var(--radius)",
            marginBottom: "var(--space-4)",
          }}>
            <div style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--success)", marginBottom: "var(--space-2)" }}>
              Key created — copy it now, it won't be shown again
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
              <code style={{
                flex: 1, padding: "var(--space-2) var(--space-3)",
                background: "var(--bg)", borderRadius: "var(--radius-sm)",
                fontSize: "var(--text-sm)", color: "var(--text)",
                fontFamily: "monospace", wordBreak: "break-all",
              }}>
                {newSecret}
              </code>
              <button
                onClick={() => { navigator.clipboard.writeText(newSecret); toast("Copied!", "success"); }}
                className="btn btn-secondary btn-sm"
              >
                Copy
              </button>
            </div>
            <button
              onClick={() => setNewSecret(null)}
              style={{ marginTop: "var(--space-2)", fontSize: "var(--text-xs)", color: "var(--muted)", background: "none", border: "none", cursor: "pointer" }}
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Key list */}
        {loading ? (
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            {[1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 48 }} />)}
          </div>
        ) : keys.length === 0 ? (
          <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>No API keys yet.</p>
        ) : (
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            {keys.map((k) => (
              <div key={k.id} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "var(--space-3) var(--space-4)",
                background: "var(--bg-subtle)", borderRadius: "var(--radius)",
              }}>
                <div>
                  <div style={{ fontWeight: 500, fontSize: "var(--text-sm)" }}>{k.name}</div>
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)", display: "flex", gap: "var(--space-3)", marginTop: 2 }}>
                    <code>{k.keyPrefix}...</code>
                    <span>Created {timeAgo(k.createdAt)}</span>
                    {k.lastUsedAt && <span>Last used {timeAgo(k.lastUsedAt)}</span>}
                  </div>
                </div>
                <button onClick={() => handleRevoke(k)} className="btn btn-danger btn-sm">
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* API usage info */}
      <section className="card" style={{ padding: "var(--space-5)" }}>
        <h2 style={{ fontSize: "var(--text-md)", fontWeight: 600, marginBottom: "var(--space-3)" }}>API Usage</h2>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", display: "grid", gap: "var(--space-3)" }}>
          <div>
            <div style={{ fontWeight: 500, color: "var(--text)", marginBottom: "var(--space-1)" }}>Deploy via API</div>
            <code style={{ fontSize: "var(--text-xs)", color: "var(--muted)", background: "var(--bg-subtle)", padding: "var(--space-2) var(--space-3)", borderRadius: "var(--radius-sm)", display: "block" }}>
              curl -X POST /api/v1/deploy -H &quot;Authorization: Bearer dp_...&quot; -d &apos;{'{'}&#34;server&#34;:&#34;VPS-01&#34;,&#34;app&#34;:&#34;myapp&#34;{'}'}&#39;
            </code>
          </div>
          <div>
            <div style={{ fontWeight: 500, color: "var(--text)", marginBottom: "var(--space-1)" }}>MCP Server</div>
            <code style={{ fontSize: "var(--text-xs)", color: "var(--muted)", background: "var(--bg-subtle)", padding: "var(--space-2) var(--space-3)", borderRadius: "var(--radius-sm)", display: "block" }}>
              DEPLOY_PANEL_URL=https://deploy-panel.opentriologue.ai DEPLOY_PANEL_API_KEY=dp_... node mcp/dist/index.js
            </code>
          </div>
        </div>
      </section>
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
