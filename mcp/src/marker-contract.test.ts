import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Contract pin: the MCP deploy projection recognises preflight-blocked deploys
// by the step marker (`step.kind`) the backend writes. This package is
// standalone, no shared code with the panel backend, so the literal in
// tools.ts must stay byte-equal to PREFLIGHT_CHECK_KIND in
// backend/src/lib/deploy-log.ts: if either side renames it on its own, the
// projection silently stops folding failed checks and reports a blocked
// deploy as a plain failure. Both literals are read from source (the tools.ts
// one is not exported; the backend one is parsed with a regex, the way the
// backend's own source-guard tests do it, see backend/tests/
// env-loading-guard.test.ts).

const literalOf = (source: string, label: string): string => {
  const m = source.match(/const PREFLIGHT_CHECK_KIND = "([^"]*)";/);
  expect(m, `${label}: PREFLIGHT_CHECK_KIND literal not found`).not.toBeNull();
  return (m as RegExpMatchArray)[1];
};

describe("preflight-check marker contract", () => {
  it("the tools.ts literal equals the backend PREFLIGHT_CHECK_KIND literal", () => {
    const backend = literalOf(
      readFileSync(new URL("../../backend/src/lib/deploy-log.ts", import.meta.url), "utf8"),
      "backend/src/lib/deploy-log.ts",
    );
    const consumer = literalOf(
      readFileSync(new URL("./tools.ts", import.meta.url), "utf8"),
      "mcp/src/tools.ts",
    );
    expect(consumer).toBe(backend);
  });
});
