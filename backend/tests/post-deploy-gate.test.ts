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
// Inject a deterministic resolver so the SSRF guard sees the hostnames in
// these tests as public, without touching real DNS.
const publicLookup = async () => [{ address: "93.184.216.34" }];
const privateLookup = async () => [{ address: "10.0.0.5" }];

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
    const v = await probeRoute("https://x.test/", { fetchImpl: vi.fn().mockResolvedValue(okResponse(200)), lookupImpl: publicLookup });
    expect(v).toEqual({ ok: true, status: 200 });
  });

  it("not ok for a 404 (Traefik no-backend — the incident), carrying the status", async () => {
    const v = await probeRoute("https://x.test/", { fetchImpl: vi.fn().mockResolvedValue(okResponse(404)), lookupImpl: publicLookup });
    expect(v).toEqual({ ok: false, status: 404 });
  });

  it("not ok for a 503 (Traefik no healthy upstream)", async () => {
    const v = await probeRoute("https://x.test/", { fetchImpl: vi.fn().mockResolvedValue(okResponse(503)), lookupImpl: publicLookup });
    expect(v).toEqual({ ok: false, status: 503 });
  });

  it("OK for a 401/403 — a backend answered through Traefik, the route is wired (just auth-gated)", async () => {
    expect((await probeRoute("https://x.test/", { fetchImpl: vi.fn().mockResolvedValue(okResponse(401)), lookupImpl: publicLookup })).ok).toBe(true);
    expect((await probeRoute("https://x.test/", { fetchImpl: vi.fn().mockResolvedValue(okResponse(403)), lookupImpl: publicLookup })).ok).toBe(true);
  });

  it("not ok on a transport error, carrying the message", async () => {
    const v = await probeRoute("https://x.test/", { fetchImpl: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")), lookupImpl: publicLookup });
    expect(v.ok).toBe(false);
    expect(v.error).toContain("ECONNREFUSED");
  });

  it("REFUSES (does not fetch) a URL whose host resolves to a private address", async () => {
    const fetchImpl = vi.fn();
    const v = await probeRoute("https://internal.example.com/", { fetchImpl, lookupImpl: privateLookup });
    expect(v).toMatchObject({ ok: true, refused: true });
    expect(v.error).toContain("non-public address");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("REFUSES a literal loopback URL without any DNS lookup", async () => {
    const fetchImpl = vi.fn();
    const lookupImpl = vi.fn();
    const v = await probeRoute("http://127.0.0.1:9000/", { fetchImpl, lookupImpl });
    expect(v).toMatchObject({ ok: true, refused: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lookupImpl).not.toHaveBeenCalled();
  });

  it("REFUSES alternate IPv4 encodings of loopback (hex / decimal / userinfo)", async () => {
    const fetchImpl = vi.fn();
    // new URL() normalizes all of these to 127.0.0.1 before the guard sees them.
    for (const url of ["http://0x7f000001/", "http://2130706433/", "http://public@127.0.0.1/"]) {
      const v = await probeRoute(url, { fetchImpl, lookupImpl: vi.fn() });
      expect(v, url).toMatchObject({ ok: true, refused: true });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("REFUSES a bracketed internal IPv6 literal, allows a bracketed public IPv6 literal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(200));
    const refused = await probeRoute("http://[::1]/", { fetchImpl, lookupImpl: vi.fn() });
    expect(refused).toMatchObject({ ok: true, refused: true });

    const probed = await probeRoute("https://[2606:4700:4700::1111]/", { fetchImpl, lookupImpl: vi.fn() });
    expect(probed).toEqual({ ok: true, status: 200 }); // public literal is probed, not refused
  });

  it("fails CLOSED when the host cannot be resolved (refused, never fetched)", async () => {
    const fetchImpl = vi.fn();
    const v = await probeRoute("https://nope.example.com/", { fetchImpl, lookupImpl: async () => { throw new Error("ENOTFOUND"); } });
    expect(v).toMatchObject({ ok: true, refused: true });
    expect(v.error).toContain("could not resolve");
    expect(fetchImpl).not.toHaveBeenCalled();
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
      lookupImpl: publicLookup,
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
      lookupImpl: publicLookup,
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
      lookupImpl: publicLookup,
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
      lookupImpl: publicLookup,
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
        lookupImpl: publicLookup,
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

  // ── SSRF guard surfacing ─────────────────────────────────────────────────
  describe("SSRF-guarded route probe", () => {
    it("does not fail the deploy when the route is SSRF-refused; surfaces it as a note and never fetches", async () => {
      const fetchImpl = vi.fn();
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: "https://internal.example.com/",
        lookupImpl: privateLookup, // resolves to 10.0.0.5
        attempts: 2,
        sleepImpl: noSleep,
        relayRequestImpl: relayReturning(jsonl(RUNNING_BACKEND)),
        fetchImpl,
      });
      expect(verdict.healthy).toBe(true);
      expect(fetchImpl).not.toHaveBeenCalled(); // never probed the internal host
      expect(verdict.notes?.join(" ")).toContain("route probe skipped");
      expect(verdict.notes?.join(" ")).toContain("non-public address");
    });

    it("carries the SSRF note onto an unhealthy verdict too (crashloop + refused route)", async () => {
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: "http://127.0.0.1:9000/",
        lookupImpl: vi.fn(), // literal loopback — no lookup needed
        attempts: 2,
        sleepImpl: noSleep,
        relayRequestImpl: relayReturning(jsonl(RUNNING_BACKEND, RESTARTING_FRONTEND)),
      });
      expect(verdict.healthy).toBe(false);
      expect(verdict.reason).toContain('service "frontend" is restarting');
      expect(verdict.notes?.join(" ")).toContain("route probe skipped");
    });
  });
});
