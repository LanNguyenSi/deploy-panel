import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

// The boot tasks (relay-token backfill, stuck-deploy recovery, scheduler
// start) used to be called directly from the serve() callback body, where
// nothing but running the real image could observe their wiring; they now
// live behind runStartupTasks (backend/src/lib/boot.ts), tested in
// tests/startup-tasks.test.ts. What that test suite CANNOT see is that
// server.ts still calls the seam from the callback at all, so the checks
// below pin exactly that. They walk the parsed syntax tree rather than
// match text: a commented-out call, a call in dead code and a call moved
// out of the serve() callback must all fail.
function isCallTo(node: ts.Node, name: string): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;
}

function collectCalls(root: ts.Node, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (isCallTo(node, name)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

describe("server.ts: boot tasks are wired through runStartupTasks", () => {
  const sourceFile = ts.createSourceFile("server.ts", serverSrc, ts.ScriptTarget.Latest, true);

  it("awaits runStartupTasks as a top-level statement of the serve() callback, after the app-secrets log line", () => {
    const serveStatements = sourceFile.statements.filter(
      (stmt): stmt is ts.ExpressionStatement => ts.isExpressionStatement(stmt) && isCallTo(stmt.expression, "serve"),
    );
    expect(serveStatements, "expected exactly one top-level serve(...) call in server.ts").toHaveLength(1);
    const serveCall = serveStatements[0].expression as ts.CallExpression;
    const callback = serveCall.arguments[1];
    expect(callback, "serve() must be called with a listening callback as its second argument").toBeDefined();
    expect(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)).toBe(true);
    const body = (callback as ts.ArrowFunction | ts.FunctionExpression).body;
    expect(ts.isBlock(body), "the serve() callback must have a block body").toBe(true);
    const statements = (body as ts.Block).statements;

    // The await keeps the callback shape identical to the old inline body.
    // serve() does not await its listener, so a rejection reaches the
    // unhandledRejection backstop above whether or not the call is awaited.
    const startupIndex = statements.findIndex(
      (stmt) =>
        ts.isExpressionStatement(stmt) &&
        ts.isAwaitExpression(stmt.expression) &&
        isCallTo(stmt.expression.expression, "runStartupTasks"),
    );
    const appSecretsIndex = statements.findIndex(
      (stmt) =>
        ts.isExpressionStatement(stmt) &&
        ts.isCallExpression(stmt.expression) &&
        stmt.expression.arguments.some((arg) => ts.isTemplateExpression(arg) && arg.head.text.startsWith("app-secrets:")),
    );
    expect(startupIndex, "no top-level `await runStartupTasks();` statement in the serve() callback").toBeGreaterThan(-1);
    expect(appSecretsIndex, "no top-level app-secrets log statement in the serve() callback").toBeGreaterThan(-1);
    expect(startupIndex).toBeGreaterThan(appSecretsIndex);

    expect(collectCalls(sourceFile, "runStartupTasks"), "runStartupTasks must be called exactly once in server.ts").toHaveLength(1);
  });

  it("does not call the three boot tasks directly any more", () => {
    // Call sites only (`name(`): a prose mention of a task name stays
    // allowed, a re-introduced direct call (or dead code around one) does
    // not, and neither does keeping the old imports the calls would need.
    for (const name of ["backfillRelayTokenCiphertext", "recoverStuckDeploys", "startScheduler"]) {
      expect(
        serverSrc,
        `server.ts must not call ${name} directly: the boot tasks go through runStartupTasks (lib/boot.ts)`,
      ).not.toMatch(new RegExp(`\\b${name}\\s*\\(`));
    }
    expect(serverSrc).not.toMatch(/from\s+["']\.\/lib\/(?:startup|scheduler)\.js["']/);
  });
});
