import type { Config } from "./config.js";

export class DeployPanelClient {
  readonly apiUrl: string;
  readonly apiKey: string;

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
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error((err as any).message ?? `HTTP ${res.status}`);
    }

    return res.json() as Promise<T>;
  }

  async listServers() {
    return this.request<{ servers: Array<{ id: string; name: string; host: string; status: string; appCount: number }> }>("GET", "/api/v1/servers");
  }

  async listApps(serverId?: string) {
    const qs = serverId ? `?server_id=${serverId}` : "";
    return this.request<{ apps: Array<{ id: string; name: string; status: string; tag: string | null; server: { id: string; name: string } }> }>("GET", `/api/v1/apps${qs}`);
  }

  async deploy(server: string, app: string, options?: { force?: boolean; ref?: string }) {
    return this.request<{ deploy: { id: string; status: string; server: string; app: string; triggeredBy: string } }>("POST", "/api/v1/deploy", {
      server, app, force: options?.force, ref: options?.ref,
    });
  }

  async getDeployStatus(deployId: string) {
    return this.request<{ deploy: { id: string; status: string; server: string; app: string; commitBefore?: string; commitAfter?: string; duration?: number; steps: unknown[]; triggeredBy?: string; createdAt: string } }>("GET", `/api/v1/deploy/${deployId}`);
  }

  async preflight(server: string, app: string) {
    return this.request<{ passed: boolean; checks: Array<{ name: string; passed: boolean; message: string }> }>("POST", "/api/v1/preflight", { server, app });
  }

  async pollDeploy(deployId: string, intervalMs = 5000, timeoutMs = 300000): Promise<{ deploy: any }> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = await this.getDeployStatus(deployId);
      if (result.deploy.status !== "running") return result;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Deploy ${deployId} timed out after ${timeoutMs / 1000}s`);
  }
}
