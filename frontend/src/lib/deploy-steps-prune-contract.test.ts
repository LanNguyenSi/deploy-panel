// @vitest-environment node
// (This file only reads the backend source from disk; the node environment also
// keeps import.meta.url a file: URL, which jsdom does not guarantee.)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILD_CACHE_PRUNE_STEP_NAME } from "./status";

// Contract pin: the backend ignores a streamed step with this name when deciding
// success after a lost stream (BUILD_CACHE_PRUNE_STEP_NAME in
// backend/src/lib/deploy-recovery.ts), and the frontend renders that same step as
// best effort (BUILD_CACHE_PRUNE_STEP_NAME in ./status.ts). The frontend has no
// shared code with the backend, so the two literals must stay byte-equal: if one
// side renames it alone, a failed prune would keep showing as a red failure in
// the UI while the backend still recovers the deploy as success (or vice versa).
// The backend literal is parsed from source with a regex (the backend package is
// not importable from here), the way preflight-marker-contract.test.ts pins the
// preflight marker.

const literalOf = (source: string, label: string): string => {
  const m = source.match(/const BUILD_CACHE_PRUNE_STEP_NAME = "([^"]*)";/);
  expect(m, `${label}: BUILD_CACHE_PRUNE_STEP_NAME literal not found`).not.toBeNull();
  return (m as RegExpMatchArray)[1];
};

describe("build cache prune step-name contract", () => {
  it("the frontend literal equals the backend BUILD_CACHE_PRUNE_STEP_NAME literal", () => {
    const backend = literalOf(
      readFileSync(new URL("../../../backend/src/lib/deploy-recovery.ts", import.meta.url), "utf8"),
      "backend/src/lib/deploy-recovery.ts",
    );
    expect(BUILD_CACHE_PRUNE_STEP_NAME).toBe(backend);
  });
});
