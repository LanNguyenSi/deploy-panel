import { z } from "zod";

const configSchema = z.object({
  PORT: z.coerce.number().default(3001),
  SESSION_SECRET: z.string().min(16),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  FRONTEND_URL: z.string().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PANEL_TOKEN: z.string().min(1).optional(),
  // Comma-separated GitHub logins allowed to provision via the
  // identity-broker endpoint. Empty/unset = any verified GitHub user
  // (back-compat). Stop-gap until per-user data isolation lands; with
  // real isolation the allowlist becomes optional product policy rather
  // than a security guardrail.
  ALLOWED_GITHUB_LOGINS: z.string().default(""),
  // Native GitHub OAuth App for the standalone login flow (distinct
  // from the identity-broker path, which forwards a token from
  // project-pilot). Both empty = OAuth unavailable; /api/auth/github/*
  // routes return 503 in that case so the frontend can hide the button.
  GITHUB_CLIENT_ID: z.string().default(""),
  GITHUB_CLIENT_SECRET: z.string().default(""),
  // Absolute URL at which the OAuth callback will receive GitHub's
  // redirect. Required when OAuth is configured.
  BACKEND_URL: z.string().url().default("http://localhost:3001"),
  // Key material for encrypting per-app secrets at rest (see
  // lib/secret-crypto.ts). Optional in development (falls back to an
  // insecure fixed key with a console warning) so `make dev` keeps working
  // out of the box; required in production — storing/decrypting an
  // AppSecret without it throws rather than silently using a weak default.
  // Deliberately independent from SESSION_SECRET so routine session-secret
  // rotation doesn't brick every stored app secret.
  APP_SECRETS_KEY: z.string().min(16).optional(),
});

const result = configSchema.safeParse(process.env);
if (!result.success) {
  console.error("Invalid config:", result.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = result.data;

/**
 * Parsed allowlist. Empty array means "no allowlist enforced" — callers
 * treat that as "accept any verified login".
 */
export const allowedGitHubLogins: string[] = config.ALLOWED_GITHUB_LOGINS
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const hasGitHubOAuthConfigured =
  config.GITHUB_CLIENT_ID.length > 0 && config.GITHUB_CLIENT_SECRET.length > 0;
