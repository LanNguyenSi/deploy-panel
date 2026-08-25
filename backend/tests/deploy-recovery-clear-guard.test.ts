import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Mechanical guard (fix-round review, agent-tasks 93bafd79, finding J5, made
 * comment-blind in a second fix round, agent-tasks 93bafd79, finding P2):
 * `clearActiveDeploys` drops every registration in the active-deploy
 * registry regardless of refcount (its own doc comment on the export in
 * deploy-recovery.ts calls it a "test-only isolation helper"). A single
 * production call to it would release every in-flight hold at once and
 * expose every currently-driven deploy to the periodic stuck-sweep, the
 * exact false-positive the registry exists to prevent (see
 * deploy-recovery.ts's module comment). Before this guard, only that
 * comment kept production code from calling it; nothing enforced the
 * boundary.
 *
 * This test walks backend/src (production code, not backend/tests, where
 * the isolation helper is legitimately used in beforeEach hooks), strips
 * comments out of each file first, and fails on either of two things
 * outside the export's own definition in deploy-recovery.ts: a CALL
 * (`clearActiveDeploys(`) or an IMPORT of the symbol from
 * deploy-recovery.js (a call needs the import first, so the import is the
 * earlier tripwire). Stripping comments first, and matching a call/import
 * shape rather than a bare substring, means a comment that merely mentions
 * the symbol by name (including in its own doc comment above the
 * definition) does not trip the guard.
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

/** Strips block and line comments so a mere mention in prose never matches. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const CALL_RE = /clearActiveDeploys\s*\(/g;
const DEFINITION_RE = /export function clearActiveDeploys\s*\(/;
const IMPORT_RE = /import\s*\{[^}]*\bclearActiveDeploys\b[^}]*\}\s*from\s*["'][^"']*deploy-recovery(\.js)?["']/g;

describe("clearActiveDeploys: production code never calls it", () => {
  it("is called or imported in backend/src only by its own definition in deploy-recovery.ts", () => {
    let definitionOccurrences = 0;
    const offenders: string[] = [];

    for (const file of walk(srcRoot)) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      const callMatches = stripped.match(CALL_RE) ?? [];
      const importMatches = stripped.match(IMPORT_RE) ?? [];

      if (file === definitionFile) {
        // The one expected call-shaped match is the `export function
        // clearActiveDeploys(` definition itself; anything beyond that is
        // a call from inside the same file, just as dangerous as a call
        // from any other module.
        definitionOccurrences = callMatches.length;
        if (importMatches.length > 0) {
          offenders.push(`${path.relative(repoRoot, file)} (${importMatches.length} self-import occurrence(s))`);
        }
        continue;
      }

      const total = callMatches.length + importMatches.length;
      if (total > 0) {
        offenders.push(
          `${path.relative(repoRoot, file)} (${callMatches.length} call(s), ${importMatches.length} import(s))`,
        );
      }
    }

    expect(
      offenders,
      `clearActiveDeploys called or imported in production code outside deploy-recovery.ts:\n${offenders.join("\n")}`,
    ).toEqual([]);
    // Exactly one call-shaped occurrence expected in deploy-recovery.ts:
    // the `export function clearActiveDeploys(` definition itself.
    expect(
      definitionOccurrences,
      "expected exactly one call-shaped occurrence (the export definition) of clearActiveDeploys in deploy-recovery.ts",
    ).toBe(1);
    expect(DEFINITION_RE.test(stripComments(readFileSync(definitionFile, "utf8")))).toBe(true);
  });
});
