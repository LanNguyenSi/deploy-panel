import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

import { prisma } from "../src/lib/prisma.js";
import { setServerStatus } from "../src/services/server-status.js";
import { activeInstalls, isServerMutating } from "../src/services/active-installs.js";

const mUpdate = (prisma.server as unknown as { update: ReturnType<typeof vi.fn> }).update;

describe("setServerStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeInstalls.clear();
  });

  it("writes unconditionally when source is action", async () => {
    activeInstalls.add("reinstall:srv-a");
    const landed = await setServerStatus({
      serverId: "srv-a",
      status: "online",
      source: "action",
    });
    expect(landed).toBe(true);
    expect(mUpdate).toHaveBeenCalledOnce();
    const call = mUpdate.mock.calls[0][0];
    expect(call.where.id).toBe("srv-a");
    expect(call.data.status).toBe("online");
    expect(call.data.lastSeenAt).toBeInstanceOf(Date);
  });

  it("writes when source is probe and no mutation is in flight", async () => {
    const landed = await setServerStatus({
      serverId: "srv-a",
      status: "online",
      source: "probe",
    });
    expect(landed).toBe(true);
    expect(mUpdate).toHaveBeenCalledOnce();
  });

  it("skips the STATUS write but still refreshes lastSeenAt when a reinstall is in flight", async () => {
    activeInstalls.add("reinstall:srv-a");
    const landed = await setServerStatus({
      serverId: "srv-a",
      status: "offline",
      source: "probe",
    });
    expect(landed).toBe(false);
    // Status is NOT written (avoids stale-offline landing as final)
    // but lastSeenAt IS — the probe hit the relay, so the freshness
    // indicator should reflect that.
    expect(mUpdate).toHaveBeenCalledOnce();
    const call = mUpdate.mock.calls[0][0];
    expect(call.data.status).toBeUndefined();
    expect(call.data.lastSeenAt).toBeInstanceOf(Date);
  });

  it("skips the STATUS write but still refreshes lastSeenAt when an update-image is in flight", async () => {
    activeInstalls.add("update-image:srv-a");
    const landed = await setServerStatus({
      serverId: "srv-a",
      status: "offline",
      source: "probe",
    });
    expect(landed).toBe(false);
    expect(mUpdate).toHaveBeenCalledOnce();
    const call = mUpdate.mock.calls[0][0];
    expect(call.data.status).toBeUndefined();
    expect(call.data.lastSeenAt).toBeInstanceOf(Date);
  });

  it("probe write for server A is NOT blocked by an in-flight mutation on server B", async () => {
    activeInstalls.add("reinstall:srv-b");
    const landed = await setServerStatus({
      serverId: "srv-a",
      status: "online",
      source: "probe",
    });
    expect(landed).toBe(true);
    expect(mUpdate).toHaveBeenCalledOnce();
  });

  it("per-actor keys do NOT count as server-mutating (actor locks gate concurrent ACTIONS, not server state)", async () => {
    // `reinstall-actor:user-a` means user-a is actively running SOME
    // reinstall — not necessarily for srv-a. Probe writes on srv-a
    // should proceed.
    activeInstalls.add("reinstall-actor:user-a");
    activeInstalls.add("update-image-actor:user-a");
    const landed = await setServerStatus({
      serverId: "srv-a",
      status: "online",
      source: "probe",
    });
    expect(landed).toBe(true);
  });

  it("uses the supplied lastSeenAt when provided", async () => {
    const when = new Date("2026-01-01T00:00:00Z");
    await setServerStatus({
      serverId: "srv-a",
      status: "online",
      source: "action",
      lastSeenAt: when,
    });
    const call = mUpdate.mock.calls[0][0];
    expect(call.data.lastSeenAt).toEqual(when);
  });
});

describe("isServerMutating", () => {
  beforeEach(() => activeInstalls.clear());

  it("returns true for reinstall:<id>", () => {
    activeInstalls.add("reinstall:srv-a");
    expect(isServerMutating("srv-a")).toBe(true);
  });

  it("returns true for update-image:<id>", () => {
    activeInstalls.add("update-image:srv-a");
    expect(isServerMutating("srv-a")).toBe(true);
  });

  it("returns false for actor-scoped keys", () => {
    activeInstalls.add("reinstall-actor:user-a");
    activeInstalls.add("update-image-actor:user-a");
    expect(isServerMutating("srv-a")).toBe(false);
  });

  it("returns false when nothing in flight", () => {
    expect(isServerMutating("srv-a")).toBe(false);
  });
});
