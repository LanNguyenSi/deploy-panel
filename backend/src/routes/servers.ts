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
import { probeVps } from "../services/probe-vps.js";

/** Strip sensitive fields from server objects */
function sanitizeServer(server: any) {
  const { relayToken, sshKeyPath, hostKeySha256, ...safe } = server;
  return {
    ...safe,
    hasRelayToken: !!relayToken,
    // Surface the existence of a stored fingerprint so the re-install
    // UI can warn ("legacy row, no fingerprint pinned — re-TOFU on
    // re-install") without leaking the fingerprint itself.
    hasHostKeyPinned: !!hostKeySha256,
  };
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
  // install.sh v0.2.0 mode selector. Optional: if omitted, install.sh
  // auto-detects. The wizard's pre-install probe pre-fills this based
  // on what's already running on the VPS so the user can confirm/override.
  relayMode: z
    .enum(["auto", "greenfield", "existing-traefik", "port-only"])
    .optional(),
  // Docker network for existing-traefik mode. Network names follow
  // docker's `[a-zA-Z0-9][a-zA-Z0-9_.-]+` rule.
  traefikNetwork: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "traefikNetwork must be a valid docker network name")
    .optional(),
  // ACME resolver name on an existing Traefik. Traefik config keys
  // are alnum + `_` / `-`.
  traefikCertResolver: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, "traefikCertResolver must be alnum/underscore/hyphen")
    .optional(),
  // Host bind IP for port-only mode. IPv4 / IPv6 shape (loose).
  relayBind: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[0-9a-fA-F:.]+$/, "relayBind must be an IP address")
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
    // Optional: base64 SHA-256 host-key fingerprint captured during
    // the pre-install probe. When present, ssh-executor pins it and
    // rejects with `host_key_rejected` on mismatch — closes the MITM
    // window between probe and install. Format matches `onHostKey`
    // output: base64, 44 chars.
    // SHA-256 base64 is exactly 44 chars (32 bytes → 44 base64 chars
    // including the trailing `=`). A pasted `SHA256:abc=` prefix or a
    // truncated value would never match downstream and produce a
    // confusing host_key_rejected — reject loudly here instead.
    expectedHostKeySha256: z
      .string()
      .length(44)
      .regex(/^[A-Za-z0-9+/]+=$/, "expectedHostKeySha256 must be raw base64 sha256 (no SHA256: prefix)")
      .optional(),
  })
  .merge(installEnvSchema)
  .and(sshAuthSchema);

const probeVpsSchema = z
  .object({
    host: z.string().min(1).max(255),
  })
  .and(sshAuthSchema);

// POST /api/servers/probe-vps — run a pre-install diagnostic over
// ephemeral SSH and return the parsed state (what's on :80 / :443,
// running docker containers, suggested install mode). Admin-only for
// the same reason install-relay is: it requires SSH credentials to a
// target host.
serversRouter.post("/probe-vps", async (c) => {
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
  const parsed = probeVpsSchema.safeParse(body);
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

  try {
    const outcome = await probeVps({
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
      acceptAnyHostKey: true,
    });
    await audit(
      "server.probe-vps.success",
      input.host,
      `mode=${outcome.probe.suggestedMode} port80=${outcome.probe.port80.kind}`,
      getActor(c),
      getActorUserId(c),
    );
    return c.json({
      probe: outcome.probe,
      // Fingerprint of the host key seen during the probe. The wizard
      // passes it back on install-relay so the backend can MATCH
      // instead of another blind TOFU accept — MITM between probe and
      // install is the narrow window we're closing here.
      ...(outcome.hostKeySha256 ? { hostKeySha256: outcome.hostKeySha256 } : {}),
    });
  } catch (err) {
    let kind = "probe_failed";
    const message = (err as Error).message ?? "probe failed";
    if (err instanceof SshTimeoutError) {
      kind = "timeout";
    } else if (err instanceof SshError) {
      kind = err.kind;
    }
    await audit(
      "server.probe-vps.failed",
      input.host,
      kind,
      getActor(c),
      getActorUserId(c),
    );
    return c.json({ error: kind, message }, 502);
  }
});

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
        relayMode: input.relayMode,
        traefikNetwork: input.traefikNetwork,
        traefikCertResolver: input.traefikCertResolver,
        relayBind: input.relayBind,
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
        // Pin the host-key fingerprint the wizard captured during the
        // probe. If a MITM swapped hosts between probe and install,
        // the fingerprint differs → ssh2 rejects → we abort before
        // running install.sh on the attacker's box.
        ...(input.expectedHostKeySha256
          ? { expectedHostKeySha256: input.expectedHostKeySha256 }
          : {}),
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
      // Persist the host-key fingerprint (captured by the wizard's
      // probe and echoed back as `expectedHostKeySha256`) so re-install
      // can pin it later; also record the resolved `relayMode` so the
      // re-install UI can default to the same mode without asking.
      const server = await prisma.server.create({
        data: {
          name: input.name,
          host: input.host,
          relayUrl: parsedOutput.value.relayUrl,
          relayToken: parsedOutput.value.relayToken,
          userId: actor.isAdmin ? null : actor.userId,
          ...(input.expectedHostKeySha256
            ? { hostKeySha256: input.expectedHostKeySha256 }
            : {}),
          ...(parsedOutput.value.relayMode
            ? { relayMode: parsedOutput.value.relayMode }
            : {}),
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
          // v0.2.0 installers emit a Mode line; older ones don't.
          // Surfacing it here lets the wizard's Done step show the
          // resolved mode (purely advisory — not persisted).
          ...(parsedOutput.value.relayMode
            ? { relayMode: parsedOutput.value.relayMode }
            : {}),
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

const reinstallRelaySchema = z
  .object({
    // Opt-in auth-token rotation. Default: false — install.sh re-uses
    // the existing /opt/agent-relay/.env token, so the relay stays
    // reachable with the same token recorded in our DB. Flip on when
    // the operator believes the token has leaked.
    rotateToken: z.boolean().optional(),
  })
  .merge(installEnvSchema)
  .and(sshAuthSchema);

// POST /api/servers/:id/install-relay — re-install against an already-
// registered server. Mirrors the first-install flow (same SSH exec, same
// output parsing) but:
//   - Operates on an existing Server row (ownership gate, no create).
//   - Pins the host-key fingerprint from DB when present (legacy rows
//     without one fall back to TOFU and capture for next time).
//   - Preserves relayToken by default — install.sh itself re-uses the
//     token in /opt/agent-relay/.env, so we only overwrite the DB when
//     the caller explicitly passes rotateToken=true.
//   - Updates relayUrl / relayMode (and hostKeySha256 on first capture).
serversRouter.post("/:id/install-relay", async (c) => {
  const actor = getActorContext(c);
  const server = await findOwnedServer(actor, c.req.param("id"));
  if (!server) return c.json({ error: "not_found" }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "bad_request", message: "body must be JSON" }, 400);
  }
  const parsed = reinstallRelaySchema.safeParse(body);
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

  // Two locks:
  //   1. Per-server: the same server can never be re-installed twice
  //      in parallel. Two concurrent re-installs of DIFFERENT servers
  //      are fine.
  //   2. Per-actor: a single non-admin user can't fan out 50 parallel
  //      re-installs against their owned fleet (would self-DoS the
  //      panel + spawn 50 SSH sessions). Admin actors share a single
  //      "admin" key, same as first-install.
  const installKey = `reinstall:${server.id}`;
  const actorKey = `reinstall-actor:${actor.userId ?? "admin"}`;
  if (activeInstalls.has(installKey)) {
    return c.json(
      { error: "rate_limited", message: "a re-install is already in progress for this server" },
      429,
    );
  }
  if (activeInstalls.has(actorKey)) {
    return c.json(
      { error: "rate_limited", message: "another re-install is already in progress for your account" },
      429,
    );
  }
  activeInstalls.add(installKey);
  activeInstalls.add(actorKey);

  const startTime = Date.now();
  return streamSSE(c, async (stream) => {
    let stdoutBuffer = "";
    const forwardProgress = async (streamKind: "stdout" | "stderr", line: string) => {
      if (streamKind === "stdout") stdoutBuffer += line + "\n";
      await stream.writeSSE({
        event: "progress",
        data: JSON.stringify({ stream: streamKind, line }),
      });
    };

    try {
      // Resolve effective mode: caller-supplied override > stored mode
      // from last install > undefined (let install.sh auto-detect).
      // Stored value is a free-form string column; narrow it to the
      // enum before forwarding so a corrupted DB value can't end up
      // shell-injected.
      const knownModes = ["auto", "greenfield", "existing-traefik", "port-only"] as const;
      const storedMode = knownModes.find((m) => m === server.relayMode);
      const effectiveMode = input.relayMode ?? storedMode ?? undefined;

      const baseCommand = buildInstallCommand({
        relayDomain: input.relayDomain,
        traefikEmail: input.traefikEmail,
        appsDir: input.appsDir,
        relayMode: effectiveMode,
        traefikNetwork: input.traefikNetwork,
        traefikCertResolver: input.traefikCertResolver,
        relayBind: input.relayBind,
      });

      // Token rotation. install.sh v0.2.0 preserves an existing
      // AUTH_TOKEN (it reads /opt/agent-relay/.env if present and only
      // generates a fresh hex token when the file is missing). If the
      // operator wants a fresh token (e.g. they suspect the current
      // one has leaked), we have to wipe the existing .env first —
      // the installer's `--rotate-token` flag would belong upstream
      // but until then we shell-chain a `sudo rm -f` ahead of the
      // install command. RELAY_DIR defaults to /opt/agent-relay; the
      // wizard does not currently expose a custom value, so the path
      // is hardcoded here. If RELAY_DIR is ever exposed on the route,
      // template it in.
      const command = input.rotateToken
        ? `sudo rm -f /opt/agent-relay/.env && ${baseCommand}`
        : baseCommand;

      // Capture the fingerprint we see during this connect so we can
      // update the DB when the stored value is null (legacy row first
      // re-install). We still advertise acceptAnyHostKey: true because
      // ssh-executor's hostVerifier needs that flag to fire, even when
      // expectedHostKeySha256 is set — the latter just turns the verifier
      // from "accept any" into "accept only this one".
      let observedHostKeySha256: string | undefined;

      await executeSshCommand({
        host: server.host,
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
        onHostKey: (fp) => {
          observedHostKeySha256 = fp.sha256;
        },
        // Pin to the fingerprint captured at first install when we have
        // one. Mismatch → ssh2 rejects the handshake → executeSshCommand
        // throws SshError("host_key_rejected") → the `catch` below maps
        // it to a stream error with a clearer "was this VPS rebuilt?"
        // message.
        ...(server.hostKeySha256
          ? { expectedHostKeySha256: server.hostKeySha256 }
          : {}),
        timeoutMs: 10 * 60 * 1000,
      });

      // Persist the freshly-observed fingerprint BEFORE parsing the
      // installer output. Even if parseInstallOutput fails (e.g.
      // install.sh succeeded on the VPS but its output drifted), the
      // SSH handshake completed and the fingerprint we saw is the
      // correct one to pin against next time. Skipping this would
      // leave a legacy row in TOFU mode forever despite a successful
      // connect.
      if (!server.hostKeySha256 && observedHostKeySha256) {
        await prisma.server.update({
          where: { id: server.id },
          data: { hostKeySha256: observedHostKeySha256 },
        });
      }

      const parsedOutput = parseInstallOutput(stdoutBuffer);
      if (!parsedOutput.ok) {
        await audit(
          "server.reinstall-relay.failed",
          `${server.name} (${server.host})`,
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

      // Token handling:
      //   - install.sh preserves the existing AUTH_TOKEN if it sees
      //     /opt/agent-relay/.env. When the operator opts into
      //     rotation we wipe that file BEFORE the install runs (see
      //     command construction above), so install.sh generates a
      //     fresh token and the emittedToken differs from DB.
      //   - When rotateToken=false but the emitted token still
      //     differs (the VPS-side .env was wiped out-of-band), we
      //     surface that as `tokenDiverged` on the done event so the
      //     UI can flag the tampering signal AND we update the DB
      //     because the VPS is now the source of truth.
      //   - Steady-state: rotateToken=false + emittedToken equals DB →
      //     no relayToken write at all (idempotent re-install).
      const emittedToken = parsedOutput.value.relayToken;
      const tokenChanged = emittedToken !== server.relayToken;
      const tokenDiverged = tokenChanged && !input.rotateToken;
      const shouldUpdateToken = input.rotateToken === true || tokenChanged;
      // `tokenRotated` (on the done event) reports the operator-visible
      // outcome: was the relay token actually replaced as a result of
      // this re-install? Only true when we both wiped the .env upstream
      // AND a different token came back.
      const tokenRotated = input.rotateToken === true && tokenChanged;

      // Don't persist `auto` as a stored mode — re-install would then
      // pass RELAY_MODE=auto next time, which is identical to omitting
      // the env entirely. Either way install.sh re-detects from
      // scratch, so the stored value carries no information.
      const persistableMode =
        parsedOutput.value.relayMode && parsedOutput.value.relayMode !== "auto"
          ? parsedOutput.value.relayMode
          : undefined;

      await prisma.server.update({
        where: { id: server.id },
        data: {
          relayUrl: parsedOutput.value.relayUrl,
          ...(persistableMode ? { relayMode: persistableMode } : {}),
          ...(shouldUpdateToken ? { relayToken: emittedToken } : {}),
          // hostKeySha256 was already persisted right after the SSH
          // handshake (see above), so no need to repeat here.
        },
      });

      const auditDetail = [
        `took ${Math.round((Date.now() - startTime) / 1000)}s`,
        persistableMode ? `mode=${persistableMode}` : undefined,
        tokenRotated ? "token-rotated" : undefined,
        tokenDiverged ? "token-divergence" : undefined,
        !server.hostKeySha256 && observedHostKeySha256 ? "fingerprint-captured" : undefined,
      ]
        .filter(Boolean)
        .join(" ");
      await audit(
        "server.reinstall-relay.success",
        `${server.name} (${server.host})`,
        auditDetail,
        getActor(c),
        getActorUserId(c),
      );
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({
          serverId: server.id,
          name: server.name,
          host: server.host,
          relayUrl: parsedOutput.value.relayUrl,
          tokenRotated,
          tokenDiverged,
          ...(persistableMode ? { relayMode: persistableMode } : {}),
        }),
      });
    } catch (err) {
      let kind: string = "install_failed";
      let message = (err as Error).message ?? "install failed";
      if (err instanceof SshTimeoutError) {
        kind = "timeout";
      } else if (err instanceof SshError) {
        kind = err.kind;
        if (err.kind === "host_key_rejected") {
          message =
            "Host key does not match the fingerprint captured on first install. Was the VPS rebuilt? Delete this server and onboard it again to re-TOFU.";
        }
      }
      await audit(
        "server.reinstall-relay.failed",
        `${server.name} (${server.host})`,
        kind,
        getActor(c),
        getActorUserId(c),
      );
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ kind, message }),
      });
    } finally {
      activeInstalls.delete(installKey);
      activeInstalls.delete(actorKey);
    }
  });
});

// POST /api/servers/:id/update-relay-image — fast-path "pull latest
// image and restart container" for an already-installed relay. Does
// NOT touch install.sh, Traefik, networks, compose file, env file, or
// DB fields other than `lastSeenAt` / `status`. Takes ~10-30s vs
// re-install's 2-5min. Use re-install instead when you need to switch
// modes, re-configure Traefik, or recover from a broken install.
//
// Contract:
// - Ownership gate (admin or owner).
// - Ephemeral SSH credentials in the body; not persisted.
// - Pins stored host-key fingerprint — mismatch aborts before any
//   docker command runs.
// - Command is a single `bash -c` that cd's into /opt/agent-relay and
//   runs docker compose pull + up -d. Hardcoded path matches the
//   installer's RELAY_DIR default; if the wizard ever exposes a
//   custom RELAY_DIR, template it in.
const updateRelayImageSchema = sshAuthSchema;

serversRouter.post("/:id/update-relay-image", async (c) => {
  const actor = getActorContext(c);
  const server = await findOwnedServer(actor, c.req.param("id"));
  if (!server) return c.json({ error: "not_found" }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "bad_request", message: "body must be JSON" }, 400);
  }
  const parsed = updateRelayImageSchema.safeParse(body);
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

  // Same two-level lock as re-install: one per server, one per actor.
  // Uses distinct key prefix so an update and a re-install of the same
  // server can't coexist either — both mutate the relay container.
  const installKey = `update-image:${server.id}`;
  const actorKey = `update-image-actor:${actor.userId ?? "admin"}`;
  // Guard against racing against an in-flight re-install too (shared
  // container surface).
  const reinstallKey = `reinstall:${server.id}`;
  if (activeInstalls.has(installKey) || activeInstalls.has(reinstallKey)) {
    return c.json(
      {
        error: "rate_limited",
        message: "an install or update is already in progress for this server",
      },
      429,
    );
  }
  if (activeInstalls.has(actorKey)) {
    return c.json(
      { error: "rate_limited", message: "another image update is already in progress for your account" },
      429,
    );
  }
  activeInstalls.add(installKey);
  activeInstalls.add(actorKey);

  const startTime = Date.now();
  return streamSSE(c, async (stream) => {
    let stdoutBuffer = "";
    const forwardProgress = async (streamKind: "stdout" | "stderr", line: string) => {
      if (streamKind === "stdout") stdoutBuffer += line + "\n";
      await stream.writeSSE({
        event: "progress",
        data: JSON.stringify({ stream: streamKind, line }),
      });
    };

    try {
      // Hardcoded RELAY_DIR — matches install.sh's default. The
      // `set -e` + chained `&&`s make any step failure terminate the
      // command non-zero, which executeSshCommand surfaces via the
      // exit code check below. No silent-swallow of pull errors.
      const command =
        "bash -c 'set -e; cd /opt/agent-relay && docker compose pull && docker compose up -d'";

      let observedHostKeySha256: string | undefined;

      const result = await executeSshCommand({
        host: server.host,
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
        onHostKey: (fp) => {
          observedHostKeySha256 = fp.sha256;
        },
        ...(server.hostKeySha256
          ? { expectedHostKeySha256: server.hostKeySha256 }
          : {}),
        // Image pulls over slow links can take a minute; 3-minute
        // ceiling is generous but still well below the 10-minute
        // install-scale timeout.
        timeoutMs: 3 * 60 * 1000,
      });

      // Persist newly observed fingerprint for legacy rows, same
      // treatment as re-install. Handshake succeeded → capture is
      // authoritative regardless of whether docker compose exited
      // cleanly below.
      if (!server.hostKeySha256 && observedHostKeySha256) {
        await prisma.server.update({
          where: { id: server.id },
          data: { hostKeySha256: observedHostKeySha256 },
        });
      }

      // executeSshCommand resolves even on non-zero exit; inspect the
      // exit code and surface a loud error if compose failed. The
      // most common cause is "compose file missing" (someone removed
      // /opt/agent-relay out-of-band) — point them at re-install.
      if (result.exitCode !== 0) {
        const kind = "update_failed";
        const message =
          "docker compose pull/up failed — see stderr above. If /opt/agent-relay is missing, the relay was never installed or was wiped; run 'Re-install Relay' to bootstrap it.";
        await audit(
          "server.update-relay-image.failed",
          `${server.name} (${server.host})`,
          `exit=${result.exitCode}`,
          getActor(c),
          getActorUserId(c),
        );
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ kind, message }),
        });
        return;
      }

      // Post-update health check. The relay may take a few seconds
      // to come back up after compose recreated the container, so
      // try a couple of times with short backoffs before marking
      // offline. Success flips status → online; failure keeps the
      // previous status (the update DID happen, it's just that the
      // probe window was too short).
      let healthOk = false;
      if (server.relayUrl) {
        for (const delay of [0, 2000, 4000]) {
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
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
              healthOk = true;
              break;
            }
          } catch {
            // fall through to retry
          }
        }
      }

      await prisma.server.update({
        where: { id: server.id },
        data: {
          lastSeenAt: new Date(),
          ...(healthOk ? { status: "online" } : {}),
        },
      });

      const auditDetail = [
        `took ${Math.round((Date.now() - startTime) / 1000)}s`,
        healthOk ? "health=ok" : "health=skipped-or-failed",
        !server.hostKeySha256 && observedHostKeySha256 ? "fingerprint-captured" : undefined,
      ]
        .filter(Boolean)
        .join(" ");
      await audit(
        "server.update-relay-image.success",
        `${server.name} (${server.host})`,
        auditDetail,
        getActor(c),
        getActorUserId(c),
      );
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({
          serverId: server.id,
          name: server.name,
          host: server.host,
          healthOk,
        }),
      });
    } catch (err) {
      let kind: string = "update_failed";
      let message = (err as Error).message ?? "update failed";
      if (err instanceof SshTimeoutError) {
        kind = "timeout";
      } else if (err instanceof SshError) {
        kind = err.kind;
        if (err.kind === "host_key_rejected") {
          message =
            "Host key does not match the fingerprint captured on first install. Was the VPS rebuilt? Run 'Re-install Relay' to re-establish trust.";
        }
      }
      await audit(
        "server.update-relay-image.failed",
        `${server.name} (${server.host})`,
        kind,
        getActor(c),
        getActorUserId(c),
      );
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ kind, message }),
      });
    } finally {
      activeInstalls.delete(installKey);
      activeInstalls.delete(actorKey);
    }
  });
});
