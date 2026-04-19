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
