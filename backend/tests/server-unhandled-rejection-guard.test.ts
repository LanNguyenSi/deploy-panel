import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// server.ts is deliberately excluded from coverage (backend/vitest.config.ts:
// "the side-effecting server entrypoint") and the project's own convention
// for guarding it (env-loading-guard.test.ts) is to spawn a real child
// process rather than import it in-process, since importing it unavoidably
// runs `serve()` and the boot sequence (recoverStuckDeploys, startScheduler)
// as an ES module side effect. This guard follows the same
// read-the-source-text convention env-loading-guard.test.ts already uses for
// docker-compose.yml, scoped to one thing: that the process-level
// unhandledRejection backstop (deploy-panel round-3 review, item 3) is
// actually registered, early, and logs rather than silently swallowing.
//
// What this does NOT prove: that the handler is reachable before every
// import-time side effect (Node registers listeners synchronously as source
// runs top-to-bottom, so placement in the file is the guarantee, not
// something a text match alone can execute). The ordering assertion below
// covers that instead.

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const serverSrc = readFileSync(path.join(repoRoot, "backend/src/server.ts"), "utf8");

describe("server.ts: unhandledRejection backstop is registered", () => {
  it("registers a process-level unhandledRejection handler that logs the reason", () => {
    const match = serverSrc.match(/process\.on\(\s*["']unhandledRejection["']\s*,\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\}\s*\)\s*;/);
    expect(match, `no process.on("unhandledRejection", ...) registration found in server.ts:\n${serverSrc}`).not.toBeNull();
    expect(match?.[1]).toMatch(/console\.error/);
  });

  it("registers the handler before serve() is called, so it is in place before anything else in the file can reject", () => {
    const registrationIndex = serverSrc.indexOf('process.on("unhandledRejection"');
    // `serve({` (not just `serve(`), since a couple of comments above
    // mention `serve()` in prose and would otherwise false-match first.
    const serveCallIndex = serverSrc.indexOf("serve({");
    expect(registrationIndex).toBeGreaterThan(-1);
    expect(serveCallIndex).toBeGreaterThan(-1);
    expect(registrationIndex).toBeLessThan(serveCallIndex);
  });
});
