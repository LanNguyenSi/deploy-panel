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
  /** Last-known install mode (greenfield / existing-traefik / port-only / null). */
  relayMode?: string | null;
  relayUrl?: string | null;
  /** Absolute install dir on the VPS (default /opt/agent-relay). Null on legacy rows. */
  relayDir?: string | null;
  /** Compose filename override. Null = default docker-compose.yml. Non-null for prod-override installs. */
  relayComposeFile?: string | null;
  /** Indicates we have a pinned host-key fingerprint stored — re-install will pin against it. */
  hasHostKeyPinned?: boolean;
}

export interface App {
  id: string;
  serverId: string;
  name: string;
  status: string;
  health: string | null;
  tag: string | null;
  liveUrl: string | null;
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

export type RelayMode = "auto" | "greenfield" | "existing-traefik" | "port-only";

/**
 * SSE event emitted by POST /api/servers/install-relay. Shape mirrors
 * `event: <name>` + `data: <json>` frames from the backend route.
 */
export type InstallRelayEvent =
  | { event: "progress"; data: { stream: "stdout" | "stderr"; line: string } }
  | {
      event: "done";
      data: {
        serverId: string;
        name: string;
        host: string;
        relayUrl: string;
        relayMode?: RelayMode;
      };
    }
  | { event: "error"; data: { kind: string; message: string } };

export interface InstallRelayRequest {
  name: string;
  host: string;
  sshUser?: string;
  sshPort?: number;
  sshPassword?: string;
  sshPrivateKey?: string;
  sshPassphrase?: string;
  relayDomain?: string;
  traefikEmail?: string;
  appsDir?: string;
  /** install.sh v0.2.0 env surface. */
  relayMode?: RelayMode;
  traefikNetwork?: string;
  traefikCertResolver?: string;
  relayBind?: string;
  /** SHA-256 host-key fingerprint captured during the pre-install probe. */
  expectedHostKeySha256?: string;
}

// Mirror of the backend probe-vps shape. Shape is stable because the
// wizard treats it as read-only and only drills into `suggestedMode` /
// `suggestedTraefikNetwork` for the pre-fill.
export type Port80Owner =
  | { kind: "free" }
  | { kind: "traefik"; name: string; image: string }
  | { kind: "docker"; name: string; image: string }
  | { kind: "proc"; process: string }
  | { kind: "unknown" };

export interface VpsProbeResult {
  port80: Port80Owner;
  port443: Port80Owner;
  containers: Array<{ name: string; image: string; ports: string; networks: string[] }>;
  networks: string[];
  suggestedMode: "greenfield" | "existing-traefik" | "port-only";
  suggestedTraefikNetwork?: string;
}

export interface ProbeVpsRequest {
  host: string;
  sshUser?: string;
  sshPort?: number;
  sshPassword?: string;
  sshPrivateKey?: string;
  sshPassphrase?: string;
}

export interface ProbeVpsResponse {
  probe: VpsProbeResult;
  /** SHA-256 fingerprint of the host key presented during the probe. */
  hostKeySha256?: string;
}

export async function probeVps(req: ProbeVpsRequest): Promise<ProbeVpsResponse> {
  const res = await fetch(`${BASE}/api/servers/probe-vps`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ message: `HTTP ${res.status}` }))) as {
      error?: string;
      message?: string;
    };
    const err = new Error(body.message ?? `probe failed (HTTP ${res.status})`) as Error & {
      kind?: string;
    };
    err.kind = body.error ?? "probe_failed";
    throw err;
  }
  return (await res.json()) as ProbeVpsResponse;
}

/**
 * Stream install-relay events. Uses a POST + fetch ReadableStream
 * because EventSource only supports GET. The returned async iterator
 * yields parsed events in order until the server closes the stream or
 * an `error`/`done` terminal frame arrives.
 *
 * If the initial POST fails the HTTP-request layer (non-200), this
 * yields a single synthetic `{ event: "error", data }` frame so the
 * caller can render it identically to server-emitted error frames.
 */
// Generic SSE-frame reader used by both first-install and re-install.
// Exposed as an internal helper because both routes emit the same
// `progress`/`done`/`error` envelope; only the URL differs.
async function* sseStream<T extends { event: string; data: unknown }>(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const res = await fetch(`${BASE}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    credentials: "include",
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const errBody = (await res
      .json()
      .catch(() => ({ message: `HTTP ${res.status}` }))) as {
      error?: string;
      message?: string;
    };
    yield {
      event: "error",
      data: {
        kind: errBody.error ?? "http_error",
        message: errBody.message ?? `request failed with status ${res.status}`,
      },
    } as T;
    return;
  }
  if (!res.body) {
    yield { event: "error", data: { kind: "no_body", message: "server returned empty stream" } } as T;
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let frameEnd: number;
    while ((frameEnd = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, frameEnd);
      buf = buf.slice(frameEnd + 2);
      let eventName = "message";
      let dataStr = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
      }
      if (dataStr.length === 0) continue;
      let data: unknown;
      try {
        data = JSON.parse(dataStr);
      } catch {
        yield {
          event: "error",
          data: { kind: "parse_error", message: `malformed data frame: ${dataStr.slice(0, 120)}` },
        } as T;
        continue;
      }
      yield { event: eventName, data } as T;
    }
  }
}

export async function* installRelayStream(
  req: InstallRelayRequest,
  signal?: AbortSignal,
): AsyncGenerator<InstallRelayEvent> {
  yield* sseStream<InstallRelayEvent>("/api/servers/install-relay", req, signal);
}

export interface ReinstallRelayRequest {
  sshUser?: string;
  sshPort?: number;
  sshPassword?: string;
  sshPrivateKey?: string;
  sshPassphrase?: string;
  /** install.sh v0.2.0 env surface — defaults derived from the stored relayMode if omitted. */
  relayMode?: RelayMode;
  traefikNetwork?: string;
  traefikCertResolver?: string;
  relayBind?: string;
  relayDomain?: string;
  traefikEmail?: string;
  appsDir?: string;
  /** Override / backfill the relay's install dir on the VPS (default /opt/agent-relay). */
  relayDir?: string;
  /** Override / backfill the compose filename (default docker-compose.yml). */
  relayComposeFile?: string;
  /** Force a fresh AUTH_TOKEN on the VPS instead of preserving the current one. */
  rotateToken?: boolean;
}

export type ReinstallRelayEvent =
  | { event: "progress"; data: { stream: "stdout" | "stderr"; line: string } }
  | {
      event: "done";
      data: {
        serverId: string;
        name: string;
        host: string;
        relayUrl: string;
        tokenRotated: boolean;
        /** True when the VPS-side .env was wiped out-of-band and install.sh emitted a different token than DB. */
        tokenDiverged?: boolean;
        relayMode?: RelayMode;
      };
    }
  | { event: "error"; data: { kind: string; message: string } };

export async function* reinstallRelayStream(
  serverId: string,
  req: ReinstallRelayRequest,
  signal?: AbortSignal,
): AsyncGenerator<ReinstallRelayEvent> {
  yield* sseStream<ReinstallRelayEvent>(
    `/api/servers/${encodeURIComponent(serverId)}/install-relay`,
    req,
    signal,
  );
}

export interface UpdateRelayImageRequest {
  sshUser?: string;
  sshPort?: number;
  sshPassword?: string;
  sshPrivateKey?: string;
  sshPassphrase?: string;
  /** Override / backfill the relay's install dir on the VPS (default /opt/agent-relay). */
  relayDir?: string;
  /** Override / backfill the compose filename (default docker-compose.yml). Useful for prod overrides. */
  relayComposeFile?: string;
}

export type UpdateRelayImageEvent =
  | { event: "progress"; data: { stream: "stdout" | "stderr"; line: string } }
  | {
      event: "done";
      data: {
        serverId: string;
        name: string;
        host: string;
        /** Whether the post-update health probe on /health returned 200. */
        healthOk: boolean;
      };
    }
  | { event: "error"; data: { kind: string; message: string } };

export async function* updateRelayImageStream(
  serverId: string,
  req: UpdateRelayImageRequest,
  signal?: AbortSignal,
): AsyncGenerator<UpdateRelayImageEvent> {
  yield* sseStream<UpdateRelayImageEvent>(
    `/api/servers/${encodeURIComponent(serverId)}/update-relay-image`,
    req,
    signal,
  );
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

export interface SystemMetrics {
  cpu: { usage: number };
  memory: { usedMb: number; totalMb: number };
  disk: { used: string; total: string; percent: string };
  uptime: number;
}

export async function getServerSystem(id: string): Promise<SystemMetrics> {
  return request(`/api/servers/${id}/system`);
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

// Default matches single-deploy semantics: preflight is NOT bypassed
// unless the caller explicitly opts in. The earlier `force = true`
// default meant one click silently skipped preflight for every app in
// the batch — exactly the scenario where preflight matters most.
// Callers that really want to bypass preflight for a bulk must pass true.
export async function bulkDeploy(
  serverId: string,
  apps: string[],
  force = false,
): Promise<{
  deploys: Array<{ app: string; deployId: string; status: string; error?: string }>;
}> {
  return request(`/api/servers/${serverId}/apps/bulk-deploy`, {
    method: "POST",
    body: JSON.stringify({ apps, force }),
  });
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

export async function setAppLiveUrl(
  serverId: string,
  name: string,
  liveUrl: string | null,
): Promise<{ app: App }> {
  return request(`/api/servers/${serverId}/apps/${name}/live-url`, {
    method: "PATCH",
    body: JSON.stringify({ liveUrl }),
  });
}

export async function hideApp(serverId: string, name: string): Promise<void> {
  return request(`/api/servers/${serverId}/apps/${name}`, { method: "DELETE" });
}

// ── App env vars ──────────────────────────────────────────────────────────

export interface EnvEntry {
  key: string;
  value: string;
  sensitive: boolean;
}

export interface EnvVarChange {
  id: string;
  appId: string;
  key: string;
  changeType: "create" | "update" | "delete";
  actor: string | null;
  createdAt: string;
}

export async function getAppEnv(
  serverId: string,
  name: string,
): Promise<{ entries: EnvEntry[] }> {
  return request(`/api/servers/${serverId}/apps/${name}/env`);
}

export async function setAppEnv(
  serverId: string,
  name: string,
  entries: { key: string; value: string }[],
): Promise<{ entries: EnvEntry[]; changes: number; needsRedeploy: boolean }> {
  return request(`/api/servers/${serverId}/apps/${name}/env`, {
    method: "PUT",
    body: JSON.stringify({ entries }),
  });
}

export async function getAppEnvHistory(
  serverId: string,
  name: string,
): Promise<{ changes: EnvVarChange[] }> {
  return request(`/api/servers/${serverId}/apps/${name}/env/history`);
}

// ── Scheduled Deploys ─────────────────────────────────────────────────────

export interface ScheduledDeployInfo {
  id: string;
  serverId: string;
  appName: string;
  scheduledFor: string;
  force: boolean;
  status: string;
  deployId: string | null;
  createdAt: string;
  server: { name: string };
}

export async function getScheduledDeploys(status = "pending"): Promise<{ scheduled: ScheduledDeployInfo[] }> {
  return request(`/api/scheduled?status=${status}`);
}

export async function scheduleDeploy(server: string, app: string, scheduledFor: string, force = false): Promise<{ scheduled: ScheduledDeployInfo }> {
  return request("/api/scheduled", { method: "POST", body: JSON.stringify({ server, app, scheduledFor, force }) });
}

export async function cancelScheduledDeploy(id: string): Promise<{ cancelled: boolean }> {
  return request(`/api/scheduled/${id}`, { method: "DELETE" });
}

// ── API Keys ──────────────────────────────────────────────────────────────

export interface ApiKeyInfo {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export async function getApiKeys(): Promise<{ keys: ApiKeyInfo[] }> {
  return request("/api/api-keys");
}

export async function createApiKey(name: string): Promise<{ key: { id: string; name: string; secret: string; prefix: string; createdAt: string }; warning: string }> {
  return request("/api/api-keys", { method: "POST", body: JSON.stringify({ name }) });
}

export async function revokeApiKey(id: string): Promise<{ deleted: boolean }> {
  return request(`/api/api-keys/${id}`, { method: "DELETE" });
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

export interface DeployDetail extends Deploy {
  app: { name: string; repoUrl: string | null; branch: string };
  server: { name: string; host: string };
  steps: Array<{ name: string; status: string; durationMs: number }>;
  compareUrl: string | null;
}

export async function getDeployDetail(id: string): Promise<{ deploy: DeployDetail }> {
  return request(`/api/deploys/${id}`);
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

export async function getDeploys(params?: { serverId?: string; appId?: string; status?: string; limit?: number; offset?: number }): Promise<{ deploys: DeployWithRelations[]; total: number }> {
  const query = new URLSearchParams();
  if (params?.serverId) query.set("serverId", params.serverId);
  if (params?.appId) query.set("appId", params.appId);
  if (params?.status) query.set("status", params.status);
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.offset != null) query.set("offset", String(params.offset));
  return request(`/api/deploys?${query}`);
}
