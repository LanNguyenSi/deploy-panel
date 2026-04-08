import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { hashApiKey } from "../middleware/auth.js";

export const apiKeysRouter = new Hono();

// GET /api/api-keys — list all keys (no secret shown)
apiKeysRouter.get("/", async (c) => {
  const keys = await prisma.apiKey.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, keyPrefix: true, lastUsedAt: true, createdAt: true },
  });
  return c.json({ keys });
});

// POST /api/api-keys — create a new key
apiKeysRouter.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { name } = body as { name?: string };

  if (!name || name.trim().length === 0) {
    return c.json({ error: "bad_request", message: "name is required" }, 400);
  }

  // Generate key: dp_ prefix + 40 random hex chars
  const secret = randomBytes(20).toString("hex");
  const key = `dp_${secret}`;
  const keyHash = hashApiKey(key);
  const keyPrefix = key.slice(0, 10);

  const apiKey = await prisma.apiKey.create({
    data: { name: name.trim(), keyHash, keyPrefix },
  });

  // Return the full key ONCE — it's never shown again
  return c.json({
    key: {
      id: apiKey.id,
      name: apiKey.name,
      secret: key,
      prefix: keyPrefix,
      createdAt: apiKey.createdAt,
    },
    warning: "Save this key now — it will not be shown again.",
  }, 201);
});

// DELETE /api/api-keys/:id — revoke a key
apiKeysRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");

  try {
    await prisma.apiKey.delete({ where: { id } });
    return c.json({ deleted: true });
  } catch {
    return c.json({ error: "not_found", message: "API key not found" }, 404);
  }
});
