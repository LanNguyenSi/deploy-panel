import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Mechanical guard (fix-round review, agent-tasks 93bafd79, finding J5):
 * `clearActiveDeploys` drops every registration in the active-deploy
 * registry regardless of refcount (its own doc comment on the export in
 * deploy-recovery.ts calls it a "test-only isolation helper"). A single
 * production call to it would release every in-flight hold at once and
 * expose every currently-driven deploy to the periodic stuck-sweep — the
 * exact false-positive the registry exists to prevent (see
 * deploy-recovery.ts's module comment). Before this guard, only that
 * comment kept production code from calling it; nothing enforced the
 * boundary. This test walks backend/src (production code, not
 * backend/tests, where the isolation helper is legitimately used in
 * beforeEach hooks) and fails if `clearActiveDeploys` is referenced
 * anywhere other than its own `export function` definition in
 * deploy-recovery.ts.
 */

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const srcRoot = path.join(repoRoot, "backend/src");
const definitionFile = path.join(srcRoot, "lib", "deploy-recovery.ts");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("clearActiveDeploys: production code never calls it", () => {
  it("is referenced in backend/src only by its own definition in deploy-recovery.ts", () => {
    let definitionOccurrences = 0;
    const offenders: string[] = [];

    for (const file of walk(srcRoot)) {
      const matches = readFileSync(file, "utf8").match(/clearActiveDeploys/g);
      if (!matches) continue;
      if (file === definitionFile) {
        definitionOccurrences = matches.length;
        continue;
      }
      offenders.push(`${path.relative(repoRoot, file)} (${matches.length} occurrence(s))`);
    }

    expect(
      offenders,
      `clearActiveDeploys referenced in production code outside deploy-recovery.ts:\n${offenders.join("\n")}`,
    ).toEqual([]);
    // Exactly one occurrence expected: the `export function
    // clearActiveDeploys(` definition itself. Anything higher means
    // production code inside the SAME file now calls it too, which is just
    // as dangerous as a call from any other module.
    expect(
      definitionOccurrences,
      "expected exactly one occurrence (the export definition) of clearActiveDeploys in deploy-recovery.ts",
    ).toBe(1);
  });
});
