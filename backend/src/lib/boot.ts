import { backfillRelayTokenCiphertext, recoverStuckDeploys } from "./startup.js";
import { startScheduler } from "./scheduler.js";

/**
 * The boot sequence that runs once the backend is listening, behind one
 * seam so its order, its awaits and its error handling are testable
 * (backend/tests/startup-tasks.test.ts) without importing server.ts (which
 * runs `serve()` as an ES module side effect and is excluded from coverage
 * for that reason). server.ts keeps the `listening on port` and
 * `app-secrets:` log lines (they describe the server itself, and
 * env-loading-guard.test.ts reads the latter from a real boot) and calls
 * `runStartupTasks()` from the `serve()` callback. Behaviour is exactly
 * what server.ts did inline before this seam existed: the same three tasks,
 * the same order, each awaited, each failure logged with the same message
 * while startup continues.
 */
export interface StartupDeps {
  backfillRelayTokenCiphertext: () => Promise<unknown>;
  recoverStuckDeploys: () => Promise<unknown>;
  startScheduler: () => unknown;
  /** Sink for the two `[startup] Failed to ...:` log lines. */
  error: (message: string, err: unknown) => void;
}

export const defaultStartupDeps: StartupDeps = {
  backfillRelayTokenCiphertext,
  recoverStuckDeploys,
  startScheduler,
  error: (message, err) => console.error(message, err),
};

/**
 * Runs the three boot tasks in order, each awaited: the relay-token
 * backfill, the stuck-deploy recovery sweep, then startScheduler.
 *
 * The backfill first: it runs once the port is listening, as server.ts
 * always ran it, so a request arriving mid-pass reads a still-plaintext
 * row through the legacy path in lib/relay-token.ts. The sweep awaited before
 * startScheduler: the sweep's own boot pass may await the post-deploy
 * health gate for minutes (see deploy-outcome-trust-chain.md), and the
 * first scheduler tick must not start before it settles.
 *
 * A rejection of either awaited task is logged through `error` with the
 * message server.ts has always logged, and startup continues: reads still
 * serve legacy plaintext relay-token rows (lib/relay-token.ts), and a
 * missed sweep runs again from the scheduler's periodic tick, so a failed
 * task delays protection, it does not break the panel.
 */
export async function runStartupTasks(deps: StartupDeps = defaultStartupDeps): Promise<void> {
  // Seal every stored relay token that is still plaintext (see
  // backfillRelayTokenCiphertext in lib/startup.ts). A throw (production
  // without APP_SECRETS_KEY) is logged here and startup continues, exactly
  // as for the app-secret paths.
  try {
    await deps.backfillRelayTokenCiphertext();
  } catch (err) {
    deps.error("[startup] Failed to backfill relay-token ciphertext:", err);
  }

  // Run startup recovery after the backfill settled and the server is
  // listening, and before the scheduler starts.
  try {
    await deps.recoverStuckDeploys();
  } catch (err) {
    deps.error("[startup] Failed to recover stuck deploys:", err);
  }

  deps.startScheduler();
}
