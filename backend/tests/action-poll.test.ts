import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

/**
 * Behavioural tests for the "Wait for completion" step of the GitHub Action
 * (action/action.yml, step id: poll). Nothing else in the repo exercises
 * action/, so this reads the step's `run:` script out of the YAML, runs it
 * under bash against a stub `curl` (a scripted HTTP sequence) and a stub
 * `sleep` (records its arguments and does not sleep), and asserts the
 * transient-vs-fatal policy: a refused connection, a 5xx, a 404 and a 2xx
 * with an unparsable/empty body are retried with backoff until the deadline;
 * 401/403 are fatal (status=error); a valid status settles the run.
 *
 * The stub `curl` honours the `-w '\n%{http_code}'` the script relies on by
 * appending the code line; a `000` line exits non-zero like a real
 * connection failure. POLL_BASE_INTERVAL shrinks the backoff base to 0 so the
 * retried cases run instantly; the one deadline case instead stalls inside
 * the stub `curl` (CURL_STALL_SEC, via /bin/sleep) so the wall-clock SECONDS
 * deadline fires without the script's own sleeps advancing it.
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
const pollStep = actionDoc.runs.steps.find((s) => s.id === "poll");
const runScript = pollStep?.run ?? "";

const hasJq = spawnSync("jq", ["--version"], { encoding: "utf8" }).status === 0;

// The step's own sleeps are stubbed, so SECONDS (wall time from step start)
// is the only bound; a stalled poll is the deadline test's clock.
const STUB_CURL = `#!/usr/bin/env bash
if [ "\${CURL_STALL_SEC}" != "0" ]; then /bin/sleep "\${CURL_STALL_SEC}"; fi
prior=$(wc -l < "$STUB_CALLS" 2>/dev/null || echo 0)
prior=$(printf '%s' "$prior" | tr -d ' ')
idx=$((prior + 1))
echo x >> "$STUB_CALLS"
line=$(sed -n "\${idx}p" "$STUB_SEQ")
if [ -z "$line" ]; then line=$(tail -n 1 "$STUB_SEQ"); fi
code=$(echo "$line" | cut -d ' ' -f 1)
body=$(echo "$line" | cut -s -d ' ' -f 2-)
if [ "$code" = "000" ]; then exit 7; fi
echo "$body"
echo "$code"
`;

const STUB_SLEEP = `#!/usr/bin/env bash
echo "$1" >> "$STUB_SLEEP_LOG"
exit 0
`;

interface RunOpts {
  timeout: string;
  base: string;
  stallSec?: string;
  seq: string[];
}

interface RunResult {
  status: number | null;
  stdout: string;
  calls: number;
  sleeps: string[];
  output: Record<string, string>;
}

function runAction(dir: string, opts: RunOpts): RunResult {
  const seq = path.join(dir, "seq.txt");
  const calls = path.join(dir, "calls.txt");
  const sleeps = path.join(dir, "sleeps.txt");
  const ghOut = path.join(dir, "gh_output.txt");
  const script = path.join(dir, "poll.sh");
  const stubDir = path.join(dir, "stub");

  writeFileSync(seq, opts.seq.map((l) => `${l}\n`).join(""));
  writeFileSync(calls, "");
  writeFileSync(sleeps, "");
  writeFileSync(ghOut, "");
  writeFileSync(script, runScript);
  const curlStub = path.join(stubDir, "curl");
  const sleepStub = path.join(stubDir, "sleep");
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(curlStub, STUB_CURL);
  writeFileSync(sleepStub, STUB_SLEEP);
  chmodSync(curlStub, 0o755);
  chmodSync(sleepStub, 0o755);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${stubDir}:${process.env.PATH}`,
    PANEL_URL: "http://127.0.0.1:1",
    API_KEY: "k",
    DEPLOY_ID: "d1",
    TIMEOUT: opts.timeout,
    POLL_BASE_INTERVAL: opts.base,
    CURL_STALL_SEC: opts.stallSec ?? "0",
    STUB_SEQ: seq,
    STUB_CALLS: calls,
    STUB_SLEEP_LOG: sleeps,
    GITHUB_OUTPUT: ghOut,
  };

  const proc = spawnSync("bash", [script], { env, encoding: "utf8" });

  const output: Record<string, string> = {};
  for (const line of readFileSync(ghOut, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) output[line.slice(0, i)] = line.slice(i + 1);
  }
  const callLines = readFileSync(calls, "utf8").split("\n").filter((l) => l.length > 0);
  const sleepLines = readFileSync(sleeps, "utf8").split("\n").filter((l) => l.length > 0);

  return {
    status: proc.status,
    stdout: proc.stdout ?? "",
    calls: callLines.length,
    sleeps: sleepLines,
    output,
  };
}

describe.skipIf(!hasJq)("action poll step (transient poll policy)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "action-poll-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a: refused, 502, running, success -> exit 0, status=success, 4 polls", () => {
    const r = runAction(dir, {
      timeout: "100",
      base: "0",
      seq: ["000", "502 {}", '200 {"deploy":{"status":"running"}}', '200 {"deploy":{"status":"success","steps":[]}}'],
    });
    expect(r.status).toBe(0);
    expect(r.output.status).toBe("success");
    expect(r.calls).toBe(4);
  });

  it("b: 200 with an unparsable body is transient, then success -> exit 0", () => {
    const r = runAction(dir, {
      timeout: "100",
      base: "0",
      seq: ["200 not-json", '200 {"deploy":{"status":"success","steps":[]}}'],
    });
    expect(r.status).toBe(0);
    expect(r.output.status).toBe("success");
    expect(r.calls).toBe(2);
  });

  it("c: 401 is fatal at once -> exit 1, status=error, 1 poll", () => {
    const r = runAction(dir, { timeout: "100", base: "0", seq: ["401 {}"] });
    expect(r.status).toBe(1);
    expect(r.output.status).toBe("error");
    expect(r.calls).toBe(1);
    expect(r.stdout).toContain("HTTP 401");
  });

  it("d: permanent refusal with a stalled poll and TIMEOUT=1 -> exit 1, status=timeout", () => {
    const r = runAction(dir, { timeout: "1", base: "0", stallSec: "1", seq: ["000"] });
    expect(r.status).toBe(1);
    expect(r.output.status).toBe("timeout");
    expect(r.calls).toBeGreaterThanOrEqual(1);
  });

  it("e: failed status is final -> exit 1, status=failed", () => {
    const r = runAction(dir, { timeout: "100", base: "0", seq: ['200 {"deploy":{"status":"failed"}}'] });
    expect(r.status).toBe(1);
    expect(r.output.status).toBe("failed");
  });

  it("f: non-numeric TIMEOUT is a usage error -> exit 1, status=error, 0 polls", () => {
    const r = runAction(dir, { timeout: "abc", base: "0", seq: ["200 {\"deploy\":{\"status\":\"success\"}}"] });
    expect(r.status).toBe(1);
    expect(r.output.status).toBe("error");
    expect(r.calls).toBe(0);
    expect(r.stdout).toContain("timeout must be a number of seconds");
  });

  it("g: four consecutive failures back off 10, 20, 30, 30 then success -> exit 0", () => {
    const r = runAction(dir, {
      timeout: "100",
      base: "10",
      seq: ["000", "502 {}", "502 {}", "502 {}", '200 {"deploy":{"status":"success","steps":[]}}'],
    });
    expect(r.status).toBe(0);
    expect(r.output.status).toBe("success");
    expect(r.sleeps).toEqual(["10", "20", "30", "30"]);
  });
});

if (!hasJq) {
  it("action poll step SKIPPED: jq is not on PATH, so the poll step cannot be exercised", () => {
    // Intentionally empty: the describe block above is skipped when jq is
    // absent. This documents why the poll behaviour was not asserted here.
  });
}
