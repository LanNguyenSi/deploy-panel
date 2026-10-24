import { describe, expect, it, vi } from "vitest";

/**
 * Wire-body pins for the shared zValidator hook (src/lib/validator.ts).
 *
 * These pin the ENCODED 400 bodies (parsed from response text, not the
 * in-memory object) at every validatedJson site. Under zod 3 the default
 * @hono/zod-validator hook serialised the ZodError with an enumerable
 * `issues` array; under zod 4 `issues` is non-enumerable, so the shared
 * hook must keep producing the base body shape
 * `{ success: false, error: { issues: [{ code, path, message }], name } }`
 * with status 400, or the shape silently degrades to `{ name, message }`.
 *
 * The exact texts/codes below are the zod 4 renderings captured after the
 * migration; the base (zod 3) bodies differed only in zod's own issue text
 * (and the `expected`/`received`/`validation` extras the hook now drops by
 * design so `input` can never leak).
 */

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../src/config/index.js", () => ({
  config: {
    NODE_ENV: "test",
    PANEL_TOKEN: "panel-token-must-be-16chars",
    SESSION_SECRET: "session-secret-must-be-16chars",
    CORS_ORIGINS: "http://localhost:3000",
    FRONTEND_URL: "http://localhost:3000",
    BACKEND_URL: "http://localhost:3001",
    PORT: 3001,
    ALLOWED_GITHUB_LOGINS: "",
  },
  allowedGitHubLogins: [],
  hasGitHubOAuthConfigured: false,
}));

import { Hono } from "hono";
import { authRouter } from "../src/routes/auth.js";
import { serversRouter } from "../src/routes/servers.js";

type ActorVars = { Variables: { userId?: string; isAdmin?: boolean; authType?: string } };

function app() {
  const a = new Hono<ActorVars>();
  a.use("/*", async (c, next) => {
    c.set("isAdmin", true);
    await next();
  });
  a.route("/api/auth", authRouter);
  a.route("/api/servers", serversRouter as unknown as Hono<ActorVars>);
  return a;
}

const jsonReq = (body: unknown, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function expectBaseFailure(
  res: Response,
  expectedIssues: Array<{ code: string; path: string[]; message: string }>,
) {
  // Parse the ENCODED body: this is the regression point for zod 4's
  // non-enumerable `issues`.
  const text = await res.text();
  expect(res.status).toBe(400);
  const body = JSON.parse(text) as {
    success: boolean;
    error: { issues: unknown; name: string };
  };
  expect(Object.keys(body).sort()).toEqual(["error", "success"]);
  expect(body.success).toBe(false);
  expect(Object.keys(body.error).sort()).toEqual(["issues", "name"]);
  expect(body.error.name).toBe("ZodError");
  expect(body.error.issues).toEqual(expectedIssues);
  expect(JSON.parse(text)).toBeTruthy();
  return body;
}

describe("POST /api/auth/login (validatedJson 400 body)", () => {
  it("missing token: exact encoded body, code/path/name preserved", async () => {
    const res = await app().request("/api/auth/login", jsonReq({}));
    const body = await expectBaseFailure(res, [
      {
        code: "invalid_type",
        path: ["token"],
        message: "Invalid input: expected string, received undefined",
      },
    ]);
    expect(body.error.issues).toHaveProperty("0.code");
  });

  it("wrong-type token: exact encoded body", async () => {
    const res = await app().request("/api/auth/login", jsonReq({ token: 123 }));
    await expectBaseFailure(res, [
      {
        code: "invalid_type",
        path: ["token"],
        message: "Invalid input: expected string, received number",
      },
    ]);
  });
});

describe("POST /api/auth/register-from-project-pilot (validatedJson 400 body)", () => {
  it("missing githubAccessToken: exact encoded body", async () => {
    const res = await app().request(
      "/api/auth/register-from-project-pilot",
      jsonReq({ githubLogin: "octocat" }),
    );
    await expectBaseFailure(res, [
      {
        code: "invalid_type",
        path: ["githubAccessToken"],
        message: "Invalid input: expected string, received undefined",
      },
    ]);
  });
});

describe("POST /api/servers (validatedJson 400 body)", () => {
  it("empty body: one issue per missing required field, order preserved", async () => {
    const res = await app().request("/api/servers", jsonReq({}));
    await expectBaseFailure(res, [
      {
        code: "invalid_type",
        path: ["name"],
        message: "Invalid input: expected string, received undefined",
      },
      {
        code: "invalid_type",
        path: ["host"],
        message: "Invalid input: expected string, received undefined",
      },
    ]);
  });

  it("bad relayUrl: zod 4 invalid_format rendering, status 400", async () => {
    const res = await app().request(
      "/api/servers",
      jsonReq({ name: "s", host: "h", relayUrl: "not-a-url" }),
    );
    await expectBaseFailure(res, [
      { code: "invalid_format", path: ["relayUrl"], message: "Invalid URL" },
    ]);
  });
});

describe("PATCH /api/servers/:id (validatedJson 400 body)", () => {
  it("wrong-type name: exact encoded body", async () => {
    const res = await app().request("/api/servers/abc", jsonReq({ name: 123 }, "PATCH"));
    await expectBaseFailure(res, [
      {
        code: "invalid_type",
        path: ["name"],
        message: "Invalid input: expected string, received number",
      },
    ]);
  });
});
