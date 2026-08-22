import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for Nachzuegler (b), HIGH-wave reviews 2026-08-21: before
 * this, no automated check asserted that the documented dev/compose recipes
 * actually deliver APP_SECRETS_KEY to the backend process — see
 * docs/configuration.md ("App secrets") and docker-compose.yml's comment on
 * the APP_SECRETS_KEY line for why an unset key must fail closed rather than
 * silently falling back.
 *
 * Two independent mechanisms are covered, matching what actually exists on
 * `main` today (the fragile/aspirational `-include .env` rewrite lives on
 * the still-unmerged fix/root-env-loading branch and is explicitly out of
 * scope here):
 *   1. `docker-compose.yml` — Compose auto-loads a repo-root `.env` file by
 *      itself (no code needed); we assert APP_SECRETS_KEY has no `:-`
 *      fallback there, so an unset var fails the container's startup
 *      validation instead of silently using a shared, world-readable key.
 *   2. `make dev-backend` (host dev, no Docker) — nothing in the Makefile or
 *      backend/package.json loads a `.env` file; a developer's shell is
 *      expected to already carry APP_SECRETS_KEY (e.g. via direnv, or a
 *      manual export before `.env` support lands). What CAN regress is the
 *      make -> `npm run dev` -> `tsx watch` process chain silently dropping
 *      an already-exported var (e.g. an accidental `env -i`, or an npm
 *      config that strips env). We guard THAT by actually running the real
 *      `make dev-backend` command with an injected APP_SECRETS_KEY and
 *      confirming the backend process itself received it, two independent
 *      ways:
 *        a. Portable: server.ts logs a literal `app-secrets:
 *           configured|absent` line derived from `config.APP_SECRETS_KEY`
 *           (never the value itself). This is per-variable and runs on
 *           every platform/CI.
 *        b. Linux only: read the actual backend (tsx/server.ts) process's
 *           /proc/<pid>/environ directly, with zero cooperation from
 *           application code. Kept as an independent confirmation of (a)
 *           that doesn't rely on the backend's own config code being
 *           correct; skipped where /proc doesn't exist (e.g. macOS dev
 *           boxes) since the portable check above already runs there.
 *
 *      Reaching the "listening on port" boot line at all additionally
 *      proves SESSION_SECRET (required, no fallback) was delivered through
 *      the same chain. That is evidence the chain propagates *some*
 *      variables — it is an assumption, not a proof, that propagation is
 *      uniform across variable names (i.e. that make/npm/sh/tsx don't
 *      special-case one env var over another); (a) and (b) above are what
 *      actually verify APP_SECRETS_KEY specifically, which is why both
 *      exist rather than relying on the boot line alone.
 */

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Syntactically valid but unroutable Postgres URL, injected into every
// spawned child below. PrismaClient (backend/src/lib/prisma.ts) only
// validates the URL's shape at construction and doesn't connect until a
// query runs, so this alone doesn't affect whether "listening on port" or
// the app-secrets line appear (both log before any query). It exists so
// the child doesn't die on an *unrelated* failure a few seconds later:
// backend/src/lib/scheduler.ts's checkScheduled() fires 5s after boot via
// an unguarded `setTimeout` (no try/catch, unlike the awaited
// recoverStuckDeploys() call, which server.ts does wrap) and would reject
// with "Environment variable not found: DATABASE_URL" if none were set at
// all, crashing the child on an unhandled rejection. Taking both snapshots
// immediately after the boot line (well under 5s) already avoids that race
// on its own; this is defense in depth so the child's stderr stays quiet
// enough to read on a slow CI runner.
const DUMMY_DATABASE_URL = "postgresql://guard-probe:guard-probe@127.0.0.1:1/guard_probe_db";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : null;
      srv.close((err) => {
        if (err) return reject(err);
        if (port === null) return reject(new Error("could not determine a free port"));
        // TOCTOU: the port is free at this instant but nothing reserves it
        // between this close() and the child's bind a moment later. Accepted
        // for a locally-run test guard; a collision would surface as a
        // flaky EADDRINUSE rather than a false pass/fail either way.
        resolve(port);
      });
    });
    srv.on("error", reject);
  });
}

function waitForOutput(stream: NodeJS.ReadableStream, pattern: RegExp, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      stream.off("data", onData);
      reject(new Error(`timed out after ${timeoutMs}ms waiting for ${pattern}. Output so far:\n${buf}`));
    }, timeoutMs);
    function onData(chunk: Buffer) {
      buf += chunk.toString("utf8");
      if (pattern.test(buf)) {
        clearTimeout(timer);
        stream.off("data", onData);
        resolve();
      }
    }
    stream.on("data", onData);
  });
}

function buildEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", DATABASE_URL: DUMMY_DATABASE_URL };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function spawnDevBackend(port: number, overrides: Record<string, string | undefined>) {
  const child = spawn("make", ["dev-backend"], {
    cwd: repoRoot,
    env: buildEnv({ PORT: String(port), ...overrides }),
    detached: true,
  }) as ChildProcessWithoutNullStreams;
  let out = "";
  child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
  child.stderr.on("data", (c: Buffer) => (out += c.toString("utf8")));
  return { child, output: () => out };
}

function killTree(child: ChildProcessWithoutNullStreams | undefined) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // already dead
  }
}

/**
 * Scan /proc (Linux only) for a process owned by the current user whose
 * environment contains `NAME=value` AND whose cmdline matches
 * `cmdlineMustMatch`. The cmdline filter (and the `excludePid` exclusion)
 * matter: `make dev-backend`'s own process inherits its env from THIS
 * test's `spawn()` call by construction, so it always carries the injected
 * var regardless of whether the make -> npm -> tsx chain actually passes
 * it on to the real backend process — matching on env alone against every
 * process on the box would make the check unable to fail. Requiring the
 * matched pid's cmdline to reference `tsx` or `server.ts` restricts the
 * match to the actual backend (or its `tsx` launcher), which is the only
 * process whose environment this guard cares about.
 */
function findProcessWithEnvVar(
  name: string,
  value: string,
  opts: { excludePid?: number; cmdlineMustMatch: RegExp },
): number | null {
  const needle = `${name}=${value}`;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === opts.excludePid) continue;
    try {
      const environ = readFileSync(`/proc/${entry}/environ`, "latin1");
      if (!environ.split("\0").includes(needle)) continue;
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "latin1").replace(/\0/g, " ").trim();
      if (opts.cmdlineMustMatch.test(cmdline)) return pid;
    } catch {
      // Process exited between readdir and read, or not readable by us — skip.
    }
  }
  return null;
}

describe("docker-compose.yml — APP_SECRETS_KEY fails closed", () => {
  it("has no fallback default for APP_SECRETS_KEY, unlike SESSION_SECRET", () => {
    const compose = readFileSync(path.join(repoRoot, "docker-compose.yml"), "utf8");

    // Line-based extraction rather than a full YAML parse: no YAML library
    // is a project dependency, and both keys appear exactly once in this
    // file (both under the `backend` service's `environment:` block).
    const secretsKeyLine = compose.match(/^\s*APP_SECRETS_KEY:\s*(.+)$/m)?.[1]?.trim();
    expect(secretsKeyLine, "APP_SECRETS_KEY line not found in docker-compose.yml").toBeDefined();
    expect(secretsKeyLine).toBe("${APP_SECRETS_KEY}");
    // A `:-default` fallback here would make every fresh clone encrypt app
    // secrets at rest with a key anyone can read in this repo's history,
    // silently (the stack would still boot). Contrast below.
    expect(secretsKeyLine).not.toMatch(/:-/);

    const sessionSecretLine = compose.match(/^\s*SESSION_SECRET:\s*(.+)$/m)?.[1]?.trim();
    expect(sessionSecretLine, "SESSION_SECRET line not found in docker-compose.yml").toBeDefined();
    expect(sessionSecretLine).toMatch(/:-/);
  });
});

describe("make dev-backend — APP_SECRETS_KEY reaches the backend child process", () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  let getOutput: () => string = () => "";
  let probeKey: string;

  beforeAll(async () => {
    probeKey = `guard-probe-app-secrets-key-${Date.now()}`;
    const port = await getFreePort();

    const spawned = spawnDevBackend(port, {
      SESSION_SECRET: "guard-probe-session-secret-0123456789",
      APP_SECRETS_KEY: probeKey,
    });
    child = spawned.child;
    getOutput = spawned.output;

    try {
      // config/index.ts validates SESSION_SECRET (required, no fallback)
      // at import time, before server.ts logs "listening on port" —
      // reaching that log line proves the full make -> npm run -> tsx
      // watch chain delivered THIS test's injected env into the backend
      // process at all. See the module docblock for why that alone isn't
      // treated as proof APP_SECRETS_KEY specifically got through.
      await waitForOutput(child.stdout, /listening on port/, 25_000);
      // Take both the portable and the /proc snapshot right after the boot
      // line, before the unguarded 5s scheduler tick (see
      // DUMMY_DATABASE_URL above) could crash the child.
      await waitForOutput(child.stdout, /app-secrets: (configured|absent)/, 10_000);
    } catch (err) {
      killTree(child);
      throw new Error(`${(err as Error).message}\n\n--- child output ---\n${getOutput()}`);
    }
  }, 30_000);

  afterAll(() => {
    killTree(child);
  });

  it("reports APP_SECRETS_KEY as configured via the backend's own portable readback (runs on every platform)", () => {
    expect(getOutput(), `child output:\n${getOutput()}`).toMatch(/app-secrets: configured/);
    expect(getOutput()).not.toMatch(/app-secrets: absent/);
  });

  describe.skipIf(process.platform !== "linux")("/proc — literal per-variable confirmation (Linux, e.g. CI's ubuntu-latest runners)", () => {
    it("finds APP_SECRETS_KEY in the environ of the actual tsx/server.ts backend process, not an ancestor make/npm/sh process", () => {
      const pid = findProcessWithEnvVar("APP_SECRETS_KEY", probeKey, {
        excludePid: child?.pid,
        cmdlineMustMatch: /(tsx|server\.ts)/,
      });
      expect(
        pid,
        "no backend (tsx/server.ts) descendant of `make dev-backend` had APP_SECRETS_KEY in its environment",
      ).not.toBeNull();
    });
  });
});
