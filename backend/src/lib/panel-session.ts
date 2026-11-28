/**
 * Admin sessions for the browser login (`panel_session` cookie).
 *
 * POST /api/auth/login trades the PANEL_TOKEN for a random session token; the
 * cookie carries that token and never the PANEL_TOKEN, so a leaked or logged
 * cookie is not a Bearer credential and logout can revoke it. The PANEL_TOKEN
 * itself stays a bearer credential (`Authorization: Bearer`) and the login
 * secret.
 *
 * The store is an in-memory map from sha256(token) to its expiry, like the
 * login rate limiter next to it: it lives in one process, so a restart (every
 * deploy and every PANEL_TOKEN rotation, since the env is read at start)
 * signs every admin out. The map is bounded: when it is full, expired
 * sessions go first, then the oldest. Only the hash is kept, so the map never
 * holds a usable token.
 *
 * Distinct from `user_session` (lib/session.ts), the database-backed session
 * of a native GitHub OAuth login, which is bound to a User row.
 */
import { createHash, randomBytes } from "node:crypto";

/** 24 hours, the Max-Age of the cookie. */
export const PANEL_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Upper bound on live sessions held at once. */
export const PANEL_SESSION_MAX_ENTRIES = 1000;

export interface PanelSessionStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** Clock in epoch milliseconds; injectable for tests. */
  now?: () => number;
}

export interface PanelSessionStore {
  /** Issue a new session and return its raw token (shown to the client once). */
  create(): string;
  /** True only for a token this store issued that is neither revoked nor expired. */
  validate(rawToken: string): boolean;
  /** Forget a session. Unknown or already revoked tokens are a no-op. */
  revoke(rawToken: string): void;
  size(): number;
  clear(): void;
}

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function createPanelSessionStore(options: PanelSessionStoreOptions = {}): PanelSessionStore {
  const ttlMs = options.ttlMs ?? PANEL_SESSION_TTL_MS;
  const maxEntries = options.maxEntries ?? PANEL_SESSION_MAX_ENTRIES;
  const now = options.now ?? (() => Date.now());
  // Map iteration order is insertion order and every entry gets the same TTL,
  // so the first entry is always the oldest.
  const sessions = new Map<string, number>();

  function pruneExpired(at: number): void {
    for (const [hash, expiresAt] of sessions) {
      if (expiresAt <= at) sessions.delete(hash);
    }
  }

  return {
    create() {
      const at = now();
      pruneExpired(at);
      while (sessions.size >= maxEntries) {
        const oldest = sessions.keys().next();
        if (oldest.done) break;
        sessions.delete(oldest.value);
      }
      const token = randomBytes(32).toString("hex");
      sessions.set(hashToken(token), at + ttlMs);
      return token;
    },
    validate(rawToken) {
      if (!rawToken) return false;
      const hash = hashToken(rawToken);
      const expiresAt = sessions.get(hash);
      if (expiresAt === undefined) return false;
      if (expiresAt <= now()) {
        sessions.delete(hash);
        return false;
      }
      return true;
    },
    revoke(rawToken) {
      if (!rawToken) return;
      sessions.delete(hashToken(rawToken));
    },
    size: () => sessions.size,
    clear: () => sessions.clear(),
  };
}

const panelSessions = createPanelSessionStore();

export const createPanelSession = (): string => panelSessions.create();
export const validatePanelSession = (rawToken: string): boolean => panelSessions.validate(rawToken);
export const revokePanelSession = (rawToken: string): void => panelSessions.revoke(rawToken);

/** Test hooks, like login-rate-limit.ts. */
export const _resetPanelSessions = (): void => panelSessions.clear();
export const _panelSessionCount = (): number => panelSessions.size();

/**
 * Set-Cookie value for a panel session: the token is hex, so it needs no
 * encoding. Strict SameSite, Secure in production, Max-Age matches the TTL.
 */
export function buildPanelSessionCookie(token: string, secure: boolean): string {
  return `panel_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(PANEL_SESSION_TTL_MS / 1000)}${secure ? "; Secure" : ""}`;
}
