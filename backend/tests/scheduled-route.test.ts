import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      findFirst: vi.fn(),
    },
    scheduledDeploy: {
      findMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("../src/lib/audit.js", () => ({
  audit: vi.fn(),
  getActor: vi.fn().mockReturnValue("panel"),
  getActorUserId: vi.fn().mockReturnValue(null),
}));

import { prisma } from "../src/lib/prisma.js";
import { audit } from "../src/lib/audit.js";
import { scheduledRouter } from "../src/routes/scheduled.js";
import { Hono } from "hono";

type ActorVars = {
  Variables: {
    userId?: string;
    isAdmin?: boolean;
  };
};

const mServer = prisma.server as unknown as {
  findFirst: ReturnType<typeof vi.fn>;
};
const mScheduled = prisma.scheduledDeploy as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

function appFor(actor: { userId: string | null; isAdmin: boolean }) {
  const app = new Hono<ActorVars>();
  app.use("/*", async (c, next) => {
    if (actor.userId) c.set("userId", actor.userId);
    c.set("isAdmin", actor.isAdmin);
    await next();
  });
  app.route("/", scheduledRouter as any);
  return app;
}

const ownedServer = {
  id: "srv-a",
  userId: "user-a",
  name: "my-server",
};

const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();

// ── POST / — create ────────────────────────────────────────────────────────

describe("scheduled POST / — create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("owned server + valid future date: creates row scoped to the actor's own server (ownership)", async () => {
    mServer.findFirst.mockResolvedValue(ownedServer);
    mScheduled.create.mockResolvedValue({
      id: "sched-1",
      serverId: "srv-a",
      appName: "my-app",
      scheduledFor: new Date(futureDate),
      force: false,
      status: "pending",
    });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "my-server", app: "my-app", scheduledFor: futureDate }),
    });

    expect(res.status).toBe(201);

    // Server lookup is unfiltered by ownership at the query level — the
    // ownership gate happens after fetch, on srv.userId vs actor.userId.
    expect(mServer.findFirst).toHaveBeenCalledWith({ where: { OR: [{ id: "my-server" }, { name: "my-server" }] } });

    expect(mScheduled.create).toHaveBeenCalledOnce();
    const createData = mScheduled.create.mock.calls[0][0].data;
    // OWNERSHIP: the created row's serverId is the id of the server that
    // was verified to belong to the acting actor (srv.userId === "user-a").
    expect(createData.serverId).toBe(ownedServer.id);
    expect(createData.appName).toBe("my-app");
    expect(createData.scheduledFor).toEqual(new Date(futureDate));
    expect(createData.force).toBe(false);

    expect(audit).toHaveBeenCalledWith(
      "schedule.create",
      "my-app on my-server",
      expect.stringContaining(new Date(futureDate).toISOString()),
      "panel",
      null,
    );
  });

  it("admin actor: can schedule on a server owned by a different user", async () => {
    mServer.findFirst.mockResolvedValue({ ...ownedServer, userId: "user-b" });
    mScheduled.create.mockResolvedValue({
      id: "sched-2",
      serverId: "srv-a",
      appName: "my-app",
      scheduledFor: new Date(futureDate),
      force: false,
      status: "pending",
    });

    const res = await appFor({ userId: null, isAdmin: true }).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "my-server", app: "my-app", scheduledFor: futureDate }),
    });

    expect(res.status).toBe(201);
    expect(mScheduled.create).toHaveBeenCalledOnce();
  });

  it("non-owned server: 404, no row created", async () => {
    mServer.findFirst.mockResolvedValue({ ...ownedServer, userId: "user-b" });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "my-server", app: "my-app", scheduledFor: futureDate }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
    expect(mScheduled.create).not.toHaveBeenCalled();
  });

  it("server not found: 404, no row created", async () => {
    mServer.findFirst.mockResolvedValue(null);

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "no-such-server", app: "my-app", scheduledFor: futureDate }),
    });

    expect(res.status).toBe(404);
    expect(mScheduled.create).not.toHaveBeenCalled();
  });

  it("missing scheduledFor: 400, no server lookup or row created", async () => {
    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "my-server", app: "my-app" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
    expect(mServer.findFirst).not.toHaveBeenCalled();
    expect(mScheduled.create).not.toHaveBeenCalled();
  });

  it("malformed scheduledFor (unparseable date): 400, no row created", async () => {
    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "my-server", app: "my-app", scheduledFor: "not-a-date" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toBe("scheduledFor must be a future date");
    expect(mScheduled.create).not.toHaveBeenCalled();
  });

  it("past scheduledFor: 400, no row created", async () => {
    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "my-server", app: "my-app", scheduledFor: pastDate }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe("scheduledFor must be a future date");
    expect(mServer.findFirst).not.toHaveBeenCalled();
    expect(mScheduled.create).not.toHaveBeenCalled();
  });
});

// ── GET / — ownership filtering ──────────────────────────────────────────────

describe("scheduled GET / — ownership filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("admin actor: no server filter", async () => {
    mScheduled.findMany.mockResolvedValue([]);
    await appFor({ userId: null, isAdmin: true }).request("/");
    const where = mScheduled.findMany.mock.calls[0][0].where;
    expect(where.server).toBeUndefined();
  });

  it("non-admin actor: filtered through server ownership", async () => {
    mScheduled.findMany.mockResolvedValue([]);
    await appFor({ userId: "user-a", isAdmin: false }).request("/");
    const where = mScheduled.findMany.mock.calls[0][0].where;
    expect(where.server).toEqual({ userId: "user-a" });
  });
});

// ── DELETE /:id — cancel ─────────────────────────────────────────────────────

describe("scheduled DELETE /:id — cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("success: cancels a pending schedule owned by the actor", async () => {
    mScheduled.findUnique.mockResolvedValue({
      id: "sched-1",
      status: "pending",
      appName: "my-app",
      server: { userId: "user-a" },
    });
    mScheduled.update.mockResolvedValue({ id: "sched-1", appName: "my-app", status: "cancelled" });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/sched-1", { method: "DELETE" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { cancelled: boolean };
    expect(body.cancelled).toBe(true);
    expect(mScheduled.update).toHaveBeenCalledWith({
      where: { id: "sched-1", status: "pending" },
      data: { status: "cancelled" },
    });
    expect(audit).toHaveBeenCalledWith("schedule.cancel", "my-app", undefined, "panel", null);
  });

  it("not found (no such row): 404, update not called", async () => {
    mScheduled.findUnique.mockResolvedValue(null);

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/no-such-id", { method: "DELETE" });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("not_found");
    expect(body.message).toBe("Scheduled deploy not found or already triggered");
    expect(mScheduled.update).not.toHaveBeenCalled();
  });

  it("already triggered (status !== pending): 404, update not called", async () => {
    mScheduled.findUnique.mockResolvedValue({
      id: "sched-1",
      status: "triggered",
      appName: "my-app",
      server: { userId: "user-a" },
    });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/sched-1", { method: "DELETE" });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe("Scheduled deploy not found or already triggered");
    expect(mScheduled.update).not.toHaveBeenCalled();
  });

  it("non-owned schedule (foreign server): 404, update not called", async () => {
    mScheduled.findUnique.mockResolvedValue({
      id: "sched-1",
      status: "pending",
      appName: "my-app",
      server: { userId: "user-b" },
    });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/sched-1", { method: "DELETE" });

    expect(res.status).toBe(404);
    expect(mScheduled.update).not.toHaveBeenCalled();
  });

  it("update races (row changed between findUnique and update, e.g. already triggered by the scheduler): 404", async () => {
    mScheduled.findUnique.mockResolvedValue({
      id: "sched-1",
      status: "pending",
      appName: "my-app",
      server: { userId: "user-a" },
    });
    mScheduled.update.mockRejectedValue(new Error("Record to update not found."));

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/sched-1", { method: "DELETE" });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe("Scheduled deploy not found or already triggered");
  });
});

describe("scheduled — residual edge coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST / with a malformed JSON body falls back to {} and returns 400 (create NOT called)", async () => {
    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not valid json",
    });

    expect(res.status).toBe(400);
    expect(mScheduled.create).not.toHaveBeenCalled();
  });

  it("GET /?status=all drops the status filter (admin: no server filter either)", async () => {
    mScheduled.findMany.mockResolvedValue([]);

    // admin isolates the status ternary: status=all -> where has no `status`,
    // and isAdmin skips the server-ownership filter -> where is {}.
    await appFor({ userId: "admin-1", isAdmin: true }).request("/?status=all");

    const where = mScheduled.findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty("status");
    expect(where).not.toHaveProperty("server");
  });

  it("GET / with a custom status filters by that exact status", async () => {
    mScheduled.findMany.mockResolvedValue([]);

    await appFor({ userId: "admin-1", isAdmin: true }).request("/?status=cancelled");

    const where = mScheduled.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("cancelled");
  });
});
