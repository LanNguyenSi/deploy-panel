// @vitest-environment node
// (This file only reads sources from disk; the node environment also keeps
// import.meta.url a file: URL, which jsdom does not guarantee.)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PREFLIGHT_CHECK_KIND } from "./DeploySteps";

// Contract pin: DeploySteps recognises preflight-blocked deploys by the step
// marker (`step.kind`) the backend writes. The frontend has no shared code
// with the backend, so this literal must stay byte-equal to
// PREFLIGHT_CHECK_KIND in backend/src/lib/deploy-log.ts: if either side
// renames it on its own, the "Blocked (preflight)" label and the interrupted
// filter silently stop matching. The backend literal is parsed from source
// with a regex (the backend package is not importable from here), the way the
// backend's own source-guard tests do it, see
// backend/tests/env-loading-guard.test.ts.

const literalOf = (source: string, label: string): string => {
  const m = source.match(/const PREFLIGHT_CHECK_KIND = "([^"]*)";/);
  expect(m, `${label}: PREFLIGHT_CHECK_KIND literal not found`).not.toBeNull();
  return (m as RegExpMatchArray)[1];
};

describe("preflight-check marker contract", () => {
  it("the DeploySteps literal equals the backend PREFLIGHT_CHECK_KIND literal", () => {
    const backend = literalOf(
      readFileSync(new URL("../../../backend/src/lib/deploy-log.ts", import.meta.url), "utf8"),
      "backend/src/lib/deploy-log.ts",
    );
    expect(PREFLIGHT_CHECK_KIND).toBe(backend);
  });
});
