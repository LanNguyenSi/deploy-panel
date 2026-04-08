"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getServers, createServer, deleteServer, testServer, type ServerWithCount } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";

export default function ServersPage() {
  const [servers, setServers] = useState<ServerWithCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const { toast } = useToast();
  const { confirm } = useConfirm();

  async function load() {
    try {
      const data = await getServers();
      setServers(data.servers);
    } catch (err) {
      console.error("Failed to load servers:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleTest(id: string) {
    setTesting(id);
    try {
      const result = await testServer(id);
      toast(`Server ${result.status}${result.message ? ` — ${result.message}` : ""}`, result.status === "online" ? "success" : "error");
      await load();
    } catch (err: any) {
      toast(`Test failed: ${err.message}`, "error");
    } finally {
      setTesting(null);
    }
  }

  async function handleDelete(id: string, name: string) {
    const ok = await confirm({
      title: "Delete Server",
      message: `Delete "${name}"? This also removes all associated apps and deploy history.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteServer(id);
      toast(`Server "${name}" deleted`, "success");
      await load();
    } catch (err: any) {
      toast(`Delete failed: ${err.message}`, "error");
    }
  }

  return (
    <main className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">Servers</h1>
          <p className="page-subtitle">{servers.length} server{servers.length !== 1 ? "s" : ""} configured</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="btn btn-primary">
          {showForm ? "Cancel" : "+ Add Server"}
        </button>
      </div>

      {showForm && (
        <div className="animate-slide-up">
          <AddServerForm onCreated={() => { setShowForm(false); toast("Server added", "success"); load(); }} />
        </div>
      )}

      {loading ? (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {[1, 2].map((i) => (
            <div key={i} className="card skeleton" style={{ height: 80 }} />
          ))}
        </div>
      ) : servers.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-state-icon">&#9881;</div>
          <div className="empty-state-title">No servers configured</div>
          <div className="empty-state-text">Add a server to start managing your deployments.</div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {servers.map((s) => (
            <div key={s.id} className="card" style={{ padding: "var(--space-4) var(--space-5)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                  <span className={`status-dot status-dot-${s.status}`} />
                  <div>
                    <Link href={`/servers/${s.id}`} style={{ fontWeight: 600, color: "var(--text)", textDecoration: "none", fontSize: "var(--text-md)" }}>
                      {s.name}
                    </Link>
                    <div style={{ fontSize: "var(--text-sm)", color: "var(--muted)", marginTop: 2 }}>
                      {s.host} · {s._count.apps} app{s._count.apps !== 1 ? "s" : ""}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <span className={`badge badge-${s.status === "online" ? "success" : s.status === "offline" ? "danger" : s.status === "no-relay" ? "warning" : "neutral"}`}>
                    {s.status}
                  </span>
                  <button onClick={() => handleTest(s.id)} disabled={testing === s.id} className="btn btn-secondary btn-sm">
                    {testing === s.id ? "Testing..." : "Test"}
                  </button>
                  <button onClick={() => handleDelete(s.id, s.name)} className="btn btn-danger btn-sm">
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

function AddServerForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [relayUrl, setRelayUrl] = useState("");
  const [relayToken, setRelayToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await createServer({ name, host, relayUrl: relayUrl || undefined, relayToken: relayToken || undefined });
      onCreated();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card" style={{ padding: "var(--space-5)", marginBottom: "var(--space-6)" }}>
      <h3 style={{ fontSize: "var(--text-md)", fontWeight: 600, marginBottom: "var(--space-4)" }}>Add Server</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-3)" }}>
        <div>
          <label style={{ display: "block", fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "var(--space-1)", fontWeight: 500 }}>
            Server name
          </label>
          <input type="text" placeholder="e.g. Production VPS" value={name} onChange={(e) => setName(e.target.value)} required className="input" />
        </div>
        <div>
          <label style={{ display: "block", fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "var(--space-1)", fontWeight: 500 }}>
            Host
          </label>
          <input type="text" placeholder="e.g. 192.168.1.100" value={host} onChange={(e) => setHost(e.target.value)} required className="input" />
        </div>
        <div>
          <label style={{ display: "block", fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "var(--space-1)", fontWeight: 500 }}>
            Relay URL <span style={{ color: "var(--muted)" }}>(optional)</span>
          </label>
          <input type="url" placeholder="https://relay.example.com" value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)} className="input" />
        </div>
        <div>
          <label style={{ display: "block", fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "var(--space-1)", fontWeight: 500 }}>
            Relay token <span style={{ color: "var(--muted)" }}>(optional)</span>
          </label>
          <input type="text" placeholder="Token" value={relayToken} onChange={(e) => setRelayToken(e.target.value)} className="input" />
        </div>
      </div>
      {error && <p className="login-error" style={{ marginTop: "var(--space-3)" }}>{error}</p>}
      <div style={{ marginTop: "var(--space-4)", display: "flex", gap: "var(--space-2)" }}>
        <button type="submit" disabled={submitting} className="btn btn-primary">
          {submitting ? "Adding..." : "Add Server"}
        </button>
      </div>
    </form>
  );
}
