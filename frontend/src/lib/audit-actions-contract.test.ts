// @vitest-environment node
// (This file only reads the backend source from disk; the node environment also
// keeps import.meta.url a file: URL, which jsdom does not guarantee.)
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS } from "./audit-actions";

// Contract pin: the audit log page filters and labels rows by AUDIT_ACTIONS,
// and every row is written by the one backend writer audit() in
// backend/src/lib/audit.ts. The frontend cannot import the backend, so the
// emitted actions are read from source: the string literal first argument of
// every audit(...) call under backend/src (test files skipped). An action the
// backend emits but AUDIT_ACTIONS lacks would show as a raw string without a
// filter entry; an AUDIT_ACTIONS entry no backend call emits is a dead filter.

const BACKEND_SRC = new URL("../../../backend/src/", import.meta.url);

function sourceFiles(dir: URL): URL[] {
  const out: URL[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...sourceFiles(new URL(`${entry.name}/`, dir)));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(new URL(entry.name, dir));
  }
  return out;
}

const CALL = /(?<!function\s)\baudit\s*\(/g;
const LITERAL_CALL = /(?<!function\s)\baudit\s*\(\s*"([^"\\]*)"/g;

function scan() {
  let calls = 0;
  const literals: string[] = [];
  for (const file of sourceFiles(BACKEND_SRC)) {
    const text = readFileSync(file, "utf8");
    calls += text.match(CALL)?.length ?? 0;
    for (const m of text.matchAll(LITERAL_CALL)) literals.push(m[1]);
  }
  return { calls, literals };
}

describe("audit action contract", () => {
  const { calls, literals } = scan();
  const emitted = new Set(literals);
  const known = new Set(AUDIT_ACTIONS.map((a) => a.value));

  it("finds the backend call sites (the scan is not vacuous)", () => {
    expect(calls).toBeGreaterThan(0);
  });

  it("every audit() call passes a string literal as the action", () => {
    expect(literals.length, "an audit() call with a non-literal first argument cannot be pinned").toBe(calls);
  });

  it("AUDIT_ACTIONS values are unique", () => {
    expect(known.size).toBe(AUDIT_ACTIONS.length);
  });

  it("every action the backend emits is listed in AUDIT_ACTIONS", () => {
    expect([...emitted].filter((a) => !known.has(a)).sort()).toEqual([]);
  });

  it("every AUDIT_ACTIONS entry is emitted by the backend", () => {
    expect([...known].filter((a) => !emitted.has(a)).sort()).toEqual([]);
  });
});
