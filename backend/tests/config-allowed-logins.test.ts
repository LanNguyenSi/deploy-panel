import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ALLOWED_GITHUB_LOGINS fails closed in production: NODE_ENV=production with
 * an allowlist that parses to an empty list (unset, empty, only spaces, only
 * commas) must refuse startup with the existing console.error + process.exit(1)
 * pattern, naming ALLOWED_GITHUB_LOGINS. A non-empty parse starts, and
 * development, test and the unset default keep the back-compat behaviour
 * (empty list = any verified login, no exit).
 *
 * config/index.ts validates at import time, so each case re-imports the
 * module with a fresh env and a stubbed process.exit, mirroring
 * config-formats-defaults.test.ts.
 */

const ENV_KEYS = [
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
];

interface Loaded {
  config?: Record<string, unknown>;
  logins?: string[];
  exitCalled: boolean;
  errors: { mock: { calls: unknown[][] } };
}

async function loadConfig(env: Record<string, string>): Promise<Loaded> {
  vi.resetModules();
  vi.unstubAllEnvs();
  const saved = { ...process.env };
  for (const key of ENV_KEYS) {
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
    return {
      config: mod.config as Record<string, unknown>,
      logins: mod.allowedGitHubLogins as string[],
      exitCalled,
      errors,
    };
  } catch {
    return { exitCalled, errors };
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

const EMPTY_VALUES: [string, string | undefined][] = [
  ["unset", undefined],
  ['""', ""],
  ['" "', " "],
  ['","', ","],
  ['" , ,"', " , ,"],
  ['",,"', ",,"],
];

describe("config ALLOWED_GITHUB_LOGINS: production fails closed on an empty list", () => {
  for (const [label, value] of EMPTY_VALUES) {
    it(`NODE_ENV=production with ${label} exits non-zero and names ALLOWED_GITHUB_LOGINS`, async () => {
      const env: Record<string, string> = { NODE_ENV: "production" };
      if (value !== undefined) env.ALLOWED_GITHUB_LOGINS = value;
      const { config, exitCalled, errors } = await loadConfig(env);
      expect(exitCalled).toBe(true);
      expect(config).toBeUndefined();
      expect(JSON.stringify(errors.mock.calls)).toContain("ALLOWED_GITHUB_LOGINS");
    });
  }
});

describe("config ALLOWED_GITHUB_LOGINS: production starts with a non-empty list", () => {
  it("starts with \"alice\" and parses [alice]", async () => {
    const { config, logins, exitCalled } = await loadConfig({
      NODE_ENV: "production",
      ALLOWED_GITHUB_LOGINS: "alice",
    });
    expect(exitCalled).toBe(false);
    expect(logins).toEqual(["alice"]);
    expect(config?.NODE_ENV).toBe("production");
  });

  it("starts with \"alice,\" (trailing comma) and parses [alice]", async () => {
    const { config, logins, exitCalled } = await loadConfig({
      NODE_ENV: "production",
      ALLOWED_GITHUB_LOGINS: "alice,",
    });
    expect(exitCalled).toBe(false);
    expect(logins).toEqual(["alice"]);
    expect(config?.NODE_ENV).toBe("production");
  });

  it("starts with \" alice , bob \" and parses [alice, bob] (trimmed, order kept)", async () => {
    const { config, logins, exitCalled } = await loadConfig({
      NODE_ENV: "production",
      ALLOWED_GITHUB_LOGINS: " alice , bob ",
    });
    expect(exitCalled).toBe(false);
    expect(logins).toEqual(["alice", "bob"]);
    expect(config?.NODE_ENV).toBe("production");
  });
});

describe("config ALLOWED_GITHUB_LOGINS: development and test are unchanged", () => {
  for (const nodeEnv of ["development", "test"]) {
    for (const [label, value] of EMPTY_VALUES) {
      it(`NODE_ENV=${nodeEnv} with ${label} starts with an empty list (any verified login)`, async () => {
        const env: Record<string, string> = { NODE_ENV: nodeEnv };
        if (value !== undefined) env.ALLOWED_GITHUB_LOGINS = value;
        const { config, logins, exitCalled } = await loadConfig(env);
        expect(exitCalled).toBe(false);
        expect(logins).toEqual([]);
        expect(config?.NODE_ENV).toBe(nodeEnv);
      });
    }

    it(`NODE_ENV=${nodeEnv} still parses a non-empty list`, async () => {
      const { config, logins, exitCalled } = await loadConfig({
        NODE_ENV: nodeEnv,
        ALLOWED_GITHUB_LOGINS: " alice , bob ",
      });
      expect(exitCalled).toBe(false);
      expect(logins).toEqual(["alice", "bob"]);
    });
  }
});

describe("config ALLOWED_GITHUB_LOGINS: unset NODE_ENV behaves as development", () => {
  it("starts with an empty list and no exit (zod default development)", async () => {
    const { config, logins, exitCalled } = await loadConfig({});
    expect(exitCalled).toBe(false);
    expect(config?.NODE_ENV).toBe("development");
    expect(logins).toEqual([]);
  });

  it("starts with \"alice\" and parses [alice]", async () => {
    const { logins, exitCalled } = await loadConfig({ ALLOWED_GITHUB_LOGINS: "alice" });
    expect(exitCalled).toBe(false);
    expect(logins).toEqual(["alice"]);
  });
});
