import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import assert from "node:assert";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

/**
 * Behavioural tests for the JSON body construction of the "Preflight checks"
 * and "Trigger deploy" steps of the GitHub Action (action/action.yml). Both
 * bodies are built with `jq -n --arg`/`--argjson`, so a quote or backslash in
 * `server`/`app` must round-trip as data instead of changing the JSON, and
 * `force` must go out as a real JSON boolean: only the exact input string
 * "true" sends true, anything else ("false", empty, "TRUE", "1") sends false.
 *
 * In the style of action-poll.test.ts: each step's `run:` script is extracted
 * from the YAML and run under bash against a stub `curl` that records the
 * `-d` argument to a file and answers with a canned JSON body. The recorded
 * body is then JSON.parsed (a string-interpolated body with these inputs is
 * not valid JSON and the parse itself fails) and compared field by field.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

interface ActionStep {
  id?: string;
  run?: string;
}
interface ActionFile {
  runs: { steps: ActionStep[] };
}

const actionDoc = yaml.load(readFileSync(path.join(repoRoot, "action", "action.yml"), "utf8")) as ActionFile;
const preflightScript = actionDoc.runs.steps.find((s) => s.id === "preflight")?.run ?? "";
const deployScript = actionDoc.runs.steps.find((s) => s.id === "deploy")?.run ?? "";

const hasJq = spawnSync("jq", ["--version"], { encoding: "utf8" }).status === 0;

// Records the `-d` argument verbatim, counts calls, answers with a body that
// satisfies both steps (`passed: true` so preflight exits 0, a deploy id so
// the deploy step writes its output).
const STUB_CURL = `#!/usr/bin/env bash
echo x >> "$STUB_CALLS"
while [ $# -gt 0 ]; do
  if [ "$1" = "-d" ]; then printf '%s\\n' "$2" > "$STUB_BODY"; shift 2; else shift; fi
done
printf '%s\\n' '{"passed": true, "checks": [], "deploy": {"id": "d1"}}'
`;

interface RunOpts {
  server: string;
  app: string;
  force?: string;
}

interface RunResult {
  status: number | null;
  calls: number;
  bodyText: string;
  body: Record<string, unknown>;
}

function runStep(dir: string, name: string, script: string, opts: RunOpts): RunResult {
  const bodyFile = path.join(dir, "body.json");
  const calls = path.join(dir, "calls.txt");
  const ghOut = path.join(dir, "gh_output.txt");
  const scriptFile = path.join(dir, `${name}.sh`);
  const stubDir = path.join(dir, "stub");

  writeFileSync(bodyFile, "");
  writeFileSync(calls, "");
  writeFileSync(ghOut, "");
  writeFileSync(scriptFile, script);
  const curlStub = path.join(stubDir, "curl");
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(curlStub, STUB_CURL);
  chmodSync(curlStub, 0o755);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${stubDir}:${process.env.PATH}`,
    PANEL_URL: "http://127.0.0.1:1",
    API_KEY: "k",
    SERVER: opts.server,
    APP: opts.app,
    // Set explicitly so a FORCE in the caller's environment never leaks in.
    FORCE: opts.force ?? "",
    STUB_BODY: bodyFile,
    STUB_CALLS: calls,
    GITHUB_OUTPUT: ghOut,
  };

  // Both steps declare `shell: bash`, which Actions runs as
  // `bash --noprofile --norc -eo pipefail`.
  const proc = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", scriptFile], { env, encoding: "utf8", timeout: 15000, killSignal: "SIGKILL" });
  assert.ok(proc.error === undefined, `spawnSync failed: ${String(proc.error)}`);
  assert.ok(proc.signal === null, `${name} step was killed by ${String(proc.signal)} (hang?)`);

  const bodyText = readFileSync(bodyFile, "utf8");
  const callLines = readFileSync(calls, "utf8").split("\n").filter((l) => l.length > 0);

  return {
    status: proc.status,
    calls: callLines.length,
    bodyText,
    body: JSON.parse(bodyText) as Record<string, unknown>,
  };
}

// Hostile values: a quote and a backslash in the app name, a quote in the
// server name. Under string interpolation these produce invalid JSON (the
// JSON.parse in runStep throws); under `jq -n --arg` they must round-trip.
const HOSTILE_APP = 'a"b\\c';
const HOSTILE_SERVER = 's"rv';

describe.skipIf(!hasJq)("action body steps (jq-built request bodies)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "action-body-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("preflight body is valid JSON and carries server/app verbatim", () => {
    const r = runStep(dir, "preflight", preflightScript, { server: HOSTILE_SERVER, app: HOSTILE_APP });
    expect(r.status).toBe(0);
    expect(r.calls).toBe(1);
    expect(r.body.server).toBe(HOSTILE_SERVER);
    expect(r.body.app).toBe(HOSTILE_APP);
    expect(Object.keys(r.body).sort()).toEqual(["app", "server"]);
  });

  it("deploy body is valid JSON and carries server/app verbatim", () => {
    const r = runStep(dir, "deploy", deployScript, { server: HOSTILE_SERVER, app: HOSTILE_APP, force: "false" });
    expect(r.status).toBe(0);
    expect(r.calls).toBe(1);
    expect(r.body.server).toBe(HOSTILE_SERVER);
    expect(r.body.app).toBe(HOSTILE_APP);
  });

  // force is a JSON boolean, not a string: only the exact string "true" is
  // true; "false", empty, "TRUE" and "1" are all false.
  const forceCases: Array<[string, boolean]> = [
    ["true", true],
    ["false", false],
    ["", false],
    ["TRUE", false],
    ["1", false],
  ];
  it.each(forceCases)("FORCE=%j sends JSON boolean force=%s", (force, expected) => {
    const r = runStep(dir, "deploy", deployScript, { server: "srv", app: "my-app", force });
    expect(r.status).toBe(0);
    expect(typeof r.body.force).toBe("boolean");
    expect(r.body.force).toBe(expected);
  });
});

if (!hasJq) {
  it("action body steps SKIPPED: jq is not on PATH, so the steps cannot be exercised", () => {
    // Intentionally empty: the describe block above is skipped when jq is
    // absent. This documents why the body construction was not asserted here.
  });
}
