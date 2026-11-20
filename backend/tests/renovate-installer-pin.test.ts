import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { INSTALL_SCRIPT_URL } from "../src/services/install-relay.js";

// The relay installer URL is pinned to a tag. Renovate can only propose a
// bump while its regex manager still matches the constant, so this test
// keeps the two from drifting apart silently.

const repoRoot = resolve(__dirname, "..", "..");
const SOURCE_PATH = "backend/src/services/install-relay.ts";

interface RegexManager {
  customType?: string;
  managerFilePatterns?: string[];
  matchStrings?: string[];
  datasourceTemplate?: string;
  depNameTemplate?: string;
}

function loadManager(): RegexManager {
  const config = JSON.parse(readFileSync(resolve(repoRoot, "renovate.json"), "utf8")) as {
    customManagers?: RegexManager[];
  };
  const managers = (config.customManagers ?? []).filter(
    (m) => m.customType === "regex" && m.depNameTemplate === "LanNguyenSi/agent-relay",
  );
  expect(managers).toHaveLength(1);
  return managers[0];
}

/** Renovate strips a leading and trailing slash from a `/.../` pattern. */
function patternToRegExp(pattern: string): RegExp {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
  return m ? new RegExp(m[1], m[2]) : new RegExp(pattern);
}

describe("renovate regex manager for the relay installer pin", () => {
  let manager: RegexManager;

  beforeAll(() => {
    manager = loadManager();
  });

  it("targets exactly the install-relay source file and the github-tags datasource", () => {
    expect(manager.managerFilePatterns).toHaveLength(1);
    const filePattern = patternToRegExp(manager.managerFilePatterns![0]);
    expect(filePattern.test(SOURCE_PATH)).toBe(true);
    expect(filePattern.test("backend/src/services/install-relay.test.ts")).toBe(false);
    expect(filePattern.test("backend/src/services/other.ts")).toBe(false);
    // Anchored: a path that merely ends in or contains the file name is not it.
    expect(filePattern.test("x/backend/src/services/install-relay.ts")).toBe(false);
    expect(filePattern.test("frontend/src/install-relay.ts")).toBe(false);
    expect(manager.datasourceTemplate).toBe("github-tags");
  });

  it("matches the source file exactly once and captures the tag of the constant", () => {
    expect(manager.matchStrings).toBeDefined();
    expect(manager.matchStrings!.length).toBeGreaterThanOrEqual(1);
    const source = readFileSync(resolve(repoRoot, SOURCE_PATH), "utf8");
    const base = patternToRegExp(manager.matchStrings![0]);
    const re = new RegExp(base.source, base.flags.includes("g") ? base.flags : `${base.flags}g`);
    const matches = [...source.matchAll(re)];
    expect(matches).toHaveLength(1);
    const currentValue = matches[0].groups?.currentValue;
    expect(currentValue).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(INSTALL_SCRIPT_URL).toContain(`/refs/tags/${currentValue}/install.sh`);
  });

  it("does not match a branch URL, a short-form URL or a non-version ref under refs/tags", () => {
    const base = patternToRegExp(manager.matchStrings![0]);
    const prefix = "https://raw.githubusercontent.com/LanNguyenSi/agent-relay";
    const notPins = [
      `${prefix}/main/install.sh`,
      `${prefix}/refs/heads/main/install.sh`,
      // Without refs/tags a branch named like the tag could shadow the tag.
      `${prefix}/v0.9.0/install.sh`,
      `${prefix}/refs/tags/main/install.sh`,
      `${prefix}/refs/tags/latest/install.sh`,
      `${prefix}/refs/tags/v0.9/install.sh`,
    ];
    for (const url of notPins) {
      expect(base.test(`"${url}"`), url).toBe(false);
    }
  });
});
