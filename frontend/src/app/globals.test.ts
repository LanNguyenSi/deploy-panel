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
      expect(r).toContain("box-shadow: 0 0 0 3px var(--focus-ring)");
    }
    expect(rule(".select-native:focus")).toContain("box-shadow: 0 0 0 3px var(--focus-ring)");
    expect(rule(".btn:focus-visible")).toContain("outline: 2px solid var(--text)");
  });

  it("makes the focus ring itself at least 3:1 against the card background", () => {
    const ring = css.match(/--focus-ring:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/)!;
    const card = css.match(/--bg-iron:\s*#([0-9a-fA-F]{6})/)!;
    expect(ring && card).toBeTruthy();
    const bg = [0, 2, 4].map((i) => parseInt(card[1].slice(i, i + 2), 16));
    const alpha = Number(ring[4]);
    const fg = [1, 2, 3].map((i, k) => Number(ring[i]) * alpha + bg[k] * (1 - alpha));
    const lum = (c: number[]) => {
      const [r, g, b] = c.map((v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    expect((hi + 0.05) / (lo + 0.05)).toBeGreaterThanOrEqual(3);
  });

  it("marks the active sidebar link without an inset side bar", () => {
    expect(css).not.toMatch(/inset\s+\d+px\s+0\s+0/);
  });
});
