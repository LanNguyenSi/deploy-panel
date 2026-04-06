import { z } from "zod";

const configSchema = z.object({
  PORT: z.coerce.number().default(3001),
  SESSION_SECRET: z.string().min(16),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  FRONTEND_URL: z.string().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

const result = configSchema.safeParse(process.env);
if (!result.success) {
  console.error("Invalid config:", result.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = result.data;
