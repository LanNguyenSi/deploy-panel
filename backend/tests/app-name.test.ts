import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_NAME_PATTERN, isValidAppName } from "../src/lib/app-name.js";

// Names the scheduler and the relay URL builders must accept.
const VALID = ["my-app", "my.app", "My_App.2", "a", "9lives", "app.env"];
// Names that could escape a path segment once interpolated into a relay
// URL or an app row path, or that would need percent-encoding.
const INVALID = ["", "../x", "a/b", ".hidden", "-start", "_start", "a b", "a%2Fb", "a\\b", 'a"b', "app\nname", ".."];

describe("isValidAppName (shared app-name guard used by v1.ts and scheduled.ts)", () => {
  it.each(VALID)("accepts %j", (name) => {
    expect(isValidAppName(name)).toBe(true);
    expect(APP_NAME_PATTERN.test(name)).toBe(true);
  });

  it.each(INVALID)("rejects %j", (name) => {
    expect(isValidAppName(name)).toBe(false);
    expect(APP_NAME_PATTERN.test(name)).toBe(false);
  });
});

// Pins that routes/v1.ts really consumes the shared module: the pattern
// used to be a local const there, and a second declaration would silently
// re-open the divergence this helper exists to prevent.
describe("routes/v1.ts consumes the shared app-name module", () => {
  const src = readFileSync(new URL("../src/routes/v1.ts", import.meta.url), "utf8");

  it("imports APP_NAME_PATTERN from lib/app-name.js", () => {
    expect(src).toContain('import { APP_NAME_PATTERN } from "../lib/app-name.js";');
  });

  it("no longer declares its own APP_NAME_PATTERN", () => {
    expect(src).not.toMatch(/const APP_NAME_PATTERN/);
  });
});
