import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import assert from "node:assert";
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
 * transient-vs-fatal policy: a refused connection, a 5xx, a 404, a 408 or a
 * 429 from the proxy, and a 2xx whose body carries no parsable status are
 * retried with backoff until the deadline; any other non-2xx code (401/403
 * included) is fatal (status=error); a valid status settles the run.
 *
 * The stub `curl` honours the curl contract the script relies on: it records
 * its argv (so a case pins the URL, the Authorization header and
 * `--max-time 20`) and appends the code line only when `-w` is present,
 * expanding `%{http_code}` from the scripted sequence; a `000` line exits
 * non-zero like a real connection failure. DEPLOY_PANEL_ACTION_TEST_POLL_BASE
 * (the step's test-harness knob) shrinks the backoff base to 0 so the retried
 * cases run instantly; the two deadline cases instead stall inside the stub
 * `curl` (CURL_STALL_SEC, via /bin/sleep) so the wall-clock SECONDS deadline
 * fires without the script's own sleeps advancing it. spawnSync runs with a
 * hard timeout and every case asserts the script was neither killed nor
 * errored: a regressed deadline must fail that one case, not hang vitest.
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
if [ "\${CURL_STALL_SEC:-0}" != "0" ]; then /bin/sleep "\${CURL_STALL_SEC}"; fi
printf '%s\\n' "$@" > "$STUB_ARGV"
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
fmt=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-w" ]; then fmt="$2"; shift 2; else shift; fi
done
if [ -n "$fmt" ]; then
  printf '%b' "\${fmt//%\\{http_code\\}/$code}"
fi
`;

const STUB_SLEEP = `#!/usr/bin/env bash
echo "$1" >> "$STUB_SLEEP_LOG"
exit 0
`;

interface RunOpts {
  timeout: string;
  base?: string;
  stallSec?: string;
  seq: string[];
}

interface RunResult {
  status: number | null;
  stdout: string;
  calls: number;
  sleeps: string[];
  argv: string[];
  output: Record<string, string>;
}

function runAction(dir: string, opts: RunOpts): RunResult {
  const seq = path.join(dir, "seq.txt");
  const calls = path.join(dir, "calls.txt");
  const sleeps = path.join(dir, "sleeps.txt");
  const argvFile = path.join(dir, "argv.txt");
  const ghOut = path.join(dir, "gh_output.txt");
  const script = path.join(dir, "poll.sh");
  const stubDir = path.join(dir, "stub");

  writeFileSync(seq, opts.seq.map((l) => `${l}\n`).join(""));
  writeFileSync(calls, "");
  writeFileSync(sleeps, "");
  writeFileSync(argvFile, "");
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
    ...(opts.base === undefined ? {} : { DEPLOY_PANEL_ACTION_TEST_POLL_BASE: opts.base }),
    CURL_STALL_SEC: opts.stallSec ?? "0",
    STUB_SEQ: seq,
    STUB_CALLS: calls,
    STUB_ARGV: argvFile,
    STUB_SLEEP_LOG: sleeps,
    GITHUB_OUTPUT: ghOut,
  };

  // No timeout means spawnSync blocks the event loop: a regressed deadline
  // would hang the whole test run instead of failing this one case.
  const proc = spawnSync("bash", [script], { env, encoding: "utf8", timeout: 15000, killSignal: "SIGKILL" });
  assert.ok(proc.error === undefined, `spawnSync failed: ${String(proc.error)}`);
  assert.ok(proc.signal === null, `poll step was killed by ${String(proc.signal)} after the 15 s harness timeout (hang?)`);

  const output: Record<string, string> = {};
  for (const line of readFileSync(ghOut, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) output[line.slice(0, i)] = line.slice(i + 1);
  }
  const callLines = readFileSync(calls, "utf8").split("\n").filter((l) => l.length > 0);
  const sleepLines = readFileSync(sleeps, "utf8").split("\n").filter((l) => l.length > 0);
  const argvLines = readFileSync(argvFile, "utf8").split("\n").filter((l) => l.length > 0);

  return {
    status: proc.status,
    stdout: proc.stdout ?? "",
    calls: callLines.length,
    sleeps: sleepLines,
    argv: argvLines,
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

  it("d: permanent refusal with a stalled poll and TIMEOUT=1 -> exit 1, status=timeout naming the last poll", () => {
    const r = runAction(dir, { timeout: "1", base: "0", stallSec: "1", seq: ["000"] });
    expect(r.status).toBe(1);
    expect(r.output.status).toBe("timeout");
    expect(r.calls).toBeGreaterThanOrEqual(1);
    expect(r.stdout).toContain("(last poll: http 000, status none)");
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

  it("h: 404 is transient, then success -> exit 0, 2 polls", () => {
    const r = runAction(dir, {
      timeout: "100",
      base: "0",
      seq: ["404 {}", '200 {"deploy":{"status":"success","steps":[]}}'],
    });
    expect(r.status).toBe(0);
    expect(r.output.status).toBe("success");
    expect(r.calls).toBe(2);
  });

  it("i: 403 is fatal at once -> exit 1, status=error, 1 poll", () => {
    const r = runAction(dir, { timeout: "100", base: "0", seq: ["403 {}"] });
    expect(r.status).toBe(1);
    expect(r.output.status).toBe("error");
    expect(r.calls).toBe(1);
    expect(r.stdout).toContain("HTTP 403");
  });

  it("j: 200 with a null deploy status is transient, then success -> exit 0", () => {
    const r = runAction(dir, {
      timeout: "100",
      base: "0",
      seq: ['200 {"deploy":{"status":null}}', '200 {"deploy":{"status":"success","steps":[]}}'],
    });
    expect(r.status).toBe(0);
    expect(r.output.status).toBe("success");
    expect(r.calls).toBe(2);
  });

  it("k: backoff resets after a poll that answers: fail, running, fail at base 10 sleeps 10, 10, 10", () => {
    const r = runAction(dir, {
      timeout: "100",
      base: "10",
      seq: ["502 {}", '200 {"deploy":{"status":"running"}}', "502 {}", '200 {"deploy":{"status":"success","steps":[]}}'],
    });
    expect(r.status).toBe(0);
    expect(r.output.status).toBe("success");
    expect(r.sleeps).toEqual(["10", "10", "10"]);
  });

  it("l: only running polls with a stalled poll and TIMEOUT=1 -> timeout naming running as the last poll", () => {
    const r = runAction(dir, {
      timeout: "1",
      base: "0",
      stallSec: "1",
      seq: ['200 {"deploy":{"status":"running"}}'],
    });
    expect(r.status).toBe(1);
    expect(r.output.status).toBe("timeout");
    expect(r.calls).toBeGreaterThanOrEqual(1);
    expect(r.stdout).toContain("(last poll: http 200, status running)");
  });

  it("m: 400 is outside the table -> exit 1, status=error, 1 poll", () => {
    const r = runAction(dir, { timeout: "100", base: "0", seq: ["400 {}"] });
    expect(r.status).toBe(1);
    expect(r.output.status).toBe("error");
    expect(r.calls).toBe(1);
    expect(r.stdout).toContain("Deploy polling failed with HTTP 400");
  });

  it("m2: 429 and 408 are transient, then success -> exit 0, 3 polls", () => {
    const r = runAction(dir, {
      timeout: "100",
      base: "0",
      seq: ["429 {}", "408 {}", '200 {"deploy":{"status":"success","steps":[]}}'],
    });
    expect(r.status).toBe(0);
    expect(r.output.status).toBe("success");
    expect(r.calls).toBe(3);
  });

  it("n: the poll request carries the deploy URL, the Bearer header and --max-time 20", () => {
    const r = runAction(dir, {
      timeout: "100",
      base: "0",
      seq: ['200 {"deploy":{"status":"success","steps":[]}}'],
    });
    expect(r.status).toBe(0);
    expect(r.argv).toContain("http://127.0.0.1:1/api/v1/deploy/d1");
    expect(r.argv).toContain("Authorization: Bearer k");
    const maxTime = r.argv.indexOf("--max-time");
    expect(maxTime).toBeGreaterThanOrEqual(0);
    expect(r.argv[maxTime + 1]).toBe("20");
  });

  it("o: test knob at 0, 10, absent, empty or non-numeric -> backoff sleeps 0, 0 or 10, 20, 30, 30", () => {
    const failing = ["000", "502 {}", "502 {}", "502 {}", '200 {"deploy":{"status":"success","steps":[]}}'];
    expect(runAction(dir, { timeout: "100", base: "0", seq: failing }).sleeps).toEqual(["0", "0", "0", "0"]);
    expect(runAction(dir, { timeout: "100", base: "10", seq: failing }).sleeps).toEqual(["10", "20", "30", "30"]);
    expect(runAction(dir, { timeout: "100", seq: failing }).sleeps).toEqual(["10", "20", "30", "30"]);
    expect(runAction(dir, { timeout: "100", base: "", seq: failing }).sleeps).toEqual(["10", "20", "30", "30"]);
    expect(runAction(dir, { timeout: "100", base: "abc", seq: failing }).sleeps).toEqual(["10", "20", "30", "30"]);
  });
});

if (!hasJq) {
  it("action poll step SKIPPED: jq is not on PATH, so the poll step cannot be exercised", () => {
    // Intentionally empty: the describe block above is skipped when jq is
    // absent. This documents why the poll behaviour was not asserted here.
  });
}
