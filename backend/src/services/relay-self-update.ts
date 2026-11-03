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
  timeoutMs?: number;
}

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

    // A record from an earlier update must not decide this one: when both
    // sides know the revision the relay ran before the trigger, or the
    // revision the update aims at, they have to agree.
    const recPrev = normalizeRevision(state.previousRevision);
    if (recPrev && opts.previousRevision && recPrev !== opts.previousRevision) {
      return { kind: "none" };
    }
    const recTarget = normalizeRevision(state.targetRevision);
    if (recTarget && opts.targetRevision && recTarget !== opts.targetRevision) {
      return { kind: "none" };
    }

    const error = str(state.error);
    switch (state.status) {
      case "succeeded":
        return {
          kind: "succeeded",
          revision: normalizeRevision(body?.revision) ?? recTarget,
        };
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
