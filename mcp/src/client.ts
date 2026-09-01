import type { Config } from "./config.js";

// App.id is `String @id @default(uuid())` (backend/prisma/schema.prisma):
// a standard RFC 4122 uuid, case-insensitively.
// Lowercase only: App.id comes from Prisma's uuid() default, which emits
// lowercase hex, and the id/name lookups in listDeploys compare with strict
// equality. A case-mismatched value must fall into the not-found branch
// rather than being forwarded as an app_id the backend will never match.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isAppId(value: string): boolean {
  return UUID_RE.test(value);
}

export interface DeployInfo {
  id: string; status: string; server: string; app: string;
  commitBefore?: string; commitAfter?: string; duration?: number;
  steps: unknown[]; triggeredBy?: string; createdAt: string;
}

export class DeployPanelClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;

  constructor(config: Config) {
    this.apiUrl = config.apiUrl;
    this.apiKey = config.apiKey;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error((err as Record<string, string>).message ?? `HTTP ${res.status}`);
    }

    return res.json() as Promise<T>;
  }

  async listServers() {
    return this.request<{ servers: Array<{ id: string; name: string; host: string; status: string; appCount: number }> }>("GET", "/api/v1/servers");
  }

  async listApps(serverId?: string) {
    const qs = serverId ? `?${new URLSearchParams({ server_id: serverId })}` : "";
    return this.request<{ apps: Array<{ id: string; name: string; status: string; tag: string | null; server: { id: string; name: string } }> }>("GET", `/api/v1/apps${qs}`);
  }

  async deploy(server: string, app: string, options?: { force?: boolean; ref?: string }) {
    return this.request<{ deploy: { id: string; status: string; server: string; app: string; triggeredBy: string } }>("POST", "/api/v1/deploy", {
      server, app, force: options?.force, ref: options?.ref,
    });
  }

  async getDeployStatus(deployId: string) {
    return this.request<{ deploy: DeployInfo }>("GET", `/api/v1/deploy/${deployId}`);
  }

  async listDeploys(options?: { app?: string; server?: string; status?: string; limit?: number }) {
    const params = new URLSearchParams();

    // server_id accepts a name or an id: GET /api/v1/deploys resolves it on
    // the backend via findOwnedServerByIdOrName (v1.ts), the same helper
    // used by listApps/deploy/rollback, so the raw value is forwarded as-is.
    if (options?.server) params.set("server_id", options.server);

    // Unlike server_id, GET /api/v1/deploys' app_id is a raw Prisma filter
    // that only ever matches an id (v1.ts's own comment: App.name is unique
    // per server, not globally, so a name-based lookup would be ambiguous
    // without also requiring server_id). Resolve an app name to its id here
    // via listApps, scoped to the same server filter so the resolution and
    // the final query agree on which app is meant.
    if (options?.app) {
      const { apps } = await this.listApps(options.server);
      const idMatch = apps.find((a) => a.id === options.app);
      const nameMatches = apps.filter((a) => a.name === options.app);

      if (idMatch) {
        params.set("app_id", idMatch.id);
      } else if (nameMatches.length === 1) {
        params.set("app_id", nameMatches[0].id);
      } else if (nameMatches.length > 1) {
        const servers = nameMatches.map((a) => a.server.name).join(", ");
        throw new Error(`App "${options.app}" is ambiguous: it exists on ${servers}. Pass server to disambiguate.`);
      } else if (isAppId(options.app)) {
        // GET /api/v1/apps drops apps tagged "ignored" (v1.ts), so an
        // existing app that happens to be ignored never shows up in the
        // listApps() call above even though the backend's own /deploys
        // route would accept its id just fine. If the unmatched value is
        // shaped like an App.id (uuid, see schema.prisma), forward it as
        // app_id instead of erroring.
        params.set("app_id", options.app);
      } else {
        throw new Error(`App "${options.app}" not found (apps tagged "ignored" are not listed; pass the app id instead)`);
      }
    }

    if (options?.status) params.set("status", options.status);
    params.set("limit", String(options?.limit ?? 10));

    return this.request<{
      deploys: Array<{
        id: string;
        server: string;
        app: string;
        status: string;
        commitBefore: string | null;
        commitAfter: string | null;
        duration: number | null;
        triggeredBy: string | null;
        createdAt: string;
      }>;
      total: number;
    }>("GET", `/api/v1/deploys?${params.toString()}`);
  }

  async preflight(server: string, app: string) {
    return this.request<{ passed: boolean; checks: Array<{ name: string; passed: boolean; message: string }> }>("POST", "/api/v1/preflight", { server, app });
  }

  async rollback(server: string, app: string) {
    return this.request<{ deploy: { id: string; status: string; server: string; app: string; triggeredBy: string } }>("POST", "/api/v1/rollback", {
      server, app,
    });
  }

  async pollDeploy(deployId: string, intervalMs = 5000, timeoutMs = 300000): Promise<{ deploy: DeployInfo }> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = await this.getDeployStatus(deployId);
      if (result.deploy.status !== "running") return result;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Deploy ${deployId} timed out after ${timeoutMs / 1000}s`);
  }
}
