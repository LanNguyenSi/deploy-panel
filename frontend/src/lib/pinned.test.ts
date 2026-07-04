import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPinnedApps, isPinned, togglePin, type PinnedApp } from "./pinned";

const STORAGE_KEY = "deploy-panel:pinned-apps";

describe("getPinnedApps", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("returns [] when localStorage has no entry yet", () => {
    expect(getPinnedApps()).toEqual([]);
  });

  it("returns the parsed array when localStorage holds valid json", () => {
    const stored: PinnedApp[] = [{ serverId: "srv-1", serverName: "prod", appName: "my-app" }];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));

    expect(getPinnedApps()).toEqual(stored);
  });

  it("returns [] when localStorage holds malformed json", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not valid json");

    expect(getPinnedApps()).toEqual([]);
  });
});

describe("isPinned", () => {
  beforeEach(() => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ serverId: "srv-1", serverName: "prod", appName: "my-app" }]),
    );
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("returns true for a pinned (serverId, appName) pair", () => {
    expect(isPinned("srv-1", "my-app")).toBe(true);
  });

  it("returns false for a matching serverId but different appName", () => {
    expect(isPinned("srv-1", "other-app")).toBe(false);
  });

  it("returns false for a matching appName but different serverId", () => {
    expect(isPinned("srv-2", "my-app")).toBe(false);
  });
});

describe("togglePin", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("adds the app when it is not yet pinned, and persists the exact list to localStorage", () => {
    const result = togglePin("srv-1", "prod", "my-app");

    const expected: PinnedApp[] = [{ serverId: "srv-1", serverName: "prod", appName: "my-app" }];
    expect(result).toEqual(expected);
    // A wrong key, or writing the wrong shape, would silently break pin
    // persistence across reloads — assert the raw stored value.
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(expected));
  });

  it("removes the app when it is already pinned (toggle off)", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ serverId: "srv-1", serverName: "prod", appName: "my-app" }]),
    );

    const result = togglePin("srv-1", "prod", "my-app");

    expect(result).toEqual([]);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify([]));
  });

  it("only removes the matching (serverId, appName) pair, leaving other pins intact", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { serverId: "srv-1", serverName: "prod", appName: "my-app" },
        { serverId: "srv-1", serverName: "prod", appName: "other-app" },
      ]),
    );

    const result = togglePin("srv-1", "prod", "my-app");

    expect(result).toEqual([{ serverId: "srv-1", serverName: "prod", appName: "other-app" }]);
  });
});
