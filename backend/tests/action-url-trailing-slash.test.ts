import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import assert from "node:assert";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

/**
 * Behavioural tests for the panel URL trimming of the three GitHub Action
 * steps that talk to the panel (action/action.yml, step ids preflight,
 * deploy and poll). A `url` input configured with one or more trailing
 * slashes used to reach the API doubled (`https://panel.example.com//api/
 * ...`): the steps interpolated `PANEL_URL` verbatim. Each of the three
 * `run:` scripts now trims every trailing slash off `PANEL_URL` first,
 * with the backend's trimTrailingSlashes semantics (only trailing slashes
 * go, an inner path prefix survives).
 *
 * In the style of action-body.test.ts and action-poll.test.ts: each step's
 * `run:` script is extracted from the YAML and run under bash against a
 * stub `curl` that records its argv and answers with one body satisfying
 * all three steps (preflight passes, the deploy id parses, the poll sees
 * `status: success`), expanding `%{http_code}` to 200 when `-w` is present
 * so the poll step parses its code line. For every step the recorded argv
 * must carry exactly one API URL, byte-equal to the origin (trimmed, inner
 * path kept) plus the endpoint path the step calls, for a panel URL with
 * zero, one and three trailing slashes and with an inner path.
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
const scriptOf = (id: string): string => actionDoc.runs.steps.find((s) => s.id === id)?.run ?? "";

const hasJq = spawnSync("jq", ["--version"], { encoding: "utf8" }).status === 0;

// One body answers all three steps: `passed: true` (preflight exits 0),
// `deploy.id` (the deploy step writes its output), `deploy.status: success`
// (the poll settles on the first call, so the step's sleep is never reached).
const STUB_CURL = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$STUB_ARGV"
echo x >> "$STUB_CALLS"
code=200
printf '%s\\n' '{"passed": true, "checks": [], "deploy": {"id": "d1", "status": "success", "steps": []}}'
fmt=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-w" ]; then fmt="$2"; shift 2; else shift; fi
done
if [ -n "$fmt" ]; then
  printf '%b' "\${fmt//%\\{http_code\\}/$code}"
fi
`;

interface RunResult {
  status: number | null;
  stdout: string;
  calls: number;
  argv: string[];
}

function runStep(dir: string, name: string, script: string, panelUrl: string): RunResult {
  const argvFile = path.join(dir, "argv.txt");
  const calls = path.join(dir, "calls.txt");
  const ghOut = path.join(dir, "gh_output.txt");
  const scriptFile = path.join(dir, `${name}.sh`);
  const stubDir = path.join(dir, "stub");

  writeFileSync(argvFile, "");
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
    PANEL_URL: panelUrl,
    API_KEY: "k",
    SERVER: "srv",
    APP: "my-app",
    // Set explicitly so values from the caller's environment never leak in.
    FORCE: "false",
    DEPLOY_ID: "d1",
    TIMEOUT: "100",
    DEPLOY_PANEL_ACTION_TEST_POLL_BASE: "0",
    STUB_ARGV: argvFile,
    STUB_CALLS: calls,
    GITHUB_OUTPUT: ghOut,
  };

  // All three steps declare `shell: bash`, which Actions runs as
  // `bash --noprofile --norc -eo pipefail`.
  const proc = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", scriptFile], { env, encoding: "utf8", timeout: 15000, killSignal: "SIGKILL" });
  assert.ok(proc.error === undefined, `spawnSync failed: ${String(proc.error)}`);
  assert.ok(proc.signal === null, `${name} step was killed by ${String(proc.signal)} (hang?)`);

  const callLines = readFileSync(calls, "utf8").split("\n").filter((l) => l.length > 0);
  const argvLines = readFileSync(argvFile, "utf8").split("\n").filter((l) => l.length > 0);

  return {
    status: proc.status,
    stdout: proc.stdout ?? "",
    calls: callLines.length,
    argv: argvLines,
  };
}

const ORIGIN = "http://127.0.0.1:1";

// [PANEL_URL as configured, the origin the request must carry]
const URL_CASES: Array<[label: string, panelUrl: string, expectedOrigin: string]> = [
  ["no trailing slash", ORIGIN, ORIGIN],
  ["one trailing slash", `${ORIGIN}/`, ORIGIN],
  ["three trailing slashes", `${ORIGIN}///`, ORIGIN],
  ["inner path with one trailing slash", `${ORIGIN}/panel/`, `${ORIGIN}/panel`],
  ["inner path with three trailing slashes", `${ORIGIN}/panel///`, `${ORIGIN}/panel`],
];

const STEPS: Array<[id: string, pathSuffix: string]> = [
  ["preflight", "/api/v1/preflight"],
  ["deploy", "/api/v1/deploy"],
  ["poll", "/api/v1/deploy/d1"],
];

describe.skipIf(!hasJq)("action panel URL trimming (trailing slashes removed)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "action-url-slash-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe.each(STEPS)("%s step", (id, pathSuffix) => {
    const script = scriptOf(id);
    it("script is present in the action YAML", () => {
      expect(script.length).toBeGreaterThan(0);
    });

    it.each(URL_CASES)("PANEL_URL with %s -> curl gets the exact API URL", (_label, panelUrl, expectedOrigin) => {
      const r = runStep(dir, id, script, panelUrl);
      expect(r.status).toBe(0);
      expect(r.calls).toBe(1);
      const urls = r.argv.filter((a) => a.includes("/api/"));
      expect(urls).toEqual([`${expectedOrigin}${pathSuffix}`]);
    });
  });
});

if (!hasJq) {
  it("action URL trimming steps SKIPPED: jq is not on PATH, so the steps cannot be exercised", () => {
    // Intentionally empty: the describe block above is skipped when jq is
    // absent. This documents why the trimming was not asserted here.
  });
}
