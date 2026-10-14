import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SESSION_SECRET is reserved (nothing reads it), so startup must not require
 * it. A value that is set still has to be at least 16 characters; an empty
 * value counts as unset because compose forwards an unset host variable as "".
 *
 * config/index.ts validates at import time and calls process.exit(1) on
 * failure, so each case re-imports the module with a fresh env and a stubbed
 * process.exit.
 */

async function loadConfig(sessionSecret: string | undefined, panelToken?: string) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", "test");
  if (panelToken === undefined) delete process.env.PANEL_TOKEN;
  else vi.stubEnv("PANEL_TOKEN", panelToken);
  if (sessionSecret === undefined) {
    delete process.env.SESSION_SECRET;
  } else {
    vi.stubEnv("SESSION_SECRET", sessionSecret);
  }
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const mod = await import("../src/config/index.js");
    return { config: mod.config, exitCalled: exit.mock.calls.length > 0, errors };
  } catch (err) {
    return { config: undefined, exitCalled: exit.mock.calls.length > 0, errors, err };
  }
}

describe("config: SESSION_SECRET is optional", () => {
  const original = process.env.SESSION_SECRET;
  const originalPanelToken = process.env.PANEL_TOKEN;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (original === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = original;
    if (originalPanelToken === undefined) delete process.env.PANEL_TOKEN;
    else process.env.PANEL_TOKEN = originalPanelToken;
  });

  it("starts without SESSION_SECRET", async () => {
    const { config, exitCalled } = await loadConfig(undefined);
    expect(exitCalled).toBe(false);
    expect(config?.SESSION_SECRET).toBeUndefined();
  });

  it("treats an empty SESSION_SECRET as unset", async () => {
    const { config, exitCalled } = await loadConfig("");
    expect(exitCalled).toBe(false);
    expect(config?.SESSION_SECRET).toBeUndefined();
  });

  it("rejects a SESSION_SECRET shorter than 16 characters", async () => {
    const { config, exitCalled, errors } = await loadConfig("too-short-15chr");
    expect(exitCalled).toBe(true);
    expect(config).toBeUndefined();
    expect(JSON.stringify(errors.mock.calls)).toContain("SESSION_SECRET");
  });

  it("accepts a SESSION_SECRET of 16 or more characters", async () => {
    const { config, exitCalled } = await loadConfig("exactly-16-chars");
    expect(exitCalled).toBe(false);
    expect(config?.SESSION_SECRET).toBe("exactly-16-chars");
  });

  it("treats an empty PANEL_TOKEN as unset, as compose forwards an unset host variable as an empty string", async () => {
    const { config, exitCalled } = await loadConfig(undefined, "");
    expect(exitCalled).toBe(false);
    expect(config?.PANEL_TOKEN).toBeUndefined();
  });

  it("keeps a non-empty PANEL_TOKEN", async () => {
    const { config, exitCalled } = await loadConfig(undefined, "panel-token-value");
    expect(exitCalled).toBe(false);
    expect(config?.PANEL_TOKEN).toBe("panel-token-value");
  });
});
