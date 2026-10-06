import { prisma } from "./prisma.js";

export interface RelayRequestOptions {
  serverId: string;
  path: string;
  method?: string;
  body?: unknown;
  /** Extra request headers (e.g. X-Deploy-Id); the content type and bearer token cannot be overridden. */
  headers?: Record<string, string>;
  /** Request timeout in ms; defaults to 5 minutes (deploys can take a while). */
  timeoutMs?: number;
}

export async function relayRequest<T>(options: RelayRequestOptions): Promise<T> {
  const { serverId, path, method = "GET", body, headers: extraHeaders, timeoutMs = 300_000 } = options;

  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) throw new RelayError("Server not found", 404);
  if (!server.relayUrl) throw new RelayError("No relay URL configured for this server", 400);

  const callerHeaders = Object.fromEntries(
    Object.entries(extraHeaders ?? {}).filter(([key]) => !["content-type", "authorization"].includes(key.toLowerCase())),
  );
  const headers: Record<string, string> = { ...callerHeaders, "Content-Type": "application/json" };
  if (server.relayToken) {
    headers["Authorization"] = `Bearer ${server.relayToken}`;
  }

  const response = await fetch(`${server.relayUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new RelayError(`Relay error (${response.status}): ${text}`, response.status, text);
  }

  return response.json() as Promise<T>;
}

export class RelayError extends Error {
  status: number;
  /** Raw response body text, when the error came from a relay HTTP response. */
  body?: string;
  constructor(message: string, status: number, body?: string) {
    super(message);
    this.name = "RelayError";
    this.status = status;
    this.body = body;
  }
}
