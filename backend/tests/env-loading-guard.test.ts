import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
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
 *      confirming a descendant process still has it.
 */

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : null;
      srv.close((err) => {
        if (err) return reject(err);
        if (port === null) return reject(new Error("could not determine a free port"));
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

/**
 * Scan /proc (Linux only) for any process owned by the current user whose
 * environment contains `NAME=value`. This needs zero cooperation from
 * application code — it reads the OS-level environment of whatever
 * descendant of `make dev-backend` actually ends up running (make -> sh -c
 * "npm run dev" -> npm -> sh -c "tsx watch src/server.ts" -> node), without
 * having to walk that exact process tree by pid.
 */
function findProcessWithEnvVar(name: string, value: string): number | null {
  const needle = `${name}=${value}`;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const environ = readFileSync(`/proc/${entry}/environ`, "latin1");
      if (environ.split("\0").includes(needle)) return Number(entry);
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
  it(
    "boots the real `make dev-backend` chain with an injected APP_SECRETS_KEY and observes it in a descendant process's environment",
    async () => {
      const probeKey = `guard-probe-app-secrets-key-${Date.now()}`;
      const port = await getFreePort();

      const child = spawn("make", ["dev-backend"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          SESSION_SECRET: "guard-probe-session-secret-0123456789",
          APP_SECRETS_KEY: probeKey,
          PORT: String(port),
          NODE_ENV: "test",
        },
        detached: true,
      });

      let stdout = "";
      child.stdout?.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
      });
      child.stderr?.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
      });

      try {
        // config/index.ts validates SESSION_SECRET (required, no fallback)
        // at import time, before server.ts logs "listening on port" —
        // reaching that log line proves the full make -> npm run -> tsx
        // watch chain delivered THIS test's injected env into the backend
        // process at all (env propagation is uniform across variable
        // names in that chain — there is no per-variable special-casing
        // anywhere in make/npm/sh/tsx).
        await waitForOutput(child.stdout!, /listening on port/, 25_000);

        if (process.platform === "linux") {
          // Literal, per-variable confirmation — runs on CI (ci.yml uses
          // ubuntu-latest runners). /proc is Linux-only, so this branch is
          // a no-op elsewhere (see the boot assertion above, which does
          // run everywhere and already proves general propagation).
          const pid = findProcessWithEnvVar("APP_SECRETS_KEY", probeKey);
          expect(pid, "no descendant of `make dev-backend` had APP_SECRETS_KEY in its environment").not.toBeNull();
        } else {
          console.warn(
            `[env-loading-guard] skipped the /proc-based APP_SECRETS_KEY check on ${process.platform} ` +
              "(Linux-only); the boot-with-injected-env assertion above still ran.",
          );
        }
      } catch (err) {
        throw new Error(`${(err as Error).message}\n\n--- child output ---\n${stdout}`);
      } finally {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // already dead
          }
        }
      }
    },
    30_000,
  );
});
