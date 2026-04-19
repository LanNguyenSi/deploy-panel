import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { config } from "../config/index.js";
import { prisma } from "../lib/prisma.js";
import { hashApiKey } from "../middleware/auth.js";
import {
  fetchGitHubUser,
  GitHubAuthError,
  GitHubUnreachableError,
} from "../lib/github.js";
import { audit } from "../lib/audit.js";

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export const authRouter = new Hono();

const loginSchema = z.object({
  token: z.string().min(1),
});

// POST /api/auth/login — set session cookie
authRouter.post("/login", zValidator("json", loginSchema), async (c) => {
  const { token } = c.req.valid("json");

  if (!config.PANEL_TOKEN || !safeCompare(token, config.PANEL_TOKEN)) {
    return c.json({ error: "unauthorized", message: "Invalid token" }, 401);
  }

  // Set httpOnly cookie
  c.header(
    "Set-Cookie",
    `panel_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${config.NODE_ENV === "production" ? "; Secure" : ""}`,
  );

  return c.json({ success: true });
});

// POST /api/auth/logout — clear session
authRouter.post("/logout", async (c) => {
  c.header("Set-Cookie", "panel_session=; Path=/; HttpOnly; Max-Age=0");
  return c.json({ success: true });
});

// ── Identity-broker registration (e.g. project-pilot) ────────────────────────
//
// Shared contract with agent-tasks + project-forge:
//   POST /api/auth/register-from-project-pilot
//   Body:     { githubAccessToken, githubLogin? }
//   Response: { apiToken, userId, githubLogin }
//   Errors:   401 bad/mismatched token | 503 GitHub unreachable | 400 malformed
//
// The broker (project-pilot) obtains a user's GitHub OAuth access-token and
// calls this endpoint on their behalf. deploy-panel does NOT trust the
// broker's word — every call re-verifies the token against api.github.com/user.
//
// Idempotent per (user, name="project-pilot"): repeat calls revoke the prior
// broker-issued key and mint a fresh one. The broker caches the returned
// `apiToken` and re-registers only on 401; stale keys are revoked (not left
// dangling) so a compromised cache doesn't outlive the last broker round-trip.

const registerFromProjectPilotSchema = z.object({
  githubAccessToken: z.string().min(1),
  githubLogin: z.string().min(1).optional(),
});

function generateApiKey(): string {
  return `dp_${randomBytes(24).toString("base64url")}`;
}

authRouter.post(
  "/register-from-project-pilot",
  zValidator("json", registerFromProjectPilotSchema),
  async (c) => {
    const body = c.req.valid("json");

    let githubUser;
    try {
      githubUser = await fetchGitHubUser(body.githubAccessToken);
    } catch (err) {
      if (err instanceof GitHubAuthError) {
        return c.json(
          { error: "unauthorized", message: "GitHub access-token verification failed" },
          401,
        );
      }
      if (err instanceof GitHubUnreachableError) {
        return c.json(
          {
            error: "upstream_unavailable",
            message: "Could not reach GitHub to verify access-token; retry shortly",
          },
          503,
        );
      }
      return c.json({ error: "internal" }, 500);
    }

    if (body.githubLogin && body.githubLogin !== githubUser.login) {
      return c.json(
        {
          error: "unauthorized",
          message: "Claimed githubLogin does not match verified GitHub identity",
        },
        401,
      );
    }

    const githubId = String(githubUser.id);
    const user = await prisma.user.upsert({
      where: { githubId },
      create: {
        githubId,
        githubLogin: githubUser.login,
        email: githubUser.email?.toLowerCase() ?? null,
        avatarUrl: githubUser.avatar_url,
      },
      update: {
        githubLogin: githubUser.login,
        email: githubUser.email?.toLowerCase() ?? undefined,
        avatarUrl: githubUser.avatar_url,
      },
    });

    // Rotate: revoke any prior unrevoked project-pilot keys for this user,
    // then mint a fresh one. Keeps one active broker-key per user at a time.
    //
    // Advisory lock keyed on the user id serialises concurrent register
    // calls for the same user. Without it, two racers can both observe
    // zero unrevoked keys before either writes — both commits succeed,
    // leaving two active keys. The lock is transaction-scoped, so
    // pg_advisory_xact_lock releases automatically when the transaction
    // commits or rolls back.
    const rawKey = generateApiKey();
    const keyHash = hashApiKey(rawKey);
    const keyPrefix = rawKey.slice(0, 8);

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`register:${user.id}`}))`;
      await tx.apiKey.updateMany({
        where: { userId: user.id, name: "project-pilot", revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.apiKey.create({
        data: {
          name: "project-pilot",
          keyHash,
          keyPrefix,
          userId: user.id,
        },
      });
    });

    void audit(
      "api_key.create",
      `project-pilot/${githubUser.login}`,
      `prefix: ${keyPrefix} source: project-pilot`,
      `broker:project-pilot/${githubUser.login}`,
    );

    return c.json({
      apiToken: rawKey,
      userId: user.id,
      githubLogin: githubUser.login,
    });
  },
);

// GET /api/auth/check — check if authenticated
authRouter.get("/check", async (c) => {
  const token = config.PANEL_TOKEN;
  if (!token) return c.json({ authenticated: true }); // no auth configured

  const cookie = c.req.header("Cookie");
  if (cookie) {
    const session = cookie.split(";").map(s => s.trim()).find(s => s.startsWith("panel_session="));
    if (session && session.split("=")[1] === token) {
      return c.json({ authenticated: true });
    }
  }

  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ") && auth.slice(7) === token) {
    return c.json({ authenticated: true });
  }

  return c.json({ authenticated: false }, 401);
});
