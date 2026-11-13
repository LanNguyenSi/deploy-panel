import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TRUSTED_RELAY_SERVER_IDS is a comma-separated list of server ids, parsed
 * once at import time into a trimmed array without empty entries. Unset and
 * empty both mean "no server is trusted".
 */

async function loadConfig(value: string | undefined) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", "test");
  if (value === undefined) delete process.env.TRUSTED_RELAY_SERVER_IDS;
  else vi.stubEnv("TRUSTED_RELAY_SERVER_IDS", value);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const mod = await import("../src/config/index.js");
  return mod.config.TRUSTED_RELAY_SERVER_IDS;
}

describe("config: TRUSTED_RELAY_SERVER_IDS", () => {
  const original = process.env.TRUSTED_RELAY_SERVER_IDS;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (original === undefined) delete process.env.TRUSTED_RELAY_SERVER_IDS;
    else process.env.TRUSTED_RELAY_SERVER_IDS = original;
  });

  it("is an empty list when absent", async () => {
    expect(await loadConfig(undefined)).toEqual([]);
  });

  it("is an empty list when set to the empty string", async () => {
    expect(await loadConfig("")).toEqual([]);
  });

  it("is an empty list for only spaces and commas", async () => {
    expect(await loadConfig(" , ,, ")).toEqual([]);
  });

  it("parses a single id", async () => {
    expect(await loadConfig("srv-a")).toEqual(["srv-a"]);
  });

  it("parses several ids, trimming spaces and dropping empty entries", async () => {
    expect(await loadConfig(" srv-a , srv-b,,srv-c ,")).toEqual(["srv-a", "srv-b", "srv-c"]);
  });

  it("keeps the case of an id (ids are opaque, not logins)", async () => {
    expect(await loadConfig("Srv-A")).toEqual(["Srv-A"]);
  });
});
