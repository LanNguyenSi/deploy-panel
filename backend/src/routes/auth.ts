import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { timingSafeEqual, randomBytes } from "node:crypto";
import {
  config,
  allowedGitHubLogins,
  hasGitHubOAuthConfigured,
} from "../config/index.js";
import { prisma } from "../lib/prisma.js";
import { hashApiKey } from "../middleware/auth.js";
import {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  fetchGitHubUser,
  generateOAuthState,
  GitHubAuthError,
  GitHubUnreachableError,
  type OAuthConfig,
} from "../lib/github.js";
import {
  buildUserSessionCookie,
  createSession,
} from "../lib/session.js";
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

// POST /api/auth/logout — clear all session cookies (panel + user)
authRouter.post("/logout", async (c) => {
  c.header("Set-Cookie", "panel_session=; Path=/; HttpOnly; Max-Age=0", { append: true });
  c.header(
    "Set-Cookie",
    "user_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    { append: true },
  );
  return c.json({ success: true });
});

// GET /api/auth/github/config — public probe so the frontend can conditionally
// render the "Sign in with GitHub" button without attempting the redirect
// and getting a 503.
authRouter.get("/github/config", (c) => {
  return c.json({ configured: hasGitHubOAuthConfigured });
});

// ── Native GitHub OAuth login ────────────────────────────────────────────────
//
// Standalone login path for users who aren't brokered through project-pilot.
// GET /api/auth/github/start   → state cookie + 302 to github.com authorize
// GET /api/auth/github/callback → exchange code, verify user, create session,
//                                 set user_session cookie, redirect to /
// If ALLOWED_GITHUB_LOGINS is set, unknown logins are refused at callback.

const OAUTH_STATE_COOKIE = "dp_oauth_state";

function oauthRedirectUri(): string {
  return `${config.BACKEND_URL.replace(/\/+$/, "")}/api/auth/github/callback`;
}

function buildOAuthConfig(): OAuthConfig | null {
  if (!hasGitHubOAuthConfigured) return null;
  return {
    clientId: config.GITHUB_CLIENT_ID,
    clientSecret: config.GITHUB_CLIENT_SECRET,
    redirectUri: oauthRedirectUri(),
  };
}

authRouter.get("/github/start", (c) => {
  const cfg = buildOAuthConfig();
  if (!cfg) {
    return c.json(
      { error: "not_configured", message: "GitHub OAuth is not configured on this instance" },
      503,
    );
  }

  const state = generateOAuthState();
  const isSecure = config.NODE_ENV === "production";
  c.header(
    "Set-Cookie",
    `${OAUTH_STATE_COOKIE}=${state}; HttpOnly; SameSite=Lax; Max-Age=600; Path=/${isSecure ? "; Secure" : ""}`,
  );

  return c.redirect(buildAuthorizationUrl(cfg, state));
});

authRouter.get("/github/callback", async (c) => {
  const cfg = buildOAuthConfig();
  const clearState = `${OAUTH_STATE_COOKIE}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`;

  if (!cfg) {
    c.header("Set-Cookie", clearState);
    return c.redirect(`${config.FRONTEND_URL}/login?error=not_configured`);
  }

  const code = c.req.query("code");
  const state = c.req.query("state");
  const cookieHeader = c.req.header("Cookie") ?? "";
  const storedStateMatch = cookieHeader.match(new RegExp(`${OAUTH_STATE_COOKIE}=([^;]+)`));
  const storedState = storedStateMatch ? storedStateMatch[1] : null;

  // Always clear the transient state cookie regardless of outcome.
  c.header("Set-Cookie", clearState, { append: true });

  if (!code) {
    return c.redirect(`${config.FRONTEND_URL}/login?error=missing_code`);
  }
  if (!state || !storedState || state !== storedState) {
    return c.redirect(`${config.FRONTEND_URL}/login?error=state_mismatch`);
  }

  let tokenResponse;
  let githubUser;
  try {
    tokenResponse = await exchangeCodeForToken(cfg, code);
    githubUser = await fetchGitHubUser(tokenResponse.access_token);
  } catch (err) {
    const reason = err instanceof GitHubAuthError ? "oauth_failed" : "upstream_unavailable";
    console.error("OAuth callback failed:", (err as Error).message);
    return c.redirect(`${config.FRONTEND_URL}/login?error=${reason}`);
  }

  // Apply the same allowlist guard as the broker path. Without this, any
  // GitHub user could reach deploy-panel's OAuth flow and provision an
  // account; per-user isolation contains them to an empty view but the
  // allowlist still applies as product policy.
  if (
    allowedGitHubLogins.length > 0 &&
    !allowedGitHubLogins.includes(githubUser.login)
  ) {
    return c.redirect(`${config.FRONTEND_URL}/login?error=forbidden_github_login`);
  }

  const githubId = String(githubUser.id);
  const githubEmail = githubUser.email?.toLowerCase() ?? null;

  const user = await prisma.user.upsert({
    where: { githubId },
    create: {
      githubId,
      githubLogin: githubUser.login,
      email: githubEmail,
      avatarUrl: githubUser.avatar_url,
    },
    update: {
      githubLogin: githubUser.login,
      email: githubEmail ?? undefined,
      avatarUrl: githubUser.avatar_url,
    },
  });

  const { token } = await createSession(user.id);
  const isSecure = config.NODE_ENV === "production";
  c.header("Set-Cookie", buildUserSessionCookie(token, isSecure), { append: true });

  void audit(
    "user.login",
    `github/${githubUser.login}`,
    "source: native-oauth",
    `user:${githubUser.login}`,
  );

  return c.redirect(config.FRONTEND_URL);
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

    // Stop-gap allowlist: until per-user data isolation ships, gate
    // registration by a configured set of GitHub logins so opening the
    // broker flow to a fresh GitHub account doesn't grant full panel
    // access. Empty list = back-compat accept-all.
    if (
      allowedGitHubLogins.length > 0 &&
      !allowedGitHubLogins.includes(githubUser.login)
    ) {
      return c.json(
        {
          error: "forbidden_github_login",
          message: "This GitHub login is not permitted on this deploy-panel instance",
        },
        403,
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
