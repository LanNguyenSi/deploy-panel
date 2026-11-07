import { describe, expect, it } from "vitest";
import { acquireInert, releaseInert } from "./inert";

// The shared ownership counter behind every `inert` writer on the app-shell
// regions (the confirm dialog and the Sidebar drawer both hold `.app-content`).
// Contract: an element stays inert until its LAST holder releases, a release
// from a holder that never acquired the element never un-inerts it, and an
// element already inert when acquired (markup or a React attribute owns it)
// is never un-inerted here.

describe("inert ownership counter", () => {
  it("keeps an element inert until the last holder releases", () => {
    const el = document.createElement("div");
    acquireInert(el);
    acquireInert(el);
    expect(el).toHaveAttribute("inert");
    releaseInert(el);
    expect(el).toHaveAttribute("inert");
    releaseInert(el);
    expect(el).not.toHaveAttribute("inert");
  });

  it("sets inert on the first acquire and again after a full release", () => {
    const el = document.createElement("div");
    expect(el).not.toHaveAttribute("inert");
    acquireInert(el);
    expect(el).toHaveAttribute("inert");
    releaseInert(el);
    acquireInert(el);
    expect(el).toHaveAttribute("inert");
    releaseInert(el);
    expect(el).not.toHaveAttribute("inert");
  });

  it("never un-inerts an element that was already inert when acquired", () => {
    const el = document.createElement("div");
    el.setAttribute("inert", "");
    acquireInert(el);
    releaseInert(el);
    expect(el).toHaveAttribute("inert");
    releaseInert(el);
    expect(el).toHaveAttribute("inert");
  });

  it("release on an element this helper never acquired leaves it alone", () => {
    const markupInert = document.createElement("div");
    markupInert.setAttribute("inert", "");
    releaseInert(markupInert);
    expect(markupInert).toHaveAttribute("inert");

    const plain = document.createElement("div");
    releaseInert(plain);
    expect(plain).not.toHaveAttribute("inert");
  });

  it("counts each element independently", () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    acquireInert(a);
    acquireInert(b);
    acquireInert(b);
    releaseInert(a);
    expect(a).not.toHaveAttribute("inert");
    expect(b).toHaveAttribute("inert");
    releaseInert(b);
    expect(b).toHaveAttribute("inert");
    releaseInert(b);
    expect(b).not.toHaveAttribute("inert");
  });
});
