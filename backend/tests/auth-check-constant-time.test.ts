/**
 * GET /api/auth/check and POST /api/auth/login compare the panel token in
 * constant time (safeCompare, backend/src/lib/panel-token.ts).
 *
 * The comparison hashes both values with SHA-256 before timingSafeEqual, so
 * an input whose string length matches PANEL_TOKEN but whose UTF-8 byte
 * length differs (a multi-byte character, e.g. "ä") returns 401 instead of
 * throwing inside timingSafeEqual. Before the fix the throw surfaced as a
 * 500 from POST /login and from the requireAuth middleware (which had the
 * same old compare); GET /check itself used to answer with `===` and simply
 * never threw.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The createHash spy is a structural guard, not a behavioral one: it proves
// the credential comparison goes through safeCompare's SHA-256 digest (a
// plain === never hashes). If the helper changes (different digest, fewer
// digests), update these expectations to match the helper, do not remove the
// guard.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});

vi.mock("../src/config/index.js", () => ({
  config: {
    NODE_ENV: "test",
    PANEL_TOKEN: "panel-token-must-be-16chars",
    SESSION_SECRET: "session-secret-must-be-16chars",
    CORS_ORIGINS: "http://localhost:3000",
    FRONTEND_URL: "http://localhost:3000",
    PORT: 3001,
  },
  allowedGitHubLogins: [],
}));

import { createHash } from "node:crypto";
import { authRouter } from "../src/routes/auth.js";

const TOKEN = "panel-token-must-be-16chars";
// Same string length as TOKEN (27 chars) but a different UTF-8 byte length
// (54 bytes): the old length-check + timingSafeEqual(Buffer.from) form threw
// on exactly this shape.
const MULTIBYTE = "ä".repeat(TOKEN.length);

function check(headers: Record<string, string>) {
  return authRouter.request("/check", { headers });
}

// The credential comparison must go through safeCompare, which digests both
// values with SHA-256 (node:crypto is spied in this file). A plain === never
// hashes, so the digest spy is the discriminator; timingSafeEqual itself is
// real (the spy only wraps createHash).
function expectDigests(calls: number) {
  expect(vi.mocked(createHash)).toHaveBeenCalledTimes(calls);
  vi.mocked(createHash).mockClear();
}

describe("GET /auth/check — constant-time credential comparison", () => {
  beforeEach(() => {
    vi.mocked(createHash).mockClear();
  });

  it("accepts the correct panel_session cookie", async () => {
    const res = await check({ Cookie: `panel_session=${TOKEN}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true });
    expectDigests(2); // the cookie value and the token, both digested
  });

  it("accepts the correct cookie among other cookies", async () => {
    const res = await check({ Cookie: `other=1; panel_session=${TOKEN}; x=2` });
    expect(res.status).toBe(200);
    expectDigests(2);
  });

  it("rejects a wrong cookie of equal length", async () => {
    const res = await check({ Cookie: `panel_session=${"z".repeat(TOKEN.length)}` });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ authenticated: false });
    expectDigests(2);
  });

  it("rejects a cookie whose value is the token followed by more after an =", async () => {
    // The comparison is against the FULL cookie value: the old
    // session.split("=")[1] === token form truncated at the next "=" and
    // accepted this value.
    const res = await check({ Cookie: `panel_session=${TOKEN}=x` });
    expect(res.status).toBe(401);
    expectDigests(2);
  });

  it("rejects a multi-byte cookie (equal string length, different byte length) with 401, not 500", async () => {
    const res = await check({ Cookie: `panel_session=${MULTIBYTE}` });
    expect(res.status).toBe(401);
    expectDigests(2);
  });

  it("accepts the correct Bearer token", async () => {
    const res = await check({ Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expectDigests(2);
  });

  it("rejects a wrong Bearer token", async () => {
    const res = await check({ Authorization: `Bearer ${"z".repeat(TOKEN.length)}` });
    expect(res.status).toBe(401);
    expectDigests(2);
  });

  it("rejects a multi-byte Bearer token with 401, not 500", async () => {
    const res = await check({ Authorization: `Bearer ${MULTIBYTE}` });
    expect(res.status).toBe(401);
    expectDigests(2);
  });

  it("rejects a wrong cookie AND a wrong Bearer token together", async () => {
    const res = await check({
      Cookie: `panel_session=${MULTIBYTE}`,
      Authorization: `Bearer ${"z".repeat(TOKEN.length)}`,
    });
    expect(res.status).toBe(401);
    expectDigests(4); // cookie path digests twice, then the Bearer path twice
  });
});

describe("POST /auth/login — same helper", () => {
  it("rejects a multi-byte token (equal string length, different byte length) with 401, not 500", async () => {
    const res = await authRouter.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: MULTIBYTE }),
    });
    expect(res.status).toBe(401);
  });
});
