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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
        <h1 style={{ fontSize: "var(--text-lg)", fontWeight: 700 }}>Servers</h1>
        <button onClick={() => setShowForm(!showForm)} className="btn btn-primary">
          {showForm ? "Cancel" : "+ Add Server"}
        </button>
      </div>

      {showForm && <AddServerForm onCreated={() => { setShowForm(false); toast("Server added", "success"); load(); }} />}

      {loading ? (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {[1, 2].map((i) => (
            <div key={i} className="card animate-pulse" style={{ padding: "var(--space-3)", height: 64 }} />
          ))}
        </div>
      ) : servers.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>No servers configured. Add one to get started.</p>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {servers.map((s) => (
            <div key={s.id} className="card" style={{ padding: "var(--space-3)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <Link href={`/servers/${s.id}`} style={{ fontWeight: 600, color: "var(--primary)", textDecoration: "none" }}>{s.name}</Link>
                <div style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>
                  {s.host} · {s._count.apps} app{s._count.apps !== 1 ? "s" : ""} · <StatusBadge status={s.status} />
                </div>
              </div>
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
                <button onClick={() => handleTest(s.id)} disabled={testing === s.id} className="btn btn-secondary">
                  {testing === s.id ? "Testing..." : "Test"}
                </button>
                <button onClick={() => handleDelete(s.id, s.name)} className="btn btn-danger">
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    online: "#22c55e",
    offline: "#ef4444",
    "no-relay": "#f59e0b",
    unknown: "#6b7280",
  };
  return <span style={{ color: colors[status] ?? colors.unknown, fontWeight: 500 }}>● {status}</span>;
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
    <form onSubmit={handleSubmit} className="card" style={{ padding: "var(--space-3)", marginBottom: "var(--space-4)", display: "grid", gap: "var(--space-2)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-2)" }}>
        <input type="text" placeholder="Server name" value={name} onChange={(e) => setName(e.target.value)} required className="input" />
        <input type="text" placeholder="Host (e.g. 192.168.1.100)" value={host} onChange={(e) => setHost(e.target.value)} required className="input" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-2)" }}>
        <input type="url" placeholder="Relay URL (optional)" value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)} className="input" />
        <input type="text" placeholder="Relay token (optional)" value={relayToken} onChange={(e) => setRelayToken(e.target.value)} className="input" />
      </div>
      {error && <p style={{ color: "var(--danger)", fontSize: "var(--text-sm)" }}>{error}</p>}
      <button type="submit" disabled={submitting} className="btn btn-primary" style={{ justifySelf: "start" }}>
        {submitting ? "Adding..." : "Add Server"}
      </button>
    </form>
  );
}
