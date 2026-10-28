import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyStateIcon, type EmptyStateIconName } from "./EmptyStateIcon";

const NAMES: EmptyStateIconName[] = ["deploy", "server", "calendar", "audit", "package"];

describe("EmptyStateIcon", () => {
  it.each(NAMES)("renders %s as a decorative stroke svg without text", (name) => {
    const { container } = render(<EmptyStateIcon name={name} />);
    const wrapper = container.querySelector(".empty-state-icon");
    expect(wrapper).not.toBeNull();
    expect(wrapper?.textContent).toBe("");
    const svg = wrapper?.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("stroke")).toBe("currentColor");
    expect(svg?.querySelectorAll("path, rect, circle").length).toBeGreaterThan(0);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry) ? [full] : [];
  });
}

describe("empty-state icons in the app", () => {
  it("only the EmptyStateIcon component writes the empty-state-icon class, so no page can bring an emoji back", () => {
    const root = join(__dirname, "..");
    const offenders = sourceFiles(root).filter(
      (f) => !f.endsWith("EmptyStateIcon.tsx") && readFileSync(f, "utf8").includes("empty-state-icon"),
    );
    expect(offenders).toEqual([]);
  });
});
