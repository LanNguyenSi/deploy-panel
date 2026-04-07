const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    credentials: "include",
    ...init,
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({ message: "Request failed" }))) as { message?: string };
    throw new Error(err.message ?? "Request failed");
  }

  return res.json() as Promise<T>;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface Server {
  id: string;
  name: string;
  host: string;
  status: string;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface App {
  id: string;
  serverId: string;
  name: string;
  status: string;
  health: string | null;
  lastDeployAt: string | null;
}

export interface Deploy {
  id: string;
  serverId: string;
  appId: string;
  commitBefore: string | null;
  commitAfter: string | null;
  status: string;
  duration: number | null;
  triggeredBy: string | null;
  createdAt: string;
}

// ── API Functions ───────────────────────────────────────────────────────────

export async function getHealth(): Promise<{ status: string }> {
  return request("/api/health");
}

// ── Servers ────────────────────────────────────────────────────────────────

export interface ServerWithCount extends Server {
  _count: { apps: number };
}

export async function getServers(): Promise<{ servers: ServerWithCount[] }> {
  return request("/api/servers");
}

export async function getServer(id: string): Promise<{ server: Server & { apps: App[] } }> {
  return request(`/api/servers/${id}`);
}

export async function createServer(data: { name: string; host: string; relayUrl?: string; relayToken?: string }): Promise<{ server: Server }> {
  return request("/api/servers", { method: "POST", body: JSON.stringify(data) });
}

export async function deleteServer(id: string): Promise<void> {
  return request(`/api/servers/${id}`, { method: "DELETE" });
}

export async function testServer(id: string): Promise<{ status: string; message?: string }> {
  return request(`/api/servers/${id}/test`, { method: "POST" });
}
