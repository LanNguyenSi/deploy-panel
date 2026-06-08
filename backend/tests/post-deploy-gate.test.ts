import { describe, expect, it, vi } from "vitest";
import {
  parseComposePs,
  assessContainers,
  probeRoute,
  verifyDeployHealth,
} from "../src/lib/post-deploy-gate.js";

// `docker compose ps --format json` rows. Newer compose emits one object
// per line (JSONL); some versions emit a single JSON array. Both are tested.
const RUNNING_BACKEND = {
  Service: "backend",
  Name: "thd-backend-1",
  State: "running",
  Health: "healthy",
  ExitCode: 0,
  Status: "Up 2 minutes",
};
const RESTARTING_FRONTEND = {
  Service: "frontend",
  Name: "thd-frontend-1",
  State: "restarting",
  Health: "",
  ExitCode: 1,
  Status: "Restarting (1) 3 seconds ago",
};

const jsonl = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n");
const arr = (...rows: object[]) => JSON.stringify(rows);

const okResponse = (status: number) => ({ status }) as unknown as Response;
const noSleep = () => Promise.resolve();

describe("parseComposePs", () => {
  it("parses newline-delimited objects (compose v2 JSONL)", () => {
    const entries = parseComposePs(jsonl(RUNNING_BACKEND, RESTARTING_FRONTEND));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ service: "backend", state: "running", health: "healthy", exitCode: 0 });
    expect(entries[1]).toMatchObject({ service: "frontend", state: "restarting", exitCode: 1 });
  });

  it("parses a single JSON array", () => {
    const entries = parseComposePs(arr(RUNNING_BACKEND, RESTARTING_FRONTEND));
    expect(entries.map((e) => e.service)).toEqual(["backend", "frontend"]);
  });

  it("returns [] for null / empty / whitespace", () => {
    expect(parseComposePs(null)).toEqual([]);
    expect(parseComposePs("")).toEqual([]);
    expect(parseComposePs("   \n  ")).toEqual([]);
  });

  it("skips a non-JSON line instead of dropping the whole batch", () => {
    const raw = "WARN: something\n" + JSON.stringify(RUNNING_BACKEND);
    const entries = parseComposePs(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].service).toBe("backend");
  });
});

describe("assessContainers", () => {
  it("passes a fully-running project", () => {
    expect(assessContainers(parseComposePs(jsonl(RUNNING_BACKEND)))).toEqual([]);
  });

  it("flags a restarting service and names it", () => {
    const offenders = assessContainers(parseComposePs(jsonl(RUNNING_BACKEND, RESTARTING_FRONTEND)));
    expect(offenders).toHaveLength(1);
    expect(offenders[0].service).toBe("frontend");
    expect(offenders[0].reason).toContain("restarting");
    expect(offenders[0].reason).toContain("Restarting (1)");
  });

  it("does NOT flag a clean exit (code 0 — one-shot init/migration container)", () => {
    const oneShot = { Service: "migrate", Name: "thd-migrate-1", State: "exited", Health: "", ExitCode: 0, Status: "Exited (0) 1 minute ago" };
    expect(assessContainers(parseComposePs(jsonl(RUNNING_BACKEND, oneShot)))).toEqual([]);
  });

  it("flags a non-zero exit", () => {
    const crashed = { Service: "worker", Name: "thd-worker-1", State: "exited", Health: "", ExitCode: 137, Status: "Exited (137) 2 seconds ago" };
    const offenders = assessContainers(parseComposePs(jsonl(crashed)));
    expect(offenders[0].reason).toContain("exited with code 137");
  });

  it("flags health=unhealthy even while the state reads running", () => {
    const sick = { Service: "api", Name: "thd-api-1", State: "running", Health: "unhealthy", ExitCode: 0, Status: "Up 1 minute (unhealthy)" };
    const offenders = assessContainers(parseComposePs(jsonl(sick)));
    expect(offenders[0].reason).toContain("health=unhealthy");
  });
});

describe("probeRoute", () => {
  it("ok for a 200", async () => {
    const v = await probeRoute("https://x.test/", { fetchImpl: vi.fn().mockResolvedValue(okResponse(200)) });
    expect(v).toEqual({ ok: true, status: 200 });
  });

  it("not ok for a 404 (Traefik no-backend — the incident), carrying the status", async () => {
    const v = await probeRoute("https://x.test/", { fetchImpl: vi.fn().mockResolvedValue(okResponse(404)) });
    expect(v).toEqual({ ok: false, status: 404 });
  });

  it("not ok for a 503 (Traefik no healthy upstream)", async () => {
    const v = await probeRoute("https://x.test/", { fetchImpl: vi.fn().mockResolvedValue(okResponse(503)) });
    expect(v).toEqual({ ok: false, status: 503 });
  });

  it("OK for a 401/403 — a backend answered through Traefik, the route is wired (just auth-gated)", async () => {
    expect((await probeRoute("https://x.test/", { fetchImpl: vi.fn().mockResolvedValue(okResponse(401)) })).ok).toBe(true);
    expect((await probeRoute("https://x.test/", { fetchImpl: vi.fn().mockResolvedValue(okResponse(403)) })).ok).toBe(true);
  });

  it("not ok on a transport error, carrying the message", async () => {
    const v = await probeRoute("https://x.test/", { fetchImpl: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) });
    expect(v.ok).toBe(false);
    expect(v.error).toContain("ECONNREFUSED");
  });
});

describe("verifyDeployHealth", () => {
  const relayReturning = (containers: string | null) =>
    vi.fn().mockResolvedValue({ app: { containers } });

  // (a) a service stuck in Restarting → deploy reported unhealthy
  it("(a) fails when a sibling service is crashlooping, naming the container", async () => {
    const verdict = await verifyDeployHealth({
      serverId: "srv-a",
      appName: "thd",
      liveUrl: null,
      attempts: 2,
      sleepImpl: noSleep,
      relayRequestImpl: relayReturning(jsonl(RUNNING_BACKEND, RESTARTING_FRONTEND)),
    });
    expect(verdict.healthy).toBe(false);
    expect(verdict.reason).toContain('service "frontend" is restarting');
  });

  // (b) public route returns 404 → deploy reported unhealthy
  it("(b) fails when the public route returns 404, surfacing the HTTP code", async () => {
    const verdict = await verifyDeployHealth({
      serverId: "srv-a",
      appName: "thd",
      liveUrl: "https://status.opentriologue.ai/",
      attempts: 2,
      sleepImpl: noSleep,
      relayRequestImpl: relayReturning(jsonl(RUNNING_BACKEND)), // containers fine…
      fetchImpl: vi.fn().mockResolvedValue(okResponse(404)),    // …but Traefik 404s
    });
    expect(verdict.healthy).toBe(false);
    expect(verdict.reason).toContain("returned HTTP 404");
    expect(verdict.reason).toContain("https://status.opentriologue.ai/");
  });

  // (c) all-up + route 200 → success
  it("(c) passes when every service runs and the public route answers 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(200));
    const verdict = await verifyDeployHealth({
      serverId: "srv-a",
      appName: "thd",
      liveUrl: "https://status.opentriologue.ai/",
      attempts: 4,
      sleepImpl: noSleep,
      relayRequestImpl: relayReturning(jsonl(RUNNING_BACKEND)),
      fetchImpl,
    });
    expect(verdict.healthy).toBe(true);
    expect(verdict.reason).toBeUndefined();
    // Happy path settles on the first poll — no retries.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // Incident shape: the crashlooping sibling sits BEHIND a route that can
  // still answer 200 (another service or a cached edge). The route probe
  // alone would miss it; the container check must still fail the deploy.
  it("fails on a crashlooping container even when the public route answers 200", async () => {
    const verdict = await verifyDeployHealth({
      serverId: "srv-a",
      appName: "thd",
      liveUrl: "https://status.opentriologue.ai/",
      attempts: 2,
      sleepImpl: noSleep,
      relayRequestImpl: relayReturning(jsonl(RUNNING_BACKEND, RESTARTING_FRONTEND)),
      fetchImpl: vi.fn().mockResolvedValue(okResponse(200)),
    });
    expect(verdict.healthy).toBe(false);
    expect(verdict.reason).toContain('service "frontend" is restarting');
  });

  // Happy-path guard: an auth-gated public root (401) must NOT false-fail.
  it("passes when containers run and the route is up-but-auth-gated (401)", async () => {
    const verdict = await verifyDeployHealth({
      serverId: "srv-a",
      appName: "thd",
      liveUrl: "https://gated.opentriologue.ai/",
      attempts: 2,
      sleepImpl: noSleep,
      relayRequestImpl: relayReturning(jsonl(RUNNING_BACKEND)),
      fetchImpl: vi.fn().mockResolvedValue(okResponse(401)),
    });
    expect(verdict.healthy).toBe(true);
  });

  it("tolerates a service that is briefly restarting then settles within the window", async () => {
    const relay = vi
      .fn()
      .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, RESTARTING_FRONTEND) } })
      .mockResolvedValue({ app: { containers: jsonl(RUNNING_BACKEND, { ...RESTARTING_FRONTEND, State: "running", ExitCode: 0, Status: "Up 1 second" }) } });
    const sleep = vi.fn(noSleep);
    const verdict = await verifyDeployHealth({
      serverId: "srv-a",
      appName: "thd",
      liveUrl: null,
      attempts: 4,
      sleepImpl: sleep,
      relayRequestImpl: relay,
    });
    expect(verdict.healthy).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1); // one retry was needed
  });

  it("does not probe the route when no liveUrl is configured", async () => {
    const fetchImpl = vi.fn();
    const verdict = await verifyDeployHealth({
      serverId: "srv-a",
      appName: "thd",
      attempts: 1,
      sleepImpl: noSleep,
      relayRequestImpl: relayReturning(jsonl(RUNNING_BACKEND)),
      fetchImpl,
    });
    expect(verdict.healthy).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not false-fail the happy path when the relay is momentarily unreachable and no route is set", async () => {
    const verdict = await verifyDeployHealth({
      serverId: "srv-a",
      appName: "thd",
      liveUrl: null,
      attempts: 1,
      sleepImpl: noSleep,
      relayRequestImpl: vi.fn().mockRejectedValue(new Error("relay timeout")),
    });
    expect(verdict.healthy).toBe(true);
  });

  // ── requireHealthyEvidence (fail-closed / recovery mode) ─────────────────
  describe("requireHealthyEvidence", () => {
    it("passes once it positively confirms a running project", async () => {
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        attempts: 3,
        sleepImpl: noSleep,
        requireHealthyEvidence: true,
        relayRequestImpl: relayReturning(jsonl(RUNNING_BACKEND)),
      });
      expect(verdict.healthy).toBe(true);
    });

    it("FAILS when the relay is unreachable for the whole window (contrast with optimistic mode)", async () => {
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        attempts: 2,
        sleepImpl: noSleep,
        requireHealthyEvidence: true,
        relayRequestImpl: vi.fn().mockRejectedValue(new Error("relay timeout")),
      });
      expect(verdict.healthy).toBe(false);
      expect(verdict.reason).toContain("could not reach the relay");
    });

    it("FAILS when the compose project has nothing running", async () => {
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        attempts: 2,
        sleepImpl: noSleep,
        requireHealthyEvidence: true,
        relayRequestImpl: relayReturning(""), // ps returns no rows
      });
      expect(verdict.healthy).toBe(false);
      expect(verdict.reason).toContain("no running containers");
    });

    it("still catches a crashloop, naming the container", async () => {
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        attempts: 2,
        sleepImpl: noSleep,
        requireHealthyEvidence: true,
        relayRequestImpl: relayReturning(jsonl(RUNNING_BACKEND, RESTARTING_FRONTEND)),
      });
      expect(verdict.healthy).toBe(false);
      expect(verdict.reason).toContain('service "frontend" is restarting');
    });

    // The headline non-regression: the recovery window must stay open across
    // an unreachable poll (containers cycling) and confirm once the relay
    // comes back, rather than failing on the first miss.
    it("tolerates the relay being unreachable on an early poll, then confirming", async () => {
      const relay = vi
        .fn()
        .mockRejectedValueOnce(new Error("relay timeout"))
        .mockResolvedValue({ app: { containers: jsonl(RUNNING_BACKEND) } });
      const sleep = vi.fn(noSleep);
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        attempts: 3,
        sleepImpl: sleep,
        requireHealthyEvidence: true,
        relayRequestImpl: relay,
      });
      expect(verdict.healthy).toBe(true);
      expect(sleep).toHaveBeenCalledTimes(1); // window stayed open past the miss
    });

    it("fails when containers are confirmed but the public route is down (404)", async () => {
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: "https://status.opentriologue.ai/",
        attempts: 2,
        sleepImpl: noSleep,
        requireHealthyEvidence: true,
        relayRequestImpl: relayReturning(jsonl(RUNNING_BACKEND)),
        fetchImpl: vi.fn().mockResolvedValue(okResponse(404)),
      });
      expect(verdict.healthy).toBe(false);
      expect(verdict.reason).toContain("returned HTTP 404");
    });
  });
});
