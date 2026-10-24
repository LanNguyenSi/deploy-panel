import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Config schema pins for the zod 3 -> 4 migration (src/config/index.ts):
 * the BACKEND_URL url format (accept set AND unnormalized output value),
 * the coerce/enum defaults, and the information preserved by the
 * flatten().fieldErrors startup message. Each case re-imports the module
 * with a fresh env, mirroring config-session-secret.test.ts.
 */

async function loadConfig(env: Record<string, string>) {
  vi.resetModules();
  vi.unstubAllEnvs();
  const saved = { ...process.env };
  for (const key of [
    "PORT",
    "SESSION_SECRET",
    "CORS_ORIGINS",
    "FRONTEND_URL",
    "NODE_ENV",
    "PANEL_TOKEN",
    "ALLOWED_GITHUB_LOGINS",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "BACKEND_URL",
    "APP_SECRETS_KEY",
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  let exitCalled = false;
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCalled = true;
    throw new Error(`process.exit(${code})`);
  }) as never);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const mod = await import("../src/config/index.js");
    return { config: mod.config as Record<string, unknown>, exitCalled, errors };
  } catch {
    return { config: undefined, exitCalled, errors };
  } finally {
    exit.mockRestore();
    Object.keys(process.env).forEach((k) => {
      if (!(k in saved)) delete process.env[k];
    });
    Object.assign(process.env, saved);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("config BACKEND_URL: z.string().url().default(...) pins", () => {
  it("defaults to http://localhost:3001 when unset", async () => {
    const { config, exitCalled } = await loadConfig({});
    expect(exitCalled).toBe(false);
    expect(config?.BACKEND_URL).toBe("http://localhost:3001");
  });

  it("accepts an https URL and keeps the value unnormalized", async () => {
    const { config, exitCalled } = await loadConfig({ BACKEND_URL: "https://panel.example.com" });
    expect(exitCalled).toBe(false);
    expect(config?.BACKEND_URL).toBe("https://panel.example.com");
  });

  it("accepts a trailing slash unchanged (v3 parity)", async () => {
    const { config } = await loadConfig({ BACKEND_URL: "https://panel.example.com/" });
    expect(config?.BACKEND_URL).toBe("https://panel.example.com/");
  });

  it("accepts a non-http scheme (v3 parity: the v3 regex accepted it, so must v4)", async () => {
    const { config, exitCalled } = await loadConfig({ BACKEND_URL: "mailto:ops@example.com" });
    expect(exitCalled).toBe(false);
    expect(config?.BACKEND_URL).toBe("mailto:ops@example.com");
  });

  it("rejects a protocol-less host and names BACKEND_URL in the startup error", async () => {
    const { exitCalled, errors } = await loadConfig({ BACKEND_URL: "panel.example.com" });
    expect(exitCalled).toBe(true);
    const printed = JSON.stringify(errors.mock.calls);
    expect(printed).toContain("BACKEND_URL");
    expect(printed).toContain("Invalid URL");
  });

  it("rejects a URL with an embedded space (v3 parity)", async () => {
    const { exitCalled } = await loadConfig({ BACKEND_URL: "http://exa mple.com" });
    expect(exitCalled).toBe(true);
  });
});

describe("config defaults and coercion pins", () => {
  it("PORT defaults to 3001 when unset", async () => {
    const { config } = await loadConfig({});
    expect(config?.PORT).toBe(3001);
  });

  it("PORT coerces a numeric string to a number", async () => {
    const { config } = await loadConfig({ PORT: "8080" });
    expect(config?.PORT).toBe(8080);
  });

  it("rejects a garbage PORT and names it in the startup error", async () => {
    const { exitCalled, errors } = await loadConfig({ PORT: "abc" });
    expect(exitCalled).toBe(true);
    expect(JSON.stringify(errors.mock.calls)).toContain("PORT");
  });

  it("NODE_ENV passes through the test value (enum unchanged)", async () => {
    const { config } = await loadConfig({ NODE_ENV: "test" });
    expect(config?.NODE_ENV).toBe("test");
  });

  it("empty-string defaults (CORS_ORIGINS, FRONTEND_URL, ALLOWED_GITHUB_LOGINS, GitHub ids) are applied verbatim", async () => {
    const { config, exitCalled } = await loadConfig({});
    expect(exitCalled).toBe(false);
    expect(config?.CORS_ORIGINS).toBe("http://localhost:3000");
    expect(config?.FRONTEND_URL).toBe("http://localhost:3000");
    expect(config?.ALLOWED_GITHUB_LOGINS).toBe("");
    expect(config?.GITHUB_CLIENT_ID).toBe("");
    expect(config?.GITHUB_CLIENT_SECRET).toBe("");
  });

  it("SESSION_SECRET preprocess still maps an empty string to unset and keeps a 16+ char value", async () => {
    const empty = await loadConfig({ SESSION_SECRET: "" });
    expect(empty.exitCalled).toBe(false);
    expect(empty.config?.SESSION_SECRET).toBeUndefined();
    const set = await loadConfig({ SESSION_SECRET: "exactly-16-chars" });
    expect(set.config?.SESSION_SECRET).toBe("exactly-16-chars");
  });
});
