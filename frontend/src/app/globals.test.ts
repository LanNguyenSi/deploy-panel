import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "globals.css"), "utf8");

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `rule ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("globals.css", () => {
  it("defines no glow tokens and uses no glow shadow", () => {
    expect(css).not.toMatch(/--(primary-glow|shadow-glow|glow-primary)/);
  });

  it("keeps a visible keyboard focus indicator on inputs and buttons", () => {
    for (const sel of [".input:focus", ".input-native:focus"]) {
      const r = rule(sel);
      expect(r).toContain("border-color: var(--primary)");
      expect(r).toContain("box-shadow: 0 0 0 3px var(--primary-muted)");
    }
    expect(rule(".btn:focus-visible")).toContain("outline: 2px solid var(--text)");
  });

  it("marks the active sidebar link without an inset side bar", () => {
    expect(css).not.toMatch(/inset\s+\d+px\s+0\s+0/);
  });
});
