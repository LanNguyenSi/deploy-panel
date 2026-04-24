import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { prisma } from "../lib/prisma.js";
import { audit, getActor, getActorUserId } from "../lib/audit.js";
import {
  findOwnedServer,
  getActorContext,
  serverOwnershipWhere,
} from "../lib/ownership.js";
import { executeSshCommand, SshError, SshTimeoutError } from "../services/ssh-executor.js";
import { buildInstallCommand, parseInstallOutput } from "../services/install-relay.js";

/** Strip sensitive fields from server objects */
function sanitizeServer(server: any) {
  const { relayToken, sshKeyPath, ...safe } = server;
  return { ...safe, hasRelayToken: !!relayToken };
}

export const serversRouter = new Hono();

const createServerSchema = z.object({
  name: z.string().min(1).max(100),
  host: z.string().min(1).max(255),
  sshKeyPath: z.string().optional(),
  relayUrl: z.string().url().optional(),
  relayToken: z.string().optional(),
});

const updateServerSchema = createServerSchema.partial();

// GET /api/servers — list all servers the actor can see
serversRouter.get("/", async (c) => {
  const actor = getActorContext(c);
  const servers = await prisma.server.findMany({
    where: serverOwnershipWhere(actor),
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { apps: true } } },
  });

  return c.json({ servers: servers.map(sanitizeServer) });
});

// GET /api/servers/:id — single server (owner only)
serversRouter.get("/:id", async (c) => {
  const actor = getActorContext(c);
  const owned = await findOwnedServer(actor, c.req.param("id"));
  if (!owned) return c.json({ error: "not_found" }, 404);

  // Fetch again WITH the include-payload now that ownership is confirmed.
  const server = await prisma.server.findUnique({
    where: { id: owned.id },
    include: { apps: true, _count: { select: { deploys: true } } },
  });
  if (!server) return c.json({ error: "not_found" }, 404);
  return c.json({ server: sanitizeServer(server) });
});

// POST /api/servers — add server (owned by the actor unless admin)
serversRouter.post("/", zValidator("json", createServerSchema), async (c) => {
  const actor = getActorContext(c);
  const data = c.req.valid("json");

  const existing = await prisma.server.findUnique({ where: { host: data.host } });
  if (existing) {
    return c.json({ error: "conflict", message: "Server with this host already exists" }, 409);
  }

  // Non-admin actors must own the server they create. Admin rows land with
  // userId=null (admin-shared) so existing flows that seed fleet via the
  // panel UI keep their prior semantics.
  const ownerUserId = actor.isAdmin ? null : actor.userId;
  if (!actor.isAdmin && !ownerUserId) {
    return c.json({ error: "forbidden" }, 403);
  }

  const server = await prisma.server.create({
    data: { ...data, userId: ownerUserId },
  });
  audit("server.create", `${server.name} (${server.host})`, undefined, getActor(c), getActorUserId(c));
  return c.json({ server: sanitizeServer(server) }, 201);
});

// PATCH /api/servers/:id — update server (owner only)
serversRouter.patch("/:id", zValidator("json", updateServerSchema), async (c) => {
  const actor = getActorContext(c);
  const id = c.req.param("id");
  const owned = await findOwnedServer(actor, id);
  if (!owned) return c.json({ error: "not_found" }, 404);
  const data = c.req.valid("json");

  try {
    const server = await prisma.server.update({ where: { id }, data });
    return c.json({ server: sanitizeServer(server) });
  } catch {
    return c.json({ error: "not_found" }, 404);
  }
});

// DELETE /api/servers/:id — remove server (owner only)
serversRouter.delete("/:id", async (c) => {
  const actor = getActorContext(c);
  const id = c.req.param("id");
  const owned = await findOwnedServer(actor, id);
  if (!owned) return c.json({ error: "not_found" }, 404);

  try {
    const server = await prisma.server.delete({ where: { id } });
    audit("server.delete", `${server.name} (${server.host})`, undefined, getActor(c), getActorUserId(c));
    return c.json({ deleted: true });
  } catch {
    return c.json({ error: "not_found" }, 404);
  }
});

// POST /api/servers/:id/test — test connection to relay
serversRouter.post("/:id/test", async (c) => {
  const actor = getActorContext(c);
  const server = await findOwnedServer(actor, c.req.param("id"));
  if (!server) return c.json({ error: "not_found" }, 404);

  if (!server.relayUrl) {
    await prisma.server.update({
      where: { id: server.id },
      data: { status: "no-relay", lastSeenAt: new Date() },
    });
    return c.json({ status: "no-relay", message: "No relay URL configured" });
  }

  try {
    const headers: Record<string, string> = {};
    if (server.relayToken) {
      headers["Authorization"] = `Bearer ${server.relayToken}`;
    }

    const response = await fetch(`${server.relayUrl}/health`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      const data = await response.json();
      await prisma.server.update({
        where: { id: server.id },
        data: { status: "online", lastSeenAt: new Date() },
      });
      return c.json({ status: "online", relay: data });
    }

    await prisma.server.update({
      where: { id: server.id },
      data: { status: "offline", lastSeenAt: new Date() },
    });
    return c.json({ status: "offline", message: `Relay responded with ${response.status}` });
  } catch (err: any) {
    await prisma.server.update({
      where: { id: server.id },
      data: { status: "offline", lastSeenAt: new Date() },
    });
    return c.json({ status: "offline", message: err.message ?? "Connection failed" });
  }
});

// GET /api/servers/:id/system — get CPU/RAM/Disk from relay
serversRouter.get("/:id/system", async (c) => {
  const actor = getActorContext(c);
  const server = await findOwnedServer(actor, c.req.param("id"));
  if (!server) return c.json({ error: "not_found" }, 404);
  if (!server.relayUrl) return c.json({ error: "no_relay" }, 400);

  try {
    const headers: Record<string, string> = {};
    if (server.relayToken) headers["Authorization"] = `Bearer ${server.relayToken}`;

    const res = await fetch(`${server.relayUrl}/api/system`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return c.json({ error: "relay_error", status: res.status }, 502);
    return c.json(await res.json());
  } catch {
    return c.json({ error: "unreachable" }, 502);
  }
});

/**
 * One concurrent install per actor. Guards against accidental double-
 * click during the 2–5 minute install window and against concurrency
 * collisions (two installs racing to create the same Server row).
 * Stored in-process — fine for single-instance panel deployments; a
 * multi-instance deploy would need Redis-backed tracking.
 */
const activeInstalls = new Set<string>();

const installEnvSchema = z.object({
  // FQDN for Traefik TLS — validated as a conservative hostname shape.
  // Letters, digits, dot, hyphen. 253 is the DNS-name cap.
  relayDomain: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.-]+$/, "relayDomain must be a valid hostname")
    .optional(),
  // Let's Encrypt email — zod's built-in email suffices.
  traefikEmail: z.string().email().optional(),
  // Absolute path on the VPS. No shell metachars, no `..` segments
  // (same shape rule agent-relay enforces on compose_file paths since
  // v0.1.1).
  appsDir: z
    .string()
    .min(1)
    .max(255)
    .regex(/^\/[A-Za-z0-9._/-]*$/, "appsDir must be an absolute, simple path")
    .refine((v) => !v.split("/").includes(".."), "appsDir must not contain `..`")
    .optional(),
});

// password XOR privateKey. Both optional per field, but the body must
// carry exactly one authentication method. Validated by the refine
// below so the error message is stable.
const sshAuthSchema = z
  .object({
    sshUser: z.string().min(1).max(64).default("root"),
    sshPort: z.number().int().min(1).max(65535).default(22),
    sshPassword: z.string().min(1).optional(),
    sshPrivateKey: z.string().min(1).optional(),
    sshPassphrase: z.string().min(1).optional(),
  })
  .refine(
    (v) => (v.sshPassword ? 1 : 0) + (v.sshPrivateKey ? 1 : 0) === 1,
    {
      message: "exactly one of sshPassword or sshPrivateKey must be provided",
    },
  );

const installRelaySchema = z
  .object({
    // Server identity the resulting DB row will carry. Validated the
    // same way the create-server form validates these.
    name: z.string().min(1).max(100),
    host: z.string().min(1).max(255),
  })
  .merge(installEnvSchema)
  .and(sshAuthSchema);

// POST /api/servers/install-relay — run the agent-relay installer on a
// fresh VPS via ephemeral SSH, parse the emitted URL + token, and
// create the Server row. Admin-only. Streams the installer output as
// SSE so the wizard can show a live progress view.
//
// Security posture (see agent-tasks 252556e3):
// - Admin-only; non-admin OAuth users cannot onboard servers.
// - Credentials live in the zod-parsed body for the scope of this
//   handler and get zeroed by ssh-executor after the connect phase.
// - No DB write on failure paths — failed installs leave no trace
//   beyond the audit log entry.
// - Audit log captures host + success, never creds.
// - Installer URL is compile-time; not a body field.
serversRouter.post("/install-relay", async (c) => {
  const actor = getActorContext(c);
  if (!actor.isAdmin) {
    return c.json({ error: "forbidden", message: "admin auth required" }, 403);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "bad_request", message: "body must be JSON" }, 400);
  }
  const parsed = installRelaySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "bad_request",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
      400,
    );
  }
  const input = parsed.data;

  // Uniqueness pre-check. Running install.sh takes 2–5 minutes; if the
  // caller accidentally re-onboards an existing host we'd waste the
  // install window and surface a confusing DB-conflict error at the
  // very end. Bail fast before any SSH happens.
  const existing = await prisma.server.findUnique({ where: { host: input.host } });
  if (existing) {
    return c.json(
      {
        error: "conflict",
        message: `a server with host ${input.host} is already registered (${existing.name}). Delete it or use the manual form to update its credentials.`,
      },
      409,
    );
  }

  const actorKey = actor.userId ?? "admin";
  if (activeInstalls.has(actorKey)) {
    return c.json(
      { error: "rate_limited", message: "an install is already in progress for this actor" },
      429,
    );
  }
  activeInstalls.add(actorKey);

  const startTime = Date.now();
  return streamSSE(c, async (stream) => {
    // Collect the full stdout so we can parse URL + Token from it
    // after the command finishes. Stderr is streamed to the client
    // for diagnostics but not scanned for success markers.
    let stdoutBuffer = "";
    const forwardProgress = async (streamKind: "stdout" | "stderr", line: string) => {
      if (streamKind === "stdout") stdoutBuffer += line + "\n";
      await stream.writeSSE({
        event: "progress",
        data: JSON.stringify({ stream: streamKind, line }),
      });
    };

    try {
      const command = buildInstallCommand({
        relayDomain: input.relayDomain,
        traefikEmail: input.traefikEmail,
        appsDir: input.appsDir,
      });

      await executeSshCommand({
        host: input.host,
        port: input.sshPort,
        user: input.sshUser,
        auth: input.sshPassword
          ? { kind: "password", password: input.sshPassword }
          : {
              kind: "privateKey",
              privateKey: input.sshPrivateKey!,
              passphrase: input.sshPassphrase,
            },
        command,
        onStdout: (line) => {
          void forwardProgress("stdout", line);
        },
        onStderr: (line) => {
          void forwardProgress("stderr", line);
        },
        acceptAnyHostKey: true,
        // Covers a slow VPS + Docker pull cold cache. install.sh
        // itself typically finishes in ~2-5 min.
        timeoutMs: 10 * 60 * 1000,
      });

      const parsedOutput = parseInstallOutput(stdoutBuffer);
      if (!parsedOutput.ok) {
        await audit(
          "server.install-relay.failed",
          input.host,
          parsedOutput.error.kind,
          getActor(c),
          getActorUserId(c),
        );
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            kind: parsedOutput.error.kind,
            message: parsedOutput.error.message,
          }),
        });
        return;
      }

      // Token-parse succeeded — create the Server row now.
      const server = await prisma.server.create({
        data: {
          name: input.name,
          host: input.host,
          relayUrl: parsedOutput.value.relayUrl,
          relayToken: parsedOutput.value.relayToken,
          userId: actor.isAdmin ? null : actor.userId,
        },
      });
      await audit(
        "server.install-relay.success",
        `${server.name} (${server.host})`,
        `took ${Math.round((Date.now() - startTime) / 1000)}s`,
        getActor(c),
        getActorUserId(c),
      );
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({
          serverId: server.id,
          name: server.name,
          host: server.host,
          relayUrl: server.relayUrl,
        }),
      });
    } catch (err) {
      // Map typed SSH errors into a stable taxonomy the wizard can
      // branch on. Generic JS errors get a catch-all category so the
      // client still gets a useful message.
      let kind: string = "install_failed";
      let message = (err as Error).message ?? "install failed";
      if (err instanceof SshTimeoutError) {
        kind = "timeout";
      } else if (err instanceof SshError) {
        kind = err.kind;
      }
      await audit(
        "server.install-relay.failed",
        input.host,
        kind,
        getActor(c),
        getActorUserId(c),
      );
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ kind, message }),
      });
    } finally {
      activeInstalls.delete(actorKey);
    }
  });
});

// POST /api/servers/:id/install-relay — re-install for an existing
// server. Not yet implemented; distinct from first-install because the
// DB row already exists and host-key TOFU becomes strict-match. Filed
// as v0.3+ follow-up in agent-tasks `252556e3` known-follow-ups.
serversRouter.post("/:id/install-relay", async (c) => {
  const actor = getActorContext(c);
  const server = await findOwnedServer(actor, c.req.param("id"));
  if (!server) return c.json({ error: "not_found" }, 404);

  return c.json(
    {
      message:
        "Re-install for an existing server is not yet implemented. Use POST /api/servers/install-relay (no :id) to onboard a new VPS.",
    },
    501,
  );
});
