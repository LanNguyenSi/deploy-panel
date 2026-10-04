// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = resolve(__dirname, "..");
const css = readFileSync(join(srcDir, "app", "fonts-extra.css"), "utf8");
const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);

describe("non-latin font subsets", () => {
  it("declares a unicode-ranged, swapped, vendored face per extra subset", () => {
    expect(faces).toHaveLength(12);
    for (const face of faces) {
      expect(face).toMatch(/font-family:\s*"(Sora|Inter|JetBrains Mono) Extra"/);
      expect(face).toMatch(/font-display:\s*swap/);
      expect(face).toMatch(/unicode-range:\s*U\+/);
      expect(face).toMatch(/font-weight:\s*100 \d00/);
      const url = /url\(\.\.\/fonts\/([^)]+\.woff2)\)/.exec(face);
      expect(url, face).not.toBeNull();
      expect(existsSync(join(srcDir, "fonts", url![1]))).toBe(true);
    }
  });

  it("covers latin-ext for every family and never re-declares latin", () => {
    for (const fam of ["sora", "inter", "jetbrains-mono"]) {
      expect(css).toContain(`${fam}-latin-ext-wght-normal.woff2`);
    }
    expect(css).not.toMatch(/-latin-wght-normal/);
  });

  it("font-family declarations use the -stack variables so extras precede the metric fallback", () => {
    const files = [
      ...readdirSync(join(srcDir, "app"), { recursive: true, encoding: "utf8" }),
      ...readdirSync(join(srcDir, "components"), { recursive: true, encoding: "utf8" }),
    ].filter((f) => /\.(css|tsx)$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const rel of files) {
      const path = existsSync(join(srcDir, "app", rel)) ? join(srcDir, "app", rel) : join(srcDir, "components", rel);
      const text = readFileSync(path, "utf8");
      const raw = text.match(/[fF]ont-?[fF]amily"?:\s*"?var\(--font-(display|sans|mono)[,)]/g);
      expect(raw, `${rel} uses a raw next/font variable in font-family`).toBeNull();
    }
  });
});
