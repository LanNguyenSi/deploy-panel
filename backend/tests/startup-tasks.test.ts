// The boot sequence behind the runStartupTasks seam (backend/src/lib/boot.ts,
// called by server.ts from the serve() callback after the `listening on port`
// and `app-secrets:` log lines). These tests pin the wiring the process
// depends on at startup, against fakes:
//
// 1. The three tasks run in order (relay-token backfill, stuck-deploy
//    recovery, scheduler start), each awaited: the recovery starts only
//    after the backfill promise settles, and the scheduler only after the
//    recovery settles.
// 2. A backfill rejection is logged once with the message server.ts has
//    always logged, and recovery and the scheduler still run.
// 3. A recovery rejection is logged with its existing message and the
//    scheduler still starts.
// 4. Called without deps, runStartupTasks uses the real default wiring
//    (console.error sink).
//
// server.ts itself stays a two-log-line caller (the source-text guard in
// server-unhandled-rejection-guard.test.ts pins that it calls
// runStartupTasks from the serve() callback and no longer wires the tasks
// directly), so removing, reordering or un-awaiting a task fails here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  backfill: vi.fn(),
  recover: vi.fn(),
  startScheduler: vi.fn(),
}));

// boot.ts's default deps import startup.js (which constructs a PrismaClient)
// and scheduler.js (which pulls in the deploy stack). In the default-deps
// test below those imports must not reach a database, so both modules are
// mocked; every other test passes fakes explicitly and never touches them.
vi.mock("../src/lib/startup.js", () => ({
  backfillRelayTokenCiphertext: mocks.backfill,
  recoverStuckDeploys: mocks.recover,
}));
vi.mock("../src/lib/scheduler.js", () => ({
  startScheduler: mocks.startScheduler,
}));

import { runStartupTasks, type StartupDeps } from "../src/lib/boot.js";

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDeps(overrides: Partial<StartupDeps> = {}) {
  const calls: string[] = [];
  const logged: Array<[string, unknown]> = [];
  const deps: StartupDeps = {
    backfillRelayTokenCiphertext:
      overrides.backfillRelayTokenCiphertext ??
      (async () => {
        calls.push("backfill");
      }),
    recoverStuckDeploys:
      overrides.recoverStuckDeploys ??
      (async () => {
        calls.push("recover");
      }),
    startScheduler:
      overrides.startScheduler ??
      (() => {
        calls.push("scheduler");
      }),
    error: (message, err) => {
      logged.push([message, err]);
    },
  };
  return { deps, calls, logged };
}

// Let every already-settled promise run its continuations, without giving
// the pending fakes below a chance to settle.
async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  mocks.backfill.mockReset();
  mocks.recover.mockReset();
  mocks.startScheduler.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runStartupTasks", () => {
  it("runs backfill, then recovery, then the scheduler start, in that order", async () => {
    const { deps, calls } = makeDeps();
    await runStartupTasks(deps);
    expect(calls).toEqual(["backfill", "recover", "scheduler"]);
  });

  it("starts the recovery only after the backfill promise settles", async () => {
    const gate = deferred();
    const { deps, calls } = makeDeps({
      backfillRelayTokenCiphertext: async () => {
        calls.push("backfill:start");
        await gate.promise;
        calls.push("backfill:end");
      },
    });
    const run = runStartupTasks(deps);
    await flushMicrotasks();
    // While the backfill is still in flight nothing after it may have
    // started: dropping the await here is what this pins.
    expect(calls).toEqual(["backfill:start"]);
    gate.resolve(undefined);
    await run;
    expect(calls).toEqual(["backfill:start", "backfill:end", "recover", "scheduler"]);
  });

  it("starts the scheduler only after the recovery settles", async () => {
    const gate = deferred();
    const { deps, calls } = makeDeps({
      recoverStuckDeploys: async () => {
        calls.push("recover:start");
        await gate.promise;
        calls.push("recover:end");
      },
    });
    const run = runStartupTasks(deps);
    await flushMicrotasks();
    expect(calls).toEqual(["backfill", "recover:start"]);
    gate.resolve(undefined);
    await run;
    expect(calls).toEqual(["backfill", "recover:start", "recover:end", "scheduler"]);
  });

  it("logs a backfill rejection once with the existing message and still recovers and starts the scheduler", async () => {
    const boom = new Error("no APP_SECRETS_KEY");
    const { deps, calls, logged } = makeDeps({
      backfillRelayTokenCiphertext: async () => {
        calls.push("backfill");
        throw boom;
      },
    });
    await expect(runStartupTasks(deps)).resolves.toBeUndefined();
    expect(calls).toEqual(["backfill", "recover", "scheduler"]);
    expect(logged).toHaveLength(1);
    expect(logged[0][0]).toBe("[startup] Failed to backfill relay-token ciphertext:");
    expect(logged[0][1]).toBe(boom);
  });

  it("logs a recovery rejection with the existing message and still starts the scheduler", async () => {
    const boom = new Error("db down");
    const { deps, calls, logged } = makeDeps({
      recoverStuckDeploys: async () => {
        calls.push("recover");
        throw boom;
      },
    });
    await expect(runStartupTasks(deps)).resolves.toBeUndefined();
    expect(calls).toEqual(["backfill", "recover", "scheduler"]);
    expect(logged).toHaveLength(1);
    expect(logged[0][0]).toBe("[startup] Failed to recover stuck deploys:");
    expect(logged[0][1]).toBe(boom);
  });

  it("does not swallow a startScheduler throw, as the inline callback body it replaced did not", async () => {
    const boom = new Error("scheduler broke");
    const { deps, logged } = makeDeps({
      startScheduler: () => {
        throw boom;
      },
    });
    await expect(runStartupTasks(deps)).rejects.toBe(boom);
    expect(logged).toHaveLength(0);
  });

  it("without deps runs the default wiring: the real startup/scheduler functions, errors to console.error", async () => {
    const boom = new Error("default-path failure");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.backfill.mockRejectedValue(boom);
    mocks.recover.mockResolvedValue(undefined);
    await runStartupTasks();
    expect(mocks.backfill).toHaveBeenCalledTimes(1);
    expect(mocks.recover).toHaveBeenCalledTimes(1);
    expect(mocks.startScheduler).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]).toEqual(["[startup] Failed to backfill relay-token ciphertext:", boom]);
  });
});
