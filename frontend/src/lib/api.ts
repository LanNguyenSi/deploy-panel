const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    credentials: "include",
    ...init,
  });

  if (res.status === 401) {
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
    throw new Error("Authentication required");
  }

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
  tag: string | null;
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
  log: string | null;
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

// ── Apps ───────────────────────────────────────────────────────────────────

export interface AppWithCount extends App {
  _count: { deploys: number };
}

export async function getApps(serverId: string): Promise<{ apps: AppWithCount[] }> {
  return request(`/api/servers/${serverId}/apps`);
}

export async function deployApp(serverId: string, name: string, options?: { branch?: string; force?: boolean }): Promise<{ deploy: { id: string; status: string } }> {
  return request(`/api/servers/${serverId}/apps/${name}/deploy`, { method: "POST", body: JSON.stringify(options ?? {}) });
}

export async function getDeployStatus(serverId: string, appName: string, deployId: string): Promise<{ deploy: Deploy }> {
  return request(`/api/servers/${serverId}/apps/${appName}/deploys/${deployId}`);
}

export async function rollbackApp(serverId: string, name: string, toCommit?: string): Promise<unknown> {
  return request(`/api/servers/${serverId}/apps/${name}/rollback`, { method: "POST", body: JSON.stringify({ to_commit: toCommit }) });
}

export async function getAppLogs(serverId: string, name: string, lines = 50): Promise<{ logs: string }> {
  return request(`/api/servers/${serverId}/apps/${name}/logs?lines=${lines}`);
}

export async function tagApp(serverId: string, name: string, tag: string | null): Promise<{ app: App }> {
  return request(`/api/servers/${serverId}/apps/${name}/tag`, { method: "PATCH", body: JSON.stringify({ tag }) });
}

export async function hideApp(serverId: string, name: string): Promise<void> {
  return request(`/api/servers/${serverId}/apps/${name}`, { method: "DELETE" });
}

export async function syncServer(serverId: string): Promise<{ synced: boolean; apps: number; created: number; updated: number }> {
  return request(`/api/servers/${serverId}/sync`, { method: "POST" });
}

export async function getAppPreflight(serverId: string, name: string): Promise<{ passed: boolean; checks: Array<{ name: string; passed: boolean; message: string }> }> {
  return request(`/api/servers/${serverId}/apps/${name}/preflight`);
}

// ── Deploys ────────────────────────────────────────────────────────────────

export interface DeployWithRelations extends Deploy {
  app: { name: string };
  server: { name: string; host: string };
}

// ── Audit ─────────────────────────────────────────────────────────────────

export interface AuditEntry {
  id: string;
  action: string;
  target: string | null;
  detail: string | null;
  actor: string | null;
  createdAt: string;
}

export async function getAuditLog(params?: { action?: string; limit?: number; offset?: number }): Promise<{ entries: AuditEntry[]; total: number }> {
  const query = new URLSearchParams();
  if (params?.action) query.set("action", params.action);
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.offset) query.set("offset", String(params.offset));
  return request(`/api/audit?${query}`);
}

// ── Deploys ────────────────────────────────────────────────────────────────

export async function getDeploys(params?: { serverId?: string; appId?: string; status?: string; limit?: number }): Promise<{ deploys: DeployWithRelations[] }> {
  const query = new URLSearchParams();
  if (params?.serverId) query.set("serverId", params.serverId);
  if (params?.appId) query.set("appId", params.appId);
  if (params?.status) query.set("status", params.status);
  if (params?.limit) query.set("limit", String(params.limit));
  return request(`/api/deploys?${query}`);
}
