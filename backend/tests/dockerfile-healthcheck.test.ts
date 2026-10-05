import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static guard for the HEALTHCHECK flags of deploy-panel's own images
 * (tracker task 3b28a0b1). The flags are derived from the gate windows in
 * post-deploy-gate.ts (4 x 5s base window, ~60s with the pending extension)
 * and deploy-recovery.ts (5 x 12s strict window). Needs neither Docker nor a
 * database: it only parses the Dockerfiles.
 *
 * Docker starts the next probe one interval after the previous probe
 * COMPLETES, so a probe that hangs until its timeout costs interval + timeout.
 *
 * Inequalities (seconds):
 *   interval <= 5                                              first probe inside the base window
 *   start_period + retries * (interval + timeout) + timeout < 60  worst case (hung probe) unhealthy
 *                                                              resolves inside the combined window
 *   retries * interval >= 15                                   a short blip does not de-route the panel
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

const DOCKERFILES = ["backend/Dockerfile", "frontend/Dockerfile"] as const;
const FLAGS = ["interval", "timeout", "start-period", "retries"] as const;

function toSeconds(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(raw);
  if (!m) throw new Error(`unparseable duration/number: ${raw}`);
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms":
      return n / 1000;
    case "m":
      return n * 60;
    default:
      return n;
  }
}

/** Join Dockerfile backslash line continuations into single logical lines. */
function joinContinuations(text: string): string[] {
  return text.replace(/\\[ \t]*\r?\n/g, " ").split("\n");
}

function parseHealthcheckText(text: string, label: string): Record<string, string> {
  const lines = joinContinuations(text).filter((l) => /^\s*HEALTHCHECK\s/.test(l));
  expect(lines, `${label} must have exactly one HEALTHCHECK instruction`).toHaveLength(1);
  const head = lines[0].split(/\s+CMD\s/)[0];
  const flags: Record<string, string> = {};
  for (const m of head.matchAll(/--([a-z-]+)=(\S+)/g)) flags[m[1]] = m[2];
  return flags;
}

function parseHealthcheck(file: string): Record<string, string> {
  return parseHealthcheckText(readFileSync(path.join(repoRoot, file), "utf8"), file);
}

describe("parseHealthcheckText", () => {
  it("reads flags from a HEALTHCHECK split across backslash continuations", () => {
    const flags = parseHealthcheckText(
      [
        "FROM node:22",
        "HEALTHCHECK --interval=5s --timeout=3s \\",
        "  --start-period=15s \\",
        "  --retries=4 CMD true",
        "",
      ].join("\n"),
      "inline",
    );
    expect(flags).toEqual({ interval: "5s", timeout: "3s", "start-period": "15s", retries: "4" });
  });
});

describe.each(DOCKERFILES)("%s HEALTHCHECK", (file) => {
  const flags = parseHealthcheck(file);

  it("declares all four flags explicitly", () => {
    for (const name of FLAGS) {
      expect(flags[name], `${file} is missing --${name}`).toBeDefined();
    }
  });

  it("probes at most every 5s so the first probe lands inside the base window", () => {
    expect(toSeconds(flags["interval"])).toBeLessThanOrEqual(5);
  });

  it("resolves unhealthy inside the ~60s combined optimistic window even when every probe hangs", () => {
    const interval = toSeconds(flags["interval"]);
    const timeout = toSeconds(flags["timeout"]);
    const worstCase =
      toSeconds(flags["start-period"]) + toSeconds(flags["retries"]) * (interval + timeout) + timeout;
    expect(worstCase).toBeLessThan(60);
  });

  it("tolerates at least 15s of consecutive failures before reporting unhealthy", () => {
    expect(toSeconds(flags["retries"]) * toSeconds(flags["interval"])).toBeGreaterThanOrEqual(15);
  });
});
