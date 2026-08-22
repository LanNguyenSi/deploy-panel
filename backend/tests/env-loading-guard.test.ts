import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for Nachzuegler (b), HIGH-wave reviews 2026-08-21: before
 * this, no automated check asserted that the documented dev/compose recipes
 * actually deliver APP_SECRETS_KEY to the backend process, see
 * docs/configuration.md ("App secrets") and docker-compose.yml's comment on
 * the APP_SECRETS_KEY line for why an unset key must fail closed rather than
 * silently falling back.
 *
 * Two independent mechanisms are covered, matching what actually exists on
 * `main` today (the fragile/aspirational `-include .env` rewrite lives on
 * the still-unmerged fix/root-env-loading branch and is explicitly out of
 * scope here):
 *   1. `docker-compose.yml`: Compose auto-loads a repo-root `.env` file by
 *      itself (no code needed); we assert APP_SECRETS_KEY has no `:-`
 *      fallback there, so an unset var fails the container's startup
 *      validation instead of silently using a shared, world-readable key.
 *   2. `make dev-backend` (host dev, no Docker): nothing in the Makefile or
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
 *      variables; it is an assumption, not a proof, that propagation is
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
// the app-secrets line appear (both log before any query, at ~0.4s
// measured locally). It does NOT stop the child from eventually dying:
// backend/src/lib/scheduler.ts's checkScheduled() fires 5s after boot via
// an unguarded `setTimeout` (no try/catch, unlike the awaited
// recoverStuckDeploys() call, which server.ts does wrap), and with this
// unroutable host it still crashes the child on an unhandled
// PrismaClientInitializationError ("Can't reach database server at
// 127.0.0.1:1"), measured locally at ~5.4s after boot, i.e. an unset
// DATABASE_URL would only change *which* error kills the child (an
// immediate "Environment variable not found: DATABASE_URL" instead), not
// whether it dies. What actually keeps this guard safe is that both
// snapshots are taken immediately after the boot line, well under 5s
// before either crash would fire; DUMMY_DATABASE_URL exists only so a
// slow CI runner's stderr near that boundary reads as a plain connection
// failure instead of an env-var one, in case the two ever get compared.
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

// Regression guard for the flake fixed in this round: two sequential
// waitForOutput calls, each attaching its own fresh listener with its own
// empty buffer, silently missed the second pattern whenever both lines
// arrived in one stdout chunk (the listener that would have seen it was
// only attached after the first call already resolved and detached).
// beforeAll below now issues a single waitForOutput call against a
// combined pattern instead; these two tests pin that behaviour directly
// against a fake stream, without spawning a real child process.
describe("waitForOutput: coalesced chunk", () => {
  it("resolves on a single combined pattern when both lines arrive in one chunk", async () => {
    const stream = new PassThrough();
    const promise = waitForOutput(stream, /listening on port[\s\S]*app-secrets: (configured|absent)/, 1_000);
    stream.write("listening on port 4000\napp-secrets: configured\n");
    await expect(promise).resolves.toBeUndefined();
  });

  it("documents the bug: two sequential waits on the same chunk would time out on the second one", async () => {
    const stream = new PassThrough();
    const first = waitForOutput(stream, /listening on port/, 1_000);
    stream.write("listening on port 4000\napp-secrets: configured\n");
    await first;

    // The chunk above already flew past this now-detached listener's
    // predecessor; a fresh waitForOutput call attaches a brand-new empty
    // buffer and never receives that chunk again, so it times out even
    // though the backend logged the line correctly.
    const second = waitForOutput(stream, /app-secrets: (configured|absent)/, 100);
    await expect(second).rejects.toThrow(/timed out after 100ms/);
  });
});

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
 * Read a pid's parent pid from /proc/<pid>/stat. The `comm` field (2nd,
 * parenthesised) can itself contain spaces or a `)`, so this locates the
 * LAST `)` on the line rather than splitting on whitespace naively: the
 * fields after it (state, ppid, ...) are then whitespace-delimited and
 * position-stable.
 */
function getParentPid(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
    const ppid = Number(afterComm.split(" ")[1]);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * Walk `pid`'s parent chain looking for `ancestorPid`, bounded to
 * `maxHops` in case a pid ever ends up its own ancestor (shouldn't happen
 * on Linux, but an unbounded loop on /proc data racing under us is worse
 * than a false negative here).
 */
function isDescendantOf(pid: number, ancestorPid: number, maxHops = 25): boolean {
  let current = pid;
  for (let i = 0; i < maxHops; i++) {
    const parent = getParentPid(current);
    if (parent === null || parent <= 1) return false;
    if (parent === ancestorPid) return true;
    current = parent;
  }
  return false;
}

/**
 * Read a pid's `comm` (the kernel's short executable name, e.g. "node" or
 * "sh") from /proc/<pid>/comm. Used to tell an actual node/tsx process
 * apart from a shell wrapper in the same process tree whose cmdline
 * happens to mention the same strings (see findProcessWithEnvVar below).
 */
function getComm(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/comm`, "latin1").trim();
  } catch {
    return null;
  }
}

/**
 * Scan /proc (Linux only) for a process owned by the current user whose
 * environment contains `NAME=value`, whose cmdline matches
 * `cmdlineMustMatch`, whose `comm` is `node` (not a shell), AND which is a
 * process-tree descendant of `ancestorPid`. All four matter: `make
 * dev-backend`'s own process inherits its env from THIS test's `spawn()`
 * call by construction, so it always carries the injected var regardless
 * of whether the make -> npm -> tsx chain actually passes it on to the
 * real backend process: matching on env alone against every process on
 * the box would make the check unable to fail. The cmdline filter alone
 * is not enough either: an intermediate `sh -c "tsx watch ..."` wrapper in
 * that chain has the full `tsx`/`server.ts` invocation embedded in ITS OWN
 * cmdline too (it's the argument to `-c`), so cmdline matching can land on
 * the shell wrapper instead of the actual backend process. Requiring `pid`
 * to be a descendant of `ancestorPid` does not close that gap by itself:
 * the `sh -c` wrapper is ALSO a descendant of `make dev-backend` (it sits
 * between npm and tsx in the same chain), so it still passes both the
 * cmdline and the descendant check. What actually excludes it is the
 * `comm` check: the wrapper's kernel-reported executable name is `sh` (or
 * whichever shell), never `node`, so requiring `comm === "node"` rejects
 * it while still matching the real tsx/server.ts process (tsx runs via a
 * `node` shebang, so its `comm` is `node`). The descendant check still
 * matters on its own: it rejects an unrelated process elsewhere on the box
 * that happens to share env value, cmdline substring, AND comm; cmdline
 * stays as an additional, human-readable filter on top of both.
 */
function findProcessWithEnvVar(
  name: string,
  value: string,
  opts: { ancestorPid?: number; cmdlineMustMatch: RegExp },
): number | null {
  const needle = `${name}=${value}`;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === opts.ancestorPid) continue;
    try {
      const environ = readFileSync(`/proc/${entry}/environ`, "latin1");
      if (!environ.split("\0").includes(needle)) continue;
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "latin1").replace(/\0/g, " ").trim();
      if (!opts.cmdlineMustMatch.test(cmdline)) continue;
      if (getComm(pid) !== "node") continue;
      if (opts.ancestorPid !== undefined && !isDescendantOf(pid, opts.ancestorPid)) continue;
      return pid;
    } catch {
      // Process exited between readdir and read, or not readable by us, skip.
    }
  }
  return null;
}

describe("docker-compose.yml: APP_SECRETS_KEY fails closed", () => {
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

describe("make dev-backend: APP_SECRETS_KEY reaches the backend child process", () => {
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
      // at import time, before server.ts logs "listening on port":
      // reaching that log line proves the full make -> npm run -> tsx
      // watch chain delivered THIS test's injected env into the backend
      // process at all. See the module docblock for why that alone isn't
      // treated as proof APP_SECRETS_KEY specifically got through.
      //
      // This used to be two sequential waitForOutput calls, one for
      // "listening on port" and a second for "app-secrets: ...". Each
      // call attaches its own fresh `data` listener with its own empty
      // `buf`, so when both lines arrive in a single stdout chunk (which
      // happens often enough to flake CI: observed in 2/14 full-suite
      // runs, 10/10 deterministic when the write was forced coalesced),
      // the FIRST call's listener consumes that chunk and resolves, is
      // removed, and the SECOND call's listener then starts empty-handed:
      // the chunk carrying "app-secrets: ..." already flew by and will
      // never be re-delivered, so the second wait timed out even though
      // the backend logged the line correctly. Waiting once on a single
      // combined pattern removes the gap: one listener sees every chunk
      // from the moment it's attached (before the child has had a chance
      // to write anything), so a coalesced write is matched exactly like
      // a split one. Take both the portable and the /proc snapshot right
      // after the boot line, before the unguarded 5s scheduler tick (see
      // DUMMY_DATABASE_URL above) could crash the child.
      await waitForOutput(child.stdout, /listening on port[\s\S]*app-secrets: (configured|absent)/, 25_000);
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

  describe.skipIf(process.platform !== "linux")("/proc: literal per-variable confirmation (Linux, e.g. CI's ubuntu-latest runners)", () => {
    it("finds APP_SECRETS_KEY in the environ of the actual tsx/server.ts backend process, not an ancestor make/npm/sh process", () => {
      const pid = findProcessWithEnvVar("APP_SECRETS_KEY", probeKey, {
        ancestorPid: child?.pid,
        cmdlineMustMatch: /(tsx|server\.ts)/,
      });
      expect(
        pid,
        "no backend (tsx/server.ts) process-tree descendant of `make dev-backend` had APP_SECRETS_KEY in its environment",
      ).not.toBeNull();
    });
  });
});
