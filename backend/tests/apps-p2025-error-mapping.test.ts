import { describe, expect, it, vi, beforeEach } from "vitest";

// The three app-mutation handlers (PATCH /:name/tag, PATCH /:name/live-url,
// DELETE /:name) used to wrap prisma.app.update in a bare `} catch {` that
// reported EVERY rejection as a 404 not_found — masking real DB/infra failures
// behind a benign "app not found". These tests pin the corrected contract:
// only a Prisma P2025 (record-to-update-does-not-exist) maps to 404; any other
// error rethrows and surfaces as a 500. Mirrors the api-keys.ts (PR #111) fix.

vi.mock("../src/lib/relay.js", () => ({
  relayRequest: vi.fn(),
  RelayError: class RelayError extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("../src/lib/ownership.js", () => ({
  getActorContext: vi.fn(() => ({ userId: "user-a", isAdmin: false })),
  findOwnedServer: vi.fn(async () => ({ id: "srv-a", userId: "user-a" })),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    app: { update: vi.fn() },
  },
}));

vi.mock("../src/lib/audit.js", () => ({
  audit: vi.fn(),
  getActor: vi.fn(() => "panel"),
  getActorUserId: vi.fn(() => "user-a"),
}));

vi.mock("../src/lib/stream-deploy.js", () => ({ streamDeploy: vi.fn() }));
vi.mock("../src/lib/deploy-recovery.js", () => ({ recoverBrokenDeploy: vi.fn() }));

import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { appsRouter } from "../src/routes/apps.js";
import { Hono } from "hono";

const mUpdate = (prisma.app as any).update as ReturnType<typeof vi.fn>;

function app() {
  const a = new Hono();
  a.route("/servers/:serverId/apps", appsRouter as unknown as Hono);
  return a;
}

const p2025 = () =>
  new Prisma.PrismaClientKnownRequestError("Record to update not found.", {
    code: "P2025",
    clientVersion: "5.22.0",
  });

// Each entry drives one of the three prisma.app.update-backed handlers.
const handlers = [
  {
    name: "PATCH /:name/tag",
    request: () =>
      app().request("/servers/srv-a/apps/my-app/tag", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: "production" }),
      }),
  },
  {
    name: "PATCH /:name/live-url",
    request: () =>
      app().request("/servers/srv-a/apps/my-app/live-url", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ liveUrl: "https://example.com/" }),
      }),
  },
  {
    name: "DELETE /:name",
    request: () =>
      app().request("/servers/srv-a/apps/my-app", { method: "DELETE" }),
  },
] as const;

describe("apps routes — P2025 vs non-P2025 error mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  for (const h of handlers) {
    describe(h.name, () => {
      it("success: prisma.app.update resolves -> 2xx", async () => {
        mUpdate.mockResolvedValue({ id: "a1", name: "my-app", tag: "production", liveUrl: null });
        const res = await h.request();
        expect(res.status).toBe(200);
        expect(mUpdate).toHaveBeenCalledTimes(1);
      });

      it("Prisma P2025 (record not found) -> 404 not_found", async () => {
        mUpdate.mockRejectedValue(p2025());
        const res = await h.request();
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("not_found");
      });

      it("a real DB/infra error (non-P2025) is NOT masked as 404 -> 500", async () => {
        mUpdate.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
        const res = await h.request();
        expect(res.status).toBe(500);
        expect(res.status).not.toBe(404);
      });

      it("a Prisma error with a different code (P2003 constraint) is NOT masked as 404 -> 500", async () => {
        mUpdate.mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed.", {
            code: "P2003",
            clientVersion: "5.22.0",
          }),
        );
        const res = await h.request();
        expect(res.status).toBe(500);
      });
    });
  }
});
