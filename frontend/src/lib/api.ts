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
