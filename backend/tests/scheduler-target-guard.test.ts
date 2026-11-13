// Scheduled deploys run with no request actor. A server owned by a non-admin
// (userId set) gets the relayUrl host check before the relay is called; the
// admin-shared fleet (userId null) is unchanged.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    scheduledDeploy: { findMany: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    app: { upsert: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    deploy: { create: vi.fn(), update: vi.fn().mockResolvedValue({}) },
  },
}));

const lookupMock = vi.fn();
vi.mock("node:dns", () => ({
  promises: { lookup: (...args: unknown[]) => lookupMock(...args) },
}));

vi.mock("../src/lib/stream-deploy.js", () => ({ streamDeploy: vi.fn() }));

const trusted = vi.hoisted(() => [] as string[]);
vi.mock("../src/config/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/index.js")>();
  return { ...actual, config: { ...actual.config, TRUSTED_RELAY_SERVER_IDS: trusted } };
});

import { prisma } from "../src/lib/prisma.js";
import { streamDeploy } from "../src/lib/stream-deploy.js";
import { checkScheduled } from "../src/lib/scheduler.js";

const mScheduled = prisma.scheduledDeploy as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mApp = prisma.app as unknown as {
  upsert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mDeploy = prisma.deploy as unknown as {
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mStream = streamDeploy as unknown as ReturnType<typeof vi.fn>;

const fetchMock = vi.fn();

function entry(server: Record<string, unknown>) {
  return {
    id: "sched-1",
    serverId: "srv-a",
    appName: "my-app",
    scheduledFor: new Date(Date.now() - 1000),
    force: false,
    status: "pending",
    deployId: null,
    createdAt: new Date(),
    server: { id: "srv-a", name: "my-server", relayToken: "tok", ...server },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  trusted.length = 0;
  vi.stubGlobal("fetch", fetchMock);
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "203.0.113.4", family: 4 }]);
  mApp.upsert.mockResolvedValue({ id: "app-1", name: "my-app", status: "healthy" });
  mDeploy.create.mockResolvedValue({ id: "deploy-1" });
});

describe("checkScheduled: relayUrl host check for non-admin owned servers", () => {
  it("fails the deploy and never calls the relay when the relayUrl is a private literal", async () => {
    mScheduled.findMany.mockResolvedValue([
      entry({ userId: "user-a", relayUrl: "http://169.254.169.254/latest" }),
    ]);
    await checkScheduled();

    expect(mStream).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const failed = mDeploy.update.mock.calls.find((c) => c[0].data.status === "failed");
    expect(failed?.[0].where.id).toBe("deploy-1");
    const log = JSON.parse(failed![0].data.log) as Array<{ status: string; output: string }>;
    expect(log[0].status).toBe("failure");
    expect(log[0].output).toContain("private_host");
    // The app is not flipped to `deploying` for a deploy that never ran.
    expect(mApp.update).not.toHaveBeenCalled();
  });

  it("fails the deploy when the relayUrl name resolves to a private address", async () => {
    lookupMock.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
    mScheduled.findMany.mockResolvedValue([
      entry({ userId: "user-a", relayUrl: "https://relay.attacker.example" }),
    ]);
    await checkScheduled();
    expect(mStream).not.toHaveBeenCalled();
    expect(mDeploy.update.mock.calls.some((c) => c[0].data.status === "failed")).toBe(true);
  });

  it("fails the deploy with its own message for a stored relayUrl that is not a URL", async () => {
    mScheduled.findMany.mockResolvedValue([
      entry({ userId: "user-a", relayUrl: "http://<set-host-ip>:3001" }),
    ]);
    await checkScheduled();
    expect(mStream).not.toHaveBeenCalled();
    const failed = mDeploy.update.mock.calls.find((c) => c[0].data.status === "failed");
    expect(JSON.parse(failed![0].data.log)[0].output).toContain("not a valid URL");
  });

  it("proceeds to streamDeploy for a non-admin owned server with a public relayUrl", async () => {
    mScheduled.findMany.mockResolvedValue([
      entry({ userId: "user-a", relayUrl: "https://relay.example.com" }),
    ]);
    await checkScheduled();
    expect(mStream).toHaveBeenCalledTimes(1);
    expect(mStream.mock.calls[0][0].relayUrl).toBe("https://relay.example.com");
    expect(mDeploy.update.mock.calls.some((c) => c[0].data.status === "failed")).toBe(false);
    // the owner decides at connect time too: the relay is resolved and checked inside the connection
    expect(mStream.mock.calls[0][0].connectGuard).toBe(true);
  });

  it("proceeds for an admin-shared server (userId null) with a private relayUrl, without a lookup", async () => {
    mScheduled.findMany.mockResolvedValue([
      entry({ userId: null, relayUrl: "http://10.0.0.5:3000" }),
    ]);
    await checkScheduled();
    expect(mStream).toHaveBeenCalledTimes(1);
    expect(mStream.mock.calls[0][0].relayUrl).toBe("http://10.0.0.5:3000");
    expect(mStream.mock.calls[0][0].connectGuard).toBe(false);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("a denied entry does not stop the next due entry", async () => {
    mScheduled.findMany.mockResolvedValue([
      entry({ userId: "user-a", relayUrl: "http://127.0.0.1:3000" }),
      { ...entry({ userId: "user-b", relayUrl: "https://relay.example.com" }), id: "sched-2" },
    ]);
    await checkScheduled();
    expect(mStream).toHaveBeenCalledTimes(1);
  });
});

describe("checkScheduled: TRUSTED_RELAY_SERVER_IDS", () => {
  it("proceeds to streamDeploy for a listed server whose relayUrl is private", async () => {
    trusted.push("srv-a");
    mScheduled.findMany.mockResolvedValue([
      entry({ userId: "user-a", relayUrl: "http://agent-relay:8222" }),
    ]);
    lookupMock.mockResolvedValue([{ address: "172.18.0.5", family: 4 }]);
    await checkScheduled();
    expect(mStream).toHaveBeenCalledTimes(1);
    expect(mStream.mock.calls[0][0].relayUrl).toBe("http://agent-relay:8222");
    expect(mDeploy.update.mock.calls.some((c) => c[0].data.status === "failed")).toBe(false);
    // the listed row keeps its exemption at connect time as well
    expect(mStream.mock.calls[0][0].connectGuard).toBe(false);
  });

  it("still fails the deploy when only another id is listed", async () => {
    trusted.push("srv-other");
    mScheduled.findMany.mockResolvedValue([
      entry({ userId: "user-a", relayUrl: "http://agent-relay:8222" }),
    ]);
    lookupMock.mockResolvedValue([{ address: "172.18.0.5", family: 4 }]);
    await checkScheduled();
    expect(mStream).not.toHaveBeenCalled();
    expect(mDeploy.update.mock.calls.some((c) => c[0].data.status === "failed")).toBe(true);
  });
});
