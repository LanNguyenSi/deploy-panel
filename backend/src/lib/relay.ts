import { prisma } from "./prisma.js";
import { relayFetch } from "./relay-fetch.js";

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
  if (!server) throw RelayError.local("Server not found", 404);
  if (!server.relayUrl) throw RelayError.local("No relay URL configured for this server", 400);

  const callerHeaders = Object.fromEntries(
    Object.entries(extraHeaders ?? {}).filter(([key]) => !["content-type", "authorization"].includes(key.toLowerCase())),
  );
  const headers: Record<string, string> = { ...callerHeaders, "Content-Type": "application/json" };
  if (server.relayToken) {
    headers["Authorization"] = `Bearer ${server.relayToken}`;
  }

  const response = await relayFetch(`${server.relayUrl}${path}`, {
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
  /**
   * True when the panel raised this itself before any relay request (server
   * row missing, no relay URL configured). `status` is then the panel's own
   * HTTP code, not an answer from a relay.
   */
  local = false;
  constructor(message: string, status: number, body?: string) {
    super(message);
    this.name = "RelayError";
    this.status = status;
    this.body = body;
  }

  static local(message: string, status: number): RelayError {
    const err = new RelayError(message, status);
    err.local = true;
    return err;
  }
}

/** Cap of the message derived from the relay's env-unreadable answer. */
const ENV_UNREADABLE_MESSAGE_MAX_CHARS = 300;

/**
 * Recognises the relay's "I cannot read this app's .env file" answer: an
 * HTTP 409 actually returned by a relay for the app-env read (agent-relay
 * sends it when the `.env` is a symlink or otherwise not a regular file).
 * Errors the panel raised itself (`local`) are never that answer, even if
 * they happen to carry a 409 code.
 *
 * Returns a bounded single-line message naming the unreadable env file and
 * carrying the relay's own text (from the response body when present, which
 * is preferred, else the raw body, else the error message), or null for
 * anything else. Callers treat a non-null answer as "cannot provision or
 * check the env, block the deploy / fail the check", never as a lost
 * connection or as missing keys.
 */
export function envUnreadableRelayMessage(err: unknown): string | null {
  if (!(err instanceof RelayError) || err.status !== 409 || err.local) return null;
  const detail = relayMessageText(err.body) ?? relayMessageText(err.message) ?? "no message from the relay";
  return `Env file unreadable on the relay: ${detail.slice(0, ENV_UNREADABLE_MESSAGE_MAX_CHARS)}`;
}

/**
 * Message text of a relay error response: a JSON body's `message` field,
 * else its `error` field, else the raw text. Same parse-the-body-first order
 * as rollback-app-status.ts; returns null for blank input.
 */
function relayMessageText(raw: string | undefined): string | null {
  const text = raw?.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
    for (const field of [parsed?.message, parsed?.error]) {
      if (typeof field === "string" && field.trim()) return field.trim();
    }
  } catch {
    // Not JSON: the raw text itself is the message.
  }
  return text;
}
