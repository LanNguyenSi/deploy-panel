import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * BACKEND_URL fails closed in production with OAuth configured: the OAuth
 * start route sends `${BACKEND_URL}/api/auth/github/callback` to GitHub as
 * the redirect_uri (routes/auth.ts), so a production backend whose
 * GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are both non-empty and whose
 * BACKEND_URL host is localhost, 127.0.0.1 or [::1] must refuse startup with
 * the existing console.error + process.exit(1) pattern, naming BACKEND_URL
 * and the redirect_uri it would produce.
 *
 * Precedence: BOTH OAuth vars must be non-empty (one set and one
 * unset/empty counts as OAuth disabled, the routes answer 503 and no
 * redirect is ever produced, so no exit); a non-localhost host wins over
 * the OAuth vars being set; NODE_ENV other than production keeps the
 * localhost default; and the host comparison is exact, so a public host
 * that merely contains "localhost" is not refused.
 *
 * config/index.ts validates at import time, so each case re-imports the
 * module with a fresh env and a stubbed process.exit, mirroring
 * config-allowed-logins.test.ts. Production cases set a non-empty
 * ALLOWED_GITHUB_LOGINS so the allowlist guard passes and only this guard
 * can exit.
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
  exitCalled: boolean;
  exitCode?: number;
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
  let exitCode: number | undefined;
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCalled = true;
    exitCode = code;
    throw new Error(`process.exit(${code})`);
  }) as never);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const mod = await import("../src/config/index.js");
    return { config: mod.config as Record<string, unknown>, exitCalled, exitCode, errors };
  } catch {
    return { exitCalled, exitCode, errors };
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

const PROD_BASE = { NODE_ENV: "production", ALLOWED_GITHUB_LOGINS: "alice" };
const OAUTH = { GITHUB_CLIENT_ID: "client-id", GITHUB_CLIENT_SECRET: "client-secret" };

describe("config BACKEND_URL: production with OAuth configured fails closed on a localhost host", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    it(`NODE_ENV=production with OAuth set and BACKEND_URL=http://${host}:3001 exits 1 naming BACKEND_URL`, async () => {
      const { config, exitCalled, exitCode, errors } = await loadConfig({
        ...PROD_BASE,
        ...OAUTH,
        BACKEND_URL: `http://${host}:3001`,
      });
      expect(exitCalled).toBe(true);
      expect(exitCode).toBe(1);
      expect(config).toBeUndefined();
      const logged = JSON.stringify(errors.mock.calls);
      expect(logged).toContain("BACKEND_URL");
      expect(logged).toContain(`http://${host}:3001/api/auth/github/callback`);
    });
  }

  it("names the redirect_uri without a doubled slash when BACKEND_URL has a trailing slash", async () => {
    const { exitCalled, errors } = await loadConfig({
      ...PROD_BASE,
      ...OAUTH,
      BACKEND_URL: "http://localhost:3001/",
    });
    expect(exitCalled).toBe(true);
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).toContain("http://localhost:3001/api/auth/github/callback");
    expect(logged).not.toContain("3001//api");
  });

  it("the unset BACKEND_URL default (http://localhost:3001) exits too (that is the prod .env footgun)", async () => {
    const { exitCalled, errors } = await loadConfig({ ...PROD_BASE, ...OAUTH });
    expect(exitCalled).toBe(true);
    expect(JSON.stringify(errors.mock.calls)).toContain("BACKEND_URL");
  });
});

describe("config BACKEND_URL: production with OAuth configured starts on a non-localhost host", () => {
  for (const url of [
    "https://deploy-panel.opentriologue.ai",
    "http://panel.example.com:3001",
    "https://localhost.example.com",
    "https://notlocalhost.dev",
  ]) {
    it(`starts with BACKEND_URL=${url} (host match is exact, not substring)`, async () => {
      const { config, exitCalled, errors } = await loadConfig({
        ...PROD_BASE,
        ...OAUTH,
        BACKEND_URL: url,
      });
      expect(exitCalled).toBe(false);
      expect(config?.BACKEND_URL).toBe(url);
      expect(errors.mock.calls).toEqual([]);
    });
  }
});

describe("config BACKEND_URL: the localhost guard needs BOTH OAuth vars non-empty", () => {
  const localhost = { BACKEND_URL: "http://localhost:3001" };

  it("only GITHUB_CLIENT_ID set (secret unset) starts: OAuth is disabled, no redirect is sent", async () => {
    const { config, exitCalled, errors } = await loadConfig({
      ...PROD_BASE,
      GITHUB_CLIENT_ID: "client-id",
      ...localhost,
    });
    expect(exitCalled).toBe(false);
    expect(config?.BACKEND_URL).toBe("http://localhost:3001");
    expect(errors.mock.calls).toEqual([]);
  });

  it("only GITHUB_CLIENT_SECRET set (client ID unset) starts", async () => {
    const { exitCalled, errors } = await loadConfig({
      ...PROD_BASE,
      GITHUB_CLIENT_SECRET: "client-secret",
      ...localhost,
    });
    expect(exitCalled).toBe(false);
    expect(errors.mock.calls).toEqual([]);
  });

  it("both OAuth vars empty strings count as unset and start", async () => {
    const { exitCalled, errors } = await loadConfig({
      ...PROD_BASE,
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
      ...localhost,
    });
    expect(exitCalled).toBe(false);
    expect(errors.mock.calls).toEqual([]);
  });

  it("an empty GITHUB_CLIENT_SECRET next to a set client ID still starts (both must be non-empty)", async () => {
    const { exitCalled, errors } = await loadConfig({
      ...PROD_BASE,
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "",
      ...localhost,
    });
    expect(exitCalled).toBe(false);
    expect(errors.mock.calls).toEqual([]);
  });
});

describe("config BACKEND_URL: development and test keep the localhost default", () => {
  for (const nodeEnv of ["development", "test"]) {
    it(`NODE_ENV=${nodeEnv} with OAuth set and a localhost BACKEND_URL starts`, async () => {
      const { config, exitCalled, errors } = await loadConfig({
        NODE_ENV: nodeEnv,
        ...OAUTH,
        BACKEND_URL: "http://localhost:3001",
      });
      expect(exitCalled).toBe(false);
      expect(config?.NODE_ENV).toBe(nodeEnv);
      expect(errors.mock.calls).toEqual([]);
    });
  }

  it("unset NODE_ENV (zod default development) with OAuth set and a localhost BACKEND_URL starts", async () => {
    const { config, exitCalled } = await loadConfig({ ...OAUTH, BACKEND_URL: "http://localhost:3001" });
    expect(exitCalled).toBe(false);
    expect(config?.NODE_ENV).toBe("development");
  });
});
