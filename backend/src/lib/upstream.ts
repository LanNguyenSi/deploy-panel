import { relayRequest } from "./relay.js";

/**
 * Upstream staleness info the agent-relay reports per app (GET /api/apps):
 * the deployed commit next to the head of the branch a deploy would pull.
 * The panel passes it through to the server page after validating and
 * sanitising every field, because the relay is a separate process on a
 * remote host and its output ends up in the UI.
 *
 * "behind" means the deployed commit differs from the remote branch head (a
 * fetch-free relay cannot tell ahead from behind). Unknown is never promoted
 * to current: any doubt maps to "unknown" with a reason.
 */
export type UpstreamState = "current" | "behind" | "unknown";

export interface Upstream {
  branch: string | null;
  deployedCommit: string | null;
  remoteHead: string | null;
  checkedAt: string | null;
  state: UpstreamState;
  /** Present only when state is "unknown". */
  reason?: string;
}

export const REASON_NOT_REPORTED = "relay does not report upstream";
export const REASON_RELAY_UNREACHABLE = "relay unreachable";
/** The relay answered but its body carries no app list at all. */
export const REASON_LISTING_UNAVAILABLE = "relay listing unavailable";
/** The relay listed its apps and this one is not among them. */
export const REASON_NOT_LISTED = "relay does not list this app";
/** The relay listed this app as `configured: false` (no checkout or config on the relay). */
export const REASON_NOT_CONFIGURED = "app not configured on relay";
const REASON_MALFORMED = "relay reported malformed upstream";
const REASON_BAD_STATE = "relay reported an unrecognised upstream state";
const REASON_INCONSISTENT = "relay upstream state contradicts its commits";

const SHA_RE = /^[0-9a-f]{40}$/i;
const BRANCH_RE = /^[A-Za-z0-9._/@+-]{1,255}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const MAX_REASON = 200;
// Control characters (incl. newlines) never belong in a one-line reason.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

function unknown(reason: string, partial: Partial<Upstream> = {}): Upstream {
  return {
    branch: partial.branch ?? null,
    deployedCommit: partial.deployedCommit ?? null,
    remoteHead: partial.remoteHead ?? null,
    checkedAt: partial.checkedAt ?? null,
    state: "unknown",
    reason,
  };
}

function sanitizeSha(v: unknown): string | null {
  return typeof v === "string" && SHA_RE.test(v) ? v.toLowerCase() : null;
}

function sanitizeBranch(v: unknown): string | null {
  return typeof v === "string" && BRANCH_RE.test(v) ? v : null;
}

function sanitizeCheckedAt(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 64 || !ISO_RE.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function sanitizeReason(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const cleaned = v.replace(CONTROL_RE, " ").trim().slice(0, MAX_REASON);
  return cleaned.length > 0 ? cleaned : null;
}

/** Validate one relay `upstream` value; a missing value is "unknown", never "current". */
export function sanitizeUpstream(raw: unknown): Upstream {
  if (raw === undefined || raw === null) return unknown(REASON_NOT_REPORTED);
  if (typeof raw !== "object" || Array.isArray(raw)) return unknown(REASON_MALFORMED);

  const o = raw as Record<string, unknown>;
  const fields = {
    branch: sanitizeBranch(o.branch),
    deployedCommit: sanitizeSha(o.deployedCommit),
    remoteHead: sanitizeSha(o.remoteHead),
    checkedAt: sanitizeCheckedAt(o.checkedAt),
  };

  if (o.state === "unknown") {
    return unknown(sanitizeReason(o.reason) ?? "relay gave no reason", fields);
  }
  if (o.state !== "current" && o.state !== "behind") {
    return unknown(REASON_BAD_STATE, fields);
  }

  // current/behind are only trustworthy with both commits in hand; the
  // verdict must also agree with them, otherwise treat it as doubt.
  const { deployedCommit, remoteHead } = fields;
  if (!deployedCommit || !remoteHead) return unknown(REASON_INCONSISTENT, fields);
  const same = deployedCommit === remoteHead;
  if ((o.state === "current") !== same) return unknown(REASON_INCONSISTENT, fields);

  return { ...fields, state: o.state };
}

/** One entry of the relay app listing, keyed by app name. */
export interface RelayAppEntry {
  /** The relay's `configured` flag; `false` marks an app it knows but cannot report on. */
  configured: unknown;
  upstream: unknown;
}

/** One relay app listing: `listed` is false when the body had no `apps` array. */
export interface RelayUpstreamListing {
  listed: boolean;
  entries: Map<string, RelayAppEntry>;
}

/**
 * Best-effort: one relay GET /api/apps per server, mapped by app name. Never
 * throws; a relay that is down or too slow yields `null` so callers mark
 * every app unknown ("relay unreachable") and the page still renders.
 */
export async function fetchUpstreamByApp(serverId: string): Promise<RelayUpstreamListing | null> {
  try {
    const body = await relayRequest<{ apps?: unknown }>({
      serverId,
      path: "/api/apps",
      timeoutMs: 8_000,
    });
    const entries = new Map<string, RelayAppEntry>();
    const listed = Array.isArray(body?.apps);
    if (Array.isArray(body?.apps)) {
      for (const entry of body.apps) {
        if (entry && typeof entry === "object" && typeof (entry as any).name === "string") {
          entries.set((entry as any).name, {
            configured: (entry as any).configured,
            upstream: (entry as any).upstream,
          });
        }
      }
    }
    return { listed, entries };
  } catch {
    return null;
  }
}

/** The upstream value for one app given the (possibly failed) relay listing. */
export function upstreamForApp(listing: RelayUpstreamListing | null, appName: string): Upstream {
  if (listing === null) return unknown(REASON_RELAY_UNREACHABLE);
  if (!listing.listed) return unknown(REASON_LISTING_UNAVAILABLE);
  const entry = listing.entries.get(appName);
  if (!entry) return unknown(REASON_NOT_LISTED);
  if (entry.configured === false) return unknown(REASON_NOT_CONFIGURED);
  return sanitizeUpstream(entry.upstream);
}
