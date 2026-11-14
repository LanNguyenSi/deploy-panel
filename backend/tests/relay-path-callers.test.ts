import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Structural guard for the class "a caller of relayAppPath that does not turn
// InvalidAppNameError into its own failure path". relayAppPath (lib/relay-
// path.ts) refuses a name the relay itself refuses; the route guards in front
// of some callers (APP_NAME_PATTERN in lib/app-name.ts, which allows dots) can
// let such a name through, so every caller needs a deliberate refusal path.
//
// This test lists every file under backend/src that calls relayAppPath( and
// how many times. A new call site in a listed file, or a call in any other
// file, fails here until its refusal path exists and is added below with the
// test that pins it. The same table is kept as a comment next to
// RELAY_APP_NAME_PATTERN in lib/relay-path.ts.
//
// Limits: it is a text scan of non-comment source. It does not see a call
// through an alias, a re-export or a dynamic import of the helper, and a
// matching `InvalidAppNameError` reference proves a catch exists in the file,
// not that it sits at the right call; the named behavioural tests prove that.

type Handling =
  /** The file itself catches InvalidAppNameError (must reference it). */
  | { kind: "catch"; ends: string; pinnedBy: string }
  /** The refusal propagates to a caller that handles it. */
  | { kind: "delegated"; ends: string; pinnedBy: string };

const HANDLED: Record<string, { calls: number } & Handling> = {
  "routes/sync.ts": { calls: 1, kind: "catch", ends: "logged skip, no relay call, no App write", pinnedBy: "sync-relay-name-skip.test.ts" },
  "routes/v1.ts": {
    calls: 1, // the single call lives in relayPathOrNull(); rollback, logs, preflight use it and answer 400
    kind: "catch",
    ends: "400 invalid_app_name (rollback before the Deploy row)",
    pinnedBy: "v1-api.test.ts: names the relay path builder refuses",
  },
  "routes/apps.ts": {
    calls: 5, // rollback, logs, preflight, env GET, env PUT
    kind: "catch",
    ends: "400 invalid_app_name",
    pinnedBy: "apps-relay-name-guard.test.ts",
  },
  "lib/required-env-gate.ts": { calls: 1, kind: "catch", ends: "failed required-env check", pinnedBy: "required-env-gate-relay-name.test.ts" },
  "lib/startup.ts": { calls: 1, kind: "catch", ends: "interrupted row naming the refusal", pinnedBy: "startup-app-name-guard.test.ts" },
  "lib/stream-deploy.ts": {
    calls: 1,
    kind: "catch",
    ends: "failed row with a preflight-kind step, App status restored, no recoverBrokenDeploy",
    pinnedBy: "stream-deploy-url-encoding.test.ts, refused-deploy-app-status.test.ts",
  },
  "lib/provision-secrets.ts": {
    calls: 2,
    kind: "delegated",
    ends: "typed throw before any relay call; streamDeploy catches it",
    pinnedBy: "provision-secrets-relay-name.test.ts, stream-deploy-url-encoding.test.ts",
  },
  "lib/post-deploy-gate.ts": {
    calls: 1,
    kind: "delegated",
    ends: "container state not inspected (the poll's own catch)",
    pinnedBy: "post-deploy-gate.test.ts",
  },
  "lib/deploy-target.ts": {
    calls: 1,
    kind: "delegated",
    ends: "reached: false (checkDeployTarget's caller catch)",
    pinnedBy: "deploy-target-relay-name.test.ts",
  },
};

const SRC = join(__dirname, "..", "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

/** Source with block and line comments removed, so prose mentioning the helper is not counted. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const HELPER_FILE = join(SRC, "lib", "relay-path.ts");
const callers = new Map<string, number>();
for (const file of walk(SRC)) {
  if (file === HELPER_FILE) continue;
  const n = (code(file).match(/\brelayAppPath\(/g) ?? []).length;
  if (n > 0) callers.set(relative(SRC, file), n);
}

describe("every caller of relayAppPath has a handled refusal path", () => {
  it("finds the callers (the scan itself works)", () => {
    expect(callers.size).toBeGreaterThanOrEqual(Object.keys(HANDLED).length);
  });

  it("no file calls relayAppPath without being listed in the handled-sites table", () => {
    const unlisted = [...callers.keys()].filter((f) => !(f in HANDLED));
    expect(unlisted).toEqual([]);
  });

  it("no listed file lost its calls or gained one (update the table and its refusal path together)", () => {
    const counts = Object.fromEntries([...callers].map(([f, n]) => [f, n]));
    const expected = Object.fromEntries(Object.entries(HANDLED).map(([f, h]) => [f, h.calls]));
    expect(counts).toEqual(expected);
  });

  it.each(Object.entries(HANDLED).filter(([, h]) => h.kind === "catch"))(
    "%s references InvalidAppNameError (its own catch)",
    (file) => {
      expect(code(join(SRC, file))).toContain("InvalidAppNameError");
    },
  );
});
