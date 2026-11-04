/**
 * Read the relay's own record of a self-update (`GET /api/self-update`) and
 * map it to an outcome the panel can report.
 *
 * Why: the relay pulls the target image before it answers 202, so a slow
 * pull can outlast the panel's trigger timeout, and compose can take longer
 * than the panel's `/health` poll window. In both cases the panel cannot tell
 * "failed" from "still running". The relay can: its state record says
 * `in_progress`, `succeeded`, `unverified`, `failed` (with the helper's exit
 * code and log tail in `error`) or `refused`.
 *
 * Source precedence (enforced by the caller): a `/health` revision that
 * matches the target wins and this record is never read. The record is
 * only consulted when `/health` did not settle the question, and then it
 * decides.
 *
 * The read is best effort and never throws. A relay without the endpoint
 * (404/405, older image), a failing read, an unparseable body, no record, or
 * a record that belongs to an earlier update all map to `none`, so the
 * caller keeps its own result.
 */

import { normalizeRevision } from "../lib/ghcr.js";

export type RelayRecordOutcome =
  | { kind: "none" }
  | { kind: "succeeded"; revision: string | null }
  | { kind: "failed"; relayStatus: "failed" | "refused"; error: string | null }
  | {
      kind: "pending";
      relayStatus: "in_progress" | "unverified";
      error: string | null;
    };

export interface ReadRecordOpts {
  server: { relayUrl?: string | null; relayToken?: string | null };
  /** Revision the relay reported before the trigger, if known. */
  previousRevision: string | null;
  /** Revision the panel expects after the update, if known. */
  targetRevision: string | null;
  /**
   * "window": the poll window ended after a 202, so the relay wrote this
   * attempt's record before answering. "timeout": the trigger timed out
   * during the relay's image pull, BEFORE it writes the new record, so any
   * record present then is most likely the previous attempt's; only an
   * in_progress record that provably belongs to this attempt is decisive
   * (a succeeded or failed one never is: it cannot be told apart from the
   * earlier attempt's).
   */
  mode: "window" | "timeout";
  /** Epoch ms the trigger was sent; a record requested before it (minus skew) is not ours. */
  notBefore: number;
  timeoutMs?: number;
}

/** Tolerated clock difference between panel and relay host. */
const CLOCK_SKEW_MS = 120_000;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

export async function readRelaySelfUpdateOutcome(
  opts: ReadRecordOpts,
): Promise<RelayRecordOutcome> {
  const { server } = opts;
  if (!server.relayUrl) return { kind: "none" };
  try {
    const headers: Record<string, string> = {};
    if (server.relayToken) headers["Authorization"] = `Bearer ${server.relayToken}`;
    const res = await fetch(`${server.relayUrl}/api/self-update`, {
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    if (!res.ok) return { kind: "none" };
    const body = (await res.json()) as {
      revision?: unknown;
      state?: Record<string, unknown> | null;
    } | null;
    const state = body?.state;
    if (!state || typeof state !== "object") return { kind: "none" };

    // The record has to provably belong to this attempt. It must have been
    // requested after the trigger was sent (allowing for clock skew), must
    // not contradict the revisions the panel knows, and must match at least
    // one of them (previous revision the relay ran, or the target). With
    // nothing to anchor on the record is not decisive.
    const requestedAt = Date.parse(String(state.requestedAt));
    if (!Number.isFinite(requestedAt) || requestedAt < opts.notBefore - CLOCK_SKEW_MS) {
      return { kind: "none" };
    }
    const recPrev = normalizeRevision(state.previousRevision);
    const recTarget = normalizeRevision(state.targetRevision);
    if (recPrev && opts.previousRevision && recPrev !== opts.previousRevision) {
      return { kind: "none" };
    }
    if (recTarget && opts.targetRevision && recTarget !== opts.targetRevision) {
      return { kind: "none" };
    }
    const prevMatches = !!recPrev && !!opts.previousRevision;
    const targetMatches = !!recTarget && !!opts.targetRevision;
    if (opts.mode === "timeout") {
      // Only the previous-revision anchor is available here (the target is
      // not known before the relay's pull finishes), and only a running
      // update is reported.
      if (state.status !== "in_progress" || !prevMatches) return { kind: "none" };
    } else if (!prevMatches && !targetMatches) {
      return { kind: "none" };
    }

    const error = str(state.error);
    switch (state.status) {
      case "succeeded": {
        const live = normalizeRevision(body?.revision);
        // The relay's current revision and the update's target must agree.
        if (live && recTarget && live !== recTarget) return { kind: "none" };
        const revision = live ?? recTarget;
        if (!revision) return { kind: "none" };
        // Anchor the outcome to what the panel expects. A known target
        // decides: the resulting revision has to equal it. Without a known
        // target the revision has to differ from the previous one (an
        // update that ends where it started is no success). Defence in
        // depth: the relay itself never records such a success.
        if (opts.targetRevision) {
          if (revision !== opts.targetRevision) return { kind: "none" };
        } else if (opts.previousRevision && revision === opts.previousRevision) {
          return { kind: "none" };
        }
        return { kind: "succeeded", revision };
      }
      case "failed":
      case "refused":
        return { kind: "failed", relayStatus: state.status, error };
      case "in_progress":
      case "unverified":
        return { kind: "pending", relayStatus: state.status, error };
      default:
        return { kind: "none" };
    }
  } catch {
    return { kind: "none" };
  }
}
