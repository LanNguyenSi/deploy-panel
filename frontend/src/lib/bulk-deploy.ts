import { normalizeDeploySteps } from "@/components/DeploySteps";

/** One failed step of a finished deploy: for a blocked deploy, one failed preflight check. */
export interface BulkFailure {
  check: string;
  message: string;
}

/** One app of a bulk deploy, updated as its deploy settles. */
export interface BulkEntry {
  app: string;
  deployId: string;
  status: string;
  failures: BulkFailure[];
}

export interface BulkResult {
  entries: BulkEntry[];
  /** Status polls done so far; polling stops at BULK_MAX_POLLS. */
  polls: number;
}

/** First poll fires at once, then every BULK_POLL_MS; about two minutes in total. */
export const BULK_POLL_MS = 3000;
export const BULK_MAX_POLLS = 40;

export function isSettled(entry: BulkEntry): boolean {
  return entry.status !== "running";
}

/** The failed steps (non-success, non-skipped) of a stored deploy log, in order. */
export function failuresFromLog(log: string | null): BulkFailure[] {
  if (!log) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(log);
  } catch {
    return [];
  }
  return normalizeDeploySteps(parsed)
    .filter((s) => s.status !== "success" && s.status !== "skipped")
    .map((s) => ({ check: s.name, message: s.message ?? s.output ?? "" }));
}

/** Entries of the 202 response: an app whose setup failed is already settled with its error. */
export function initialBulkEntries(
  deploys: Array<{ app: string; deployId: string; status: string; error?: string }>,
): BulkEntry[] {
  return deploys.map((d) => ({
    app: d.app,
    deployId: d.deployId,
    status: d.status,
    failures: d.status === "running" ? [] : [{ check: "deploy", message: d.error ?? "could not start" }],
  }));
}

/** One line per app for the result summary: "app: check (message); check2 (message2)". */
export function describeFailures(failures: BulkFailure[]): string {
  return failures.map((f) => (f.message ? `${f.check} (${f.message})` : f.check)).join("; ");
}
