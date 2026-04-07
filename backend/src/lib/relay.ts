import { prisma } from "./prisma.js";

export interface RelayRequestOptions {
  serverId: string;
  path: string;
  method?: string;
  body?: unknown;
}

export async function relayRequest<T>(options: RelayRequestOptions): Promise<T> {
  const { serverId, path, method = "GET", body } = options;

  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) throw new RelayError("Server not found", 404);
  if (!server.relayUrl) throw new RelayError("No relay URL configured for this server", 400);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (server.relayToken) {
    headers["Authorization"] = `Bearer ${server.relayToken}`;
  }

  const response = await fetch(`${server.relayUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(300_000), // 5 min — deploys can take a while
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new RelayError(`Relay error (${response.status}): ${text}`, response.status);
  }

  return response.json() as Promise<T>;
}

export class RelayError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "RelayError";
    this.status = status;
  }
}
