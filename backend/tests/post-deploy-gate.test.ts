import { describe, expect, it, vi } from "vitest";
import {
  parseComposePs,
  assessContainers,
  pendingContainers,
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
// A container whose Docker healthcheck has not resolved yet. Docker's
// default healthcheck timing can sit here for 90s+; a genuinely broken
// container can also report `unhealthy` well after this — the gate must not
// treat "starting" as clean evidence, but also must not fail a container
// that is simply still warming up.
const STARTING_WORKER = {
  Service: "worker",
  Name: "thd-worker-1",
  State: "running",
  Health: "starting",
  ExitCode: 0,
  Status: "Up 3 seconds (health: starting)",
};
const UNHEALTHY_WORKER = {
  ...STARTING_WORKER,
  Health: "unhealthy",
  Status: "Up 20 seconds (unhealthy)",
};
const HEALTHY_WORKER = {
  ...STARTING_WORKER,
  Health: "healthy",
  Status: "Up 25 seconds (healthy)",
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

describe("pendingContainers", () => {
  it("includes only RUNNING containers whose health is 'starting'", () => {
    const exitedStarting = { ...STARTING_WORKER, State: "exited", Status: "Exited (0) 2 seconds ago" };
    const deadStarting = { ...STARTING_WORKER, State: "dead" };
    // A paused container's healthcheck is suspended (could sit at "starting"
    // forever); a created one has not begun. Neither may hold a window open.
    const pausedStarting = { ...STARTING_WORKER, State: "paused" };
    const createdStarting = { ...STARTING_WORKER, State: "created" };
    const entries = parseComposePs(
      jsonl(RUNNING_BACKEND, STARTING_WORKER, exitedStarting, deadStarting, pausedStarting, createdStarting, HEALTHY_WORKER),
    );
    const pending = pendingContainers(entries);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.state).toBe("running");
    expect(pending[0]?.service).toBe("worker");
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

  // ── "starting" (unresolved healthcheck) is not evidence ──────────────────
  describe("pending 'starting' containers", () => {
    // AC1 — RED FIRST: this must fail against unmodified `main` (current code
    // treats "starting" as clean, so it passes healthy on the very first
    // poll). Recorded failing, then the fix below makes it pass.
    it("(AC1) fails when a container stuck 'starting' through the base window goes unhealthy on an extension poll", async () => {
      const relay = vi
        .fn()
        .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, STARTING_WORKER) } })
        .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, STARTING_WORKER) } })
        .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, STARTING_WORKER) } })
        .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, STARTING_WORKER) } })
        .mockResolvedValue({ app: { containers: jsonl(RUNNING_BACKEND, UNHEALTHY_WORKER) } });
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        sleepImpl: noSleep,
        relayRequestImpl: relay,
      });
      expect(verdict.healthy).toBe(false);
      expect(verdict.reason).toContain("health=unhealthy");
    });

    // AC2: resolves promptly — no waiting out the rest of the window once
    // the container settles.
    it("(AC2) resolves healthy as soon as a starting container settles, with no extra delay", async () => {
      const relay = vi
        .fn()
        .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, STARTING_WORKER) } })
        .mockResolvedValue({ app: { containers: jsonl(RUNNING_BACKEND, HEALTHY_WORKER) } });
      const sleep = vi.fn(noSleep);
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        sleepImpl: sleep,
        relayRequestImpl: relay,
      });
      expect(verdict.healthy).toBe(true);
      expect(sleep).toHaveBeenCalledTimes(1); // one retry was needed, no more
    });

    // AC3: the fast path (no container "starting" at all) is untouched.
    it("(AC3) a genuinely healthy first poll short-circuits with zero sleeps (no container pending)", async () => {
      const sleep = vi.fn(noSleep);
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        sleepImpl: sleep,
        relayRequestImpl: relayReturning(jsonl(RUNNING_BACKEND)), // Health: "healthy"
      });
      expect(verdict.healthy).toBe(true);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("(AC3) also short-circuits for a service with no healthcheck declared (Health: \"\")", async () => {
      const noHealthcheck = { ...RUNNING_BACKEND, Health: "" };
      const sleep = vi.fn(noSleep);
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        sleepImpl: sleep,
        relayRequestImpl: relayReturning(jsonl(noHealthcheck)),
      });
      expect(verdict.healthy).toBe(true);
      expect(sleep).not.toHaveBeenCalled();
    });

    // AC4: the extension is bounded — a container that never resolves still
    // passes (optimistic guarantee), but only after the documented budget,
    // and the verdict says so.
    it("(AC4) a permanently-'starting' container passes optimistically after the bounded extension, with a note naming it", async () => {
      const relay = vi.fn().mockResolvedValue({ app: { containers: jsonl(RUNNING_BACKEND, STARTING_WORKER) } });
      const sleep = vi.fn(noSleep);
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        sleepImpl: sleep,
        relayRequestImpl: relay,
      });
      expect(verdict.healthy).toBe(true);
      expect(relay).toHaveBeenCalledTimes(4 + 9); // default attempts + default pendingExtraAttempts
      expect(verdict.notes?.join(" ")).toContain("worker");
      expect(verdict.notes?.join(" ")).toContain("starting");
    });

    it("respects a custom pendingExtraAttempts bound", async () => {
      const relay = vi.fn().mockResolvedValue({ app: { containers: jsonl(RUNNING_BACKEND, STARTING_WORKER) } });
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        attempts: 2,
        pendingExtraAttempts: 3,
        sleepImpl: noSleep,
        relayRequestImpl: relay,
      });
      expect(verdict.healthy).toBe(true);
      expect(relay).toHaveBeenCalledTimes(2 + 3);
    });

    // A poll that cannot read container state (relay throw, empty ps) must
    // not end the pending watch: "could not look" is not "looked and found
    // clean". This was the reviewer's measured miss on the first version:
    // [starting, throw, unhealthy, ...] returned healthy at poll 2.
    it("keeps watching through a relay blip while a service was 'starting', and catches the later unhealthy", async () => {
      const relay = vi
        .fn()
        .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, STARTING_WORKER) } })
        .mockRejectedValueOnce(new Error("relay momentarily unreachable"))
        .mockResolvedValue({ app: { containers: jsonl(RUNNING_BACKEND, UNHEALTHY_WORKER) } });
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        sleepImpl: noSleep,
        relayRequestImpl: relay,
      });
      expect(verdict.healthy).toBe(false);
      expect(verdict.reason).toContain("health=unhealthy");
    });

    it("carries the pending watch through an empty ps read and still resolves healthy without a note", async () => {
      const relay = vi
        .fn()
        .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, STARTING_WORKER) } })
        .mockResolvedValueOnce({ app: { containers: arr() } })
        .mockResolvedValue({ app: { containers: jsonl(RUNNING_BACKEND, HEALTHY_WORKER) } });
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        sleepImpl: noSleep,
        relayRequestImpl: relay,
      });
      expect(verdict.healthy).toBe(true);
      expect(relay).toHaveBeenCalledTimes(3);
      expect(verdict.notes).toBeUndefined();
    });

    // The documented relay-blip tolerance is UNCHANGED when no service was
    // ever seen "starting": absence of bad news stays trustworthy.
    it("still passes instantly on a relay blip when no pending service was ever observed", async () => {
      const relay = vi.fn().mockRejectedValue(new Error("relay unreachable"));
      const sleep = vi.fn(noSleep);
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        sleepImpl: sleep,
        relayRequestImpl: relay,
      });
      expect(verdict.healthy).toBe(true);
      expect(sleep).not.toHaveBeenCalled();
    });

    // An offender observed earlier in the window is not silently dropped
    // when the window later exhausts pending-only: it rides in the note.
    it("names an earlier offender in the exhaustion note when the final polls are pending-only", async () => {
      const relay = vi
        .fn()
        .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, STARTING_WORKER) } })
        .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, UNHEALTHY_WORKER) } })
        .mockResolvedValue({ app: { containers: jsonl(RUNNING_BACKEND, STARTING_WORKER) } });
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        attempts: 3,
        pendingExtraAttempts: 3,
        sleepImpl: noSleep,
        relayRequestImpl: relay,
      });
      expect(verdict.healthy).toBe(true);
      expect(relay).toHaveBeenCalledTimes(3 + 3);
      const joined = verdict.notes?.join(" ") ?? "";
      expect(joined).toContain('"worker"');
      expect(joined).toContain("starting");
      expect(joined).toContain("earlier in this window");
      expect(joined).toContain("health=unhealthy");
    });

    // Kills the carry-note mutants: exhausting the window on a CARRY final
    // poll must produce the carry-specific text with the service name
    // retained from the earlier readable poll, and mark the verdict
    // unconfirmed.
    it("exhausting on a carry poll emits the carry note with the retained service name and unconfirmed=true", async () => {
      const relay = vi
        .fn()
        .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, STARTING_WORKER) } })
        .mockRejectedValue(new Error("relay dark"));
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        attempts: 2,
        pendingExtraAttempts: 2,
        sleepImpl: noSleep,
        relayRequestImpl: relay,
      });
      expect(verdict.healthy).toBe(true);
      expect(verdict.unconfirmed).toBe(true);
      expect(relay).toHaveBeenCalledTimes(4);
      expect(verdict.notes).toEqual([
        'could not re-read container state while "worker" was still "starting"; passing optimistically after 4 polls',
      ]);
    });

    it("the carry note names the MOST RECENT pending service, not the first", async () => {
      const startingCache = { ...STARTING_WORKER, Service: "cache", Name: "thd-cache-1" };
      const relay = vi
        .fn()
        .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, STARTING_WORKER) } })
        .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, HEALTHY_WORKER, startingCache) } })
        .mockRejectedValue(new Error("relay dark"));
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        attempts: 2,
        pendingExtraAttempts: 2,
        sleepImpl: noSleep,
        relayRequestImpl: relay,
      });
      expect(verdict.healthy).toBe(true);
      const joined = verdict.notes?.join(" ") ?? "";
      expect(joined).toContain('"cache"');
      expect(joined).not.toContain('"worker"');
    });

    // An offender that recovers still leaves a trace on the healthy early
    // return -- and the same holds when the poll after the offender is
    // unreadable with no pending ever seen (the decided behavior: the
    // relay-blip tolerance keeps the pass, the note keeps the evidence).
    it("a recovered offender rides into the early-return notes", async () => {
      const relay = vi
        .fn()
        .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, UNHEALTHY_WORKER) } })
        .mockResolvedValue({ app: { containers: jsonl(RUNNING_BACKEND, HEALTHY_WORKER) } });
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        sleepImpl: noSleep,
        relayRequestImpl: relay,
      });
      expect(verdict.healthy).toBe(true);
      expect(verdict.notes?.join(" ")).toContain("earlier in this window");
      expect(verdict.notes?.join(" ")).toContain("health=unhealthy");
    });

    it("offender followed by an unreadable poll (no pending ever) passes with the offender noted", async () => {
      const relay = vi
        .fn()
        .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, UNHEALTHY_WORKER) } })
        .mockRejectedValue(new Error("relay blip"));
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        sleepImpl: noSleep,
        relayRequestImpl: relay,
      });
      expect(verdict.healthy).toBe(true);
      expect(verdict.notes?.join(" ")).toContain("earlier in this window");
      expect(verdict.notes?.join(" ")).toContain("health=unhealthy");
    });

    it("a route failure during a carry poll wins over the carry: unhealthy, no extension", async () => {
      const relay = vi
        .fn()
        .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, STARTING_WORKER) } })
        .mockRejectedValue(new Error("relay dark"));
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(okResponse(200))
        .mockResolvedValue(okResponse(502));
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: "https://thd.example.com/",
        attempts: 2,
        pendingExtraAttempts: 5,
        sleepImpl: noSleep,
        relayRequestImpl: relay,
        fetchImpl,
        lookupImpl: publicLookup,
      });
      expect(verdict.healthy).toBe(false);
      expect(verdict.reason).toContain("HTTP 502");
      expect(relay).toHaveBeenCalledTimes(2);
    });

    it("strict mode ignores the carry machinery: exactly `attempts` polls, fail closed", async () => {
      const relay = vi
        .fn()
        .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, STARTING_WORKER) } })
        .mockRejectedValue(new Error("relay dark"));
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        attempts: 2,
        pendingExtraAttempts: 5,
        requireHealthyEvidence: true,
        sleepImpl: noSleep,
        relayRequestImpl: relay,
      });
      expect(verdict.healthy).toBe(false);
      expect(relay).toHaveBeenCalledTimes(2);
    });

    it("pendingExtraAttempts: 0 disables the extension but keeps the note", async () => {
      const relay = vi.fn().mockResolvedValue({ app: { containers: jsonl(RUNNING_BACKEND, STARTING_WORKER) } });
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        attempts: 2,
        pendingExtraAttempts: 0,
        sleepImpl: noSleep,
        relayRequestImpl: relay,
      });
      expect(verdict.healthy).toBe(true);
      expect(relay).toHaveBeenCalledTimes(2);
      expect(verdict.notes?.join(" ")).toContain("starting");
    });

    // Recovery semantics preserved: an offender seen mid-window doesn't cut
    // the loop short if it later resolves.
    it("recovers to healthy after a mid-window unhealthy blip inside the (possibly extended) window", async () => {
      const relay = vi
        .fn()
        .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, STARTING_WORKER) } })
        .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, STARTING_WORKER) } })
        .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, STARTING_WORKER) } })
        .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, STARTING_WORKER) } })
        .mockResolvedValueOnce({ app: { containers: jsonl(RUNNING_BACKEND, UNHEALTHY_WORKER) } })
        .mockResolvedValue({ app: { containers: jsonl(RUNNING_BACKEND, HEALTHY_WORKER) } });
      const verdict = await verifyDeployHealth({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: null,
        sleepImpl: noSleep,
        relayRequestImpl: relay,
      });
      expect(verdict.healthy).toBe(true);
    });

    describe("requireHealthyEvidence (strict mode)", () => {
      it("does NOT treat a 'starting' container as positive confirmation; an all-starting window fails closed", async () => {
        const verdict = await verifyDeployHealth({
          serverId: "srv-a",
          appName: "thd",
          liveUrl: null,
          attempts: 2,
          sleepImpl: noSleep,
          requireHealthyEvidence: true,
          relayRequestImpl: relayReturning(jsonl(RUNNING_BACKEND, STARTING_WORKER)),
        });
        expect(verdict.healthy).toBe(false);
        // The reason must name the distinct still-starting cause (mutation
        // probe: falling through to the generic "no running containers
        // found" text must turn this red).
        expect(verdict.reason).toContain("health=starting");
        expect(verdict.reason).toContain('"worker"');
      });
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
