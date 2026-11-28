/**
 * Concurrent bursts against requireAuth's awaited credential lookups (a `dp_`
 * key, a `user_session` cookie). Every request of a burst passes the blocked
 * check before the first lookup resolves, so the failure budget alone bounds
 * only sequential failures. Lookup slots (lib/login-rate-limit.ts) bound the
 * lookups in flight per client key to the remaining budget.
 *
 * Rules pinned here:
 * - a burst of failing lookups gets exactly LOGIN_RATE_MAX minus the failures
 *   already counted evaluated, the rest answer 429 as a sequential client
 *   would; no lookup starts once the budget is spent;
 * - a burst of valid presentations is delayed, never refused: all succeed,
 *   nothing is recorded, no cookie is cleared;
 * - a lookup that throws releases its slot without recording or clearing;
 * - the per-key waiter cap and the wait timeout answer 503 auth_busy with
 *   Retry-After: 1, record nothing and clear no cookie;
 * - the slot state is empty once a burst is over.
 *
 * Lookups are held on controllable promises; direct app.request() calls have
 * no socket, so every request lands on the shared "unknown" key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
    deploy: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    apiKey: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    session: { findUnique: vi.fn() },
    user: { upsert: vi.fn() },
  },
}));

vi.mock("../src/config/index.js", () => ({
  config: {
    NODE_ENV: "test",
    PANEL_TOKEN: "panel-token-must-be-16chars",
    SESSION_SECRET: "session-secret-must-be-16chars",
    CORS_ORIGINS: "http://localhost:3000",
    FRONTEND_URL: "http://localhost:3000",
    PORT: 3001,
    ALLOWED_GITHUB_LOGINS: "",
  },
  allowedGitHubLogins: [],
}));

import { prisma } from "../src/lib/prisma.js";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/middleware/auth.js";
import { _resetPanelSessions } from "../src/lib/panel-session.js";
import {
  LOGIN_RATE_MAX,
  LOGIN_RATE_WINDOW_MS,
  LOOKUP_WAITERS_MAX,
  LOOKUP_WAIT_TIMEOUT_MS,
  UNKNOWN_CLIENT_KEY,
  _loginFailureCount,
  _lookupSlotStateSize,
  _lookupSlotsInFlight,
  _resetLoginRateLimit,
  _resetLookupSlots,
  _setLookupSlotLimits,
  _lookupSlotWaiters,
  _recentFailures,
  _setLoginFailures,
  checkLoginBlocked,
  acquireLookupSlot,
  recordLoginFailure,
} from "../src/lib/login-rate-limit.js";

const CLEAR = "panel_session=; Path=/; HttpOnly; Max-Age=0";
const CLEAR_USER = "user_session=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/";
const VALID_KEY = "dp_valid_key";
const WRONG_KEY = "dp_wrong_key";
const LIVE_USER = "user_session=live";
const VALID_API_KEY = { id: "k1", name: "ci", userId: null, revokedAt: null };
const LIVE_SESSION = () => ({ userId: "u1", expiresAt: new Date(Date.now() + 60_000) });

const mApiKey = prisma.apiKey as unknown as { findUnique: ReturnType<typeof vi.fn> };
const mSession = prisma.session as unknown as { findUnique: ReturnType<typeof vi.fn> };

const app = createApp("http://localhost:3000");

const servers = (headers: Record<string, string>) => app.request("/api/servers", { headers });
const failures = () => _loginFailureCount(UNKNOWN_CLIENT_KEY);

/** Turn the event loop until `cond` holds (or fail after many turns). */
async function until(cond: () => boolean, turns = 500): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("condition not reached");
}

/** A few event-loop turns, so every pending request moves as far as it can. */
async function settle(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
}

interface Held {
  args: { where: { keyHash?: string; tokenHash?: string } };
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

/** Make `mock` hold every call on a promise the test resolves; tracks the concurrency. */
function holdCalls(mock: ReturnType<typeof vi.fn>) {
  const t = { held: [] as Held[], inFlight: 0, maxInFlight: 0 };
  mock.mockImplementation(
    (args: Held["args"]) =>
      new Promise((resolve, reject) => {
        t.inFlight++;
        t.maxInFlight = Math.max(t.maxInFlight, t.inFlight);
        const done = () => {
          t.inFlight--;
        };
        t.held.push({
          args,
          resolve: (v) => {
            done();
            resolve(v);
          },
          reject: (e) => {
            done();
            reject(e);
          },
        });
      }),
  );
  return t;
}

/**
 * Resolve the held calls one at a time (oldest first), letting the burst move
 * after each, until every request answered. `answer` decides each call's
 * outcome. `onStep` runs after every step, for invariants that must hold at
 * every point of the burst.
 */
async function drain(
  t: ReturnType<typeof holdCalls>,
  responses: Promise<Response>[],
  answer: (h: Held) => { value?: unknown; error?: unknown },
  onStep: () => void = () => {},
): Promise<Response[]> {
  let finished = 0;
  responses.forEach((p) => p.then(() => finished++, () => finished++));
  await settle();
  onStep();
  while (finished < responses.length) {
    const h = t.held.shift();
    if (!h) {
      await settle();
      if (t.held.length === 0 && finished < responses.length) throw new Error("burst stalled");
      continue;
    }
    const a = answer(h);
    if ("error" in a) h.reject(a.error);
    else h.resolve(a.value);
    await settle();
    onStep();
  }
  return Promise.all(responses);
}

const statuses = (res: Response[]) => res.map((r) => r.status);
const count = (res: Response[], status: number) => res.filter((r) => r.status === status).length;

beforeEach(() => {
  vi.clearAllMocks();
  _resetLoginRateLimit();
  _resetLookupSlots();
  _resetPanelSessions();
  mApiKey.findUnique.mockResolvedValue(null);
  mSession.findUnique.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  // Every burst leaves no slot state behind.
  expect(_lookupSlotStateSize()).toBe(0);
  _resetLookupSlots();
});

describe("burst of wrong dp_ keys", () => {
  it("starts at most LOGIN_RATE_MAX lookups, records exactly that many, the rest answer 429", async () => {
    const t = holdCalls(mApiKey.findUnique);
    const N = 30;
    const res = Array.from({ length: N }, () => servers({ Authorization: `Bearer ${WRONG_KEY}` }));
    await until(() => t.held.length === LOGIN_RATE_MAX);
    await settle();
    expect(mApiKey.findUnique).toHaveBeenCalledTimes(LOGIN_RATE_MAX);
    expect(_lookupSlotsInFlight(UNKNOWN_CLIENT_KEY)).toBe(LOGIN_RATE_MAX);

    const done = await drain(t, res, () => ({ value: null }), () => {
      // At no point more lookups started than the budget allows.
      expect(mApiKey.findUnique.mock.calls.length).toBeLessThanOrEqual(LOGIN_RATE_MAX);
      expect(failures() + t.inFlight).toBeLessThanOrEqual(LOGIN_RATE_MAX);
    });
    expect(mApiKey.findUnique).toHaveBeenCalledTimes(LOGIN_RATE_MAX);
    expect(failures()).toBe(LOGIN_RATE_MAX);
    expect(count(done, 401)).toBe(LOGIN_RATE_MAX);
    expect(count(done, 429)).toBe(N - LOGIN_RATE_MAX);
    for (const r of done.filter((r) => r.status === 429)) {
      expect(await r.json()).toMatchObject({ error: "rate_limited" });
      expect(Number(r.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    }
  });

  it("resolving all held lookups at once gives the same bound", async () => {
    const t = holdCalls(mApiKey.findUnique);
    const N = 30;
    const res = Array.from({ length: N }, () => servers({ Authorization: `Bearer ${WRONG_KEY}` }));
    await until(() => t.held.length === LOGIN_RATE_MAX);
    for (const h of t.held.splice(0)) h.resolve(null);
    const done = await drain(t, res, () => ({ value: null }));
    expect(mApiKey.findUnique).toHaveBeenCalledTimes(LOGIN_RATE_MAX);
    expect(failures()).toBe(LOGIN_RATE_MAX);
    expect(count(done, 401)).toBe(LOGIN_RATE_MAX);
    expect(count(done, 429)).toBe(N - LOGIN_RATE_MAX);
  });
});

describe("burst of user_session cookies whose session lookup misses", () => {
  it("starts at most LOGIN_RATE_MAX lookups and clears the cookie on every 401 and 429", async () => {
    const t = holdCalls(mSession.findUnique);
    const N = 30;
    const res = Array.from({ length: N }, () => servers({ Cookie: LIVE_USER }));
    await until(() => t.held.length === LOGIN_RATE_MAX);
    await settle();
    expect(mSession.findUnique).toHaveBeenCalledTimes(LOGIN_RATE_MAX);

    const done = await drain(t, res, () => ({ value: null }), () => {
      expect(mSession.findUnique.mock.calls.length).toBeLessThanOrEqual(LOGIN_RATE_MAX);
    });
    expect(mSession.findUnique).toHaveBeenCalledTimes(LOGIN_RATE_MAX);
    expect(failures()).toBe(LOGIN_RATE_MAX);
    expect(count(done, 401)).toBe(LOGIN_RATE_MAX);
    expect(count(done, 429)).toBe(N - LOGIN_RATE_MAX);
    for (const r of done) expect(r.headers.getSetCookie()).toEqual([CLEAR_USER]);
    for (const r of done.filter((r) => r.status === 429)) {
      expect(Number(r.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("failures already counted shrink the burst's budget", () => {
  for (const f of [1, 7, 9]) {
    it(`with ${f} recorded, a burst of wrong dp_ keys gets exactly ${LOGIN_RATE_MAX - f} evaluated`, async () => {
      for (let i = 0; i < f; i++) recordLoginFailure(UNKNOWN_CLIENT_KEY);
      const t = holdCalls(mApiKey.findUnique);
      const N = 30;
      const res = Array.from({ length: N }, () => servers({ Authorization: `Bearer ${WRONG_KEY}` }));
      await until(() => t.held.length === LOGIN_RATE_MAX - f);
      await settle();
      expect(mApiKey.findUnique).toHaveBeenCalledTimes(LOGIN_RATE_MAX - f);
      const done = await drain(t, res, () => ({ value: null }));
      expect(mApiKey.findUnique).toHaveBeenCalledTimes(LOGIN_RATE_MAX - f);
      expect(failures()).toBe(LOGIN_RATE_MAX);
      expect(count(done, 401)).toBe(LOGIN_RATE_MAX - f);
      expect(count(done, 429)).toBe(N - (LOGIN_RATE_MAX - f));
    });
  }

  it("with 7 recorded, a burst of missing user_sessions gets exactly 3 evaluated", async () => {
    for (let i = 0; i < 7; i++) recordLoginFailure(UNKNOWN_CLIENT_KEY);
    const t = holdCalls(mSession.findUnique);
    const res = Array.from({ length: 20 }, () => servers({ Cookie: LIVE_USER }));
    const done = await drain(t, res, () => ({ value: null }));
    expect(mSession.findUnique).toHaveBeenCalledTimes(3);
    expect(count(done, 401)).toBe(3);
    expect(count(done, 429)).toBe(17);
  });
});

describe("burst of valid presentations is delayed, never refused", () => {
  for (const f of [0, 9]) {
    it(`30 valid dp_ keys with ${f} recorded failures all pass, at most ${LOGIN_RATE_MAX - f} at once`, async () => {
      for (let i = 0; i < f; i++) recordLoginFailure(UNKNOWN_CLIENT_KEY);
      const t = holdCalls(mApiKey.findUnique);
      const res = Array.from({ length: 30 }, () => servers({ Authorization: `Bearer ${VALID_KEY}` }));
      const done = await drain(t, res, () => ({ value: VALID_API_KEY }));
      expect(statuses(done)).toEqual(Array(30).fill(200));
      expect(mApiKey.findUnique).toHaveBeenCalledTimes(30);
      expect(t.maxInFlight).toBe(LOGIN_RATE_MAX - f);
      expect(failures()).toBe(f);
      for (const r of done) expect(r.headers.getSetCookie()).toEqual([]);
    });

    it(`30 valid user_sessions with ${f} recorded failures all pass, at most ${LOGIN_RATE_MAX - f} at once`, async () => {
      for (let i = 0; i < f; i++) recordLoginFailure(UNKNOWN_CLIENT_KEY);
      const t = holdCalls(mSession.findUnique);
      const res = Array.from({ length: 30 }, () => servers({ Cookie: LIVE_USER }));
      const done = await drain(t, res, () => ({ value: LIVE_SESSION() }));
      expect(statuses(done)).toEqual(Array(30).fill(200));
      expect(mSession.findUnique).toHaveBeenCalledTimes(30);
      expect(t.maxInFlight).toBe(LOGIN_RATE_MAX - f);
      expect(failures()).toBe(f);
      for (const r of done) expect(r.headers.getSetCookie()).toEqual([]);
    });
  }
});

describe("mixed burst of valid and wrong dp_ keys", () => {
  const isValid = (h: Held) => h.args.where.keyHash === hashApiKey(VALID_KEY);

  it("valid requests queued behind the budget being spent answer 429", async () => {
    const t = holdCalls(mApiKey.findUnique);
    // Order matters: the wrong keys take every slot, the valid ones queue.
    const wrong = Array.from({ length: LOGIN_RATE_MAX }, () =>
      servers({ Authorization: `Bearer ${WRONG_KEY}` }),
    );
    await until(() => t.held.length === LOGIN_RATE_MAX);
    const valid = Array.from({ length: 5 }, () => servers({ Authorization: `Bearer ${VALID_KEY}` }));
    await settle();
    expect(mApiKey.findUnique).toHaveBeenCalledTimes(LOGIN_RATE_MAX);
    const done = await drain(t, [...wrong, ...valid], (h) => ({ value: isValid(h) ? VALID_API_KEY : null }));
    expect(statuses(done.slice(0, LOGIN_RATE_MAX))).toEqual(Array(LOGIN_RATE_MAX).fill(401));
    expect(statuses(done.slice(LOGIN_RATE_MAX))).toEqual(Array(5).fill(429));
    // The queued valid keys were never looked up.
    expect(mApiKey.findUnique).toHaveBeenCalledTimes(LOGIN_RATE_MAX);
    expect(failures()).toBe(LOGIN_RATE_MAX);
  });

  it("interleaved: valid keys never record, wrong keys record at most the remaining budget", async () => {
    const f = 5;
    for (let i = 0; i < f; i++) recordLoginFailure(UNKNOWN_CLIENT_KEY);
    const t = holdCalls(mApiKey.findUnique);
    const kinds = Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? WRONG_KEY : VALID_KEY));
    const res = kinds.map((k) => servers({ Authorization: `Bearer ${k}` }));
    const done = await drain(
      t,
      res,
      (h) => ({ value: isValid(h) ? VALID_API_KEY : null }),
      () => expect(failures() + t.inFlight).toBeLessThanOrEqual(LOGIN_RATE_MAX),
    );
    const wrongRes = done.filter((_, i) => kinds[i] === WRONG_KEY);
    const validRes = done.filter((_, i) => kinds[i] === VALID_KEY);
    expect(count(wrongRes, 401)).toBe(LOGIN_RATE_MAX - f);
    expect(count(wrongRes, 401) + count(wrongRes, 429)).toBe(wrongRes.length);
    expect(count(validRes, 401)).toBe(0);
    expect(count(validRes, 200) + count(validRes, 429)).toBe(validRes.length);
    expect(failures()).toBe(LOGIN_RATE_MAX);
    // Lookups ran for every 401 and every 200, never for a 429.
    expect(mApiKey.findUnique).toHaveBeenCalledTimes(count(done, 401) + count(done, 200));
    // FIFO: a valid key answered 429 only after every earlier wrong key was evaluated or refused,
    // so no valid key that arrived before the budget was spent was refused for it.
    const firstValid429 = done.findIndex((r, i) => kinds[i] === VALID_KEY && r.status === 429);
    const lastWrong401 = done.map((r, i) => kinds[i] === WRONG_KEY && r.status === 401).lastIndexOf(true);
    if (firstValid429 !== -1) expect(firstValid429).toBeGreaterThan(lastWrong401);
  });
});

describe("a lookup that throws", () => {
  it("releases its slot without recording or clearing: a burst of 30 throwing lookups all run", async () => {
    const t = holdCalls(mSession.findUnique);
    const res = Array.from({ length: 30 }, () => servers({ Cookie: LIVE_USER }));
    const done = await drain(t, res, () => ({ error: new Error("db down") }), () => {
      expect(t.inFlight).toBeLessThanOrEqual(LOGIN_RATE_MAX);
    });
    expect(statuses(done)).toEqual(Array(30).fill(500));
    expect(mSession.findUnique).toHaveBeenCalledTimes(30);
    expect(failures()).toBe(0);
    for (const r of done) expect(r.headers.getSetCookie()).toEqual([]);
  });

  it("after 10 concurrent throwing dp_ lookups the next request is evaluated, not blocked", async () => {
    const t = holdCalls(mApiKey.findUnique);
    const res = Array.from({ length: LOGIN_RATE_MAX }, () => servers({ Authorization: `Bearer ${WRONG_KEY}` }));
    const done = await drain(t, res, () => ({ error: new Error("db down") }));
    expect(statuses(done)).toEqual(Array(LOGIN_RATE_MAX).fill(500));
    expect(failures()).toBe(0);
    expect(_lookupSlotsInFlight(UNKNOWN_CLIENT_KEY)).toBe(0);

    mApiKey.findUnique.mockReset();
    mApiKey.findUnique.mockResolvedValue(null);
    const next = await servers({ Authorization: `Bearer ${WRONG_KEY}` });
    expect(next.status).toBe(401);
    expect(mApiKey.findUnique).toHaveBeenCalledTimes(1);
    expect(failures()).toBe(1);
  });
});

describe("waiter cap and wait timeout", () => {
  const expectBusy = async (r: Response) => {
    expect(r.status).toBe(503);
    expect(r.headers.get("Retry-After")).toBe("1");
    expect(r.headers.getSetCookie()).toEqual([]);
    expect(await r.json()).toMatchObject({ error: "auth_busy" });
  };

  it("pins the defaults: 100 waiters per key, 10 s wait", () => {
    expect(LOOKUP_WAITERS_MAX).toBe(100);
    expect(LOOKUP_WAIT_TIMEOUT_MS).toBe(10_000);
  });

  it("a request beyond the lowered waiter cap answers 503 auth_busy, records and clears nothing", async () => {
    _setLookupSlotLimits({ waitersMax: 3 });
    const t = holdCalls(mSession.findUnique);
    const res = Array.from({ length: LOGIN_RATE_MAX + 3 + 2 }, () => servers({ Cookie: LIVE_USER }));
    await until(() => t.held.length === LOGIN_RATE_MAX);
    await settle();
    const early = await Promise.race([
      Promise.all(res.slice(-2)),
      new Promise<null>((r) => setTimeout(() => r(null), 200)),
    ]);
    expect(early).not.toBeNull();
    for (const r of early!) await expectBusy(r);
    expect(failures()).toBe(0);
    const done = await drain(t, res, () => ({ value: LIVE_SESSION() }));
    expect(count(done, 200)).toBe(LOGIN_RATE_MAX + 3);
    expect(count(done, 503)).toBe(2);
    expect(failures()).toBe(0);
  });

  it("the default cap: the 101st waiter of a key answers 503", async () => {
    const t = holdCalls(mApiKey.findUnique);
    const total = LOGIN_RATE_MAX + LOOKUP_WAITERS_MAX + 1;
    const res = Array.from({ length: total }, () => servers({ Authorization: `Bearer ${VALID_KEY}` }));
    await until(() => t.held.length === LOGIN_RATE_MAX);
    await settle();
    await expectBusy(await res[total - 1]);
    const done = await drain(t, res, () => ({ value: VALID_API_KEY }));
    expect(count(done, 200)).toBe(total - 1);
    expect(count(done, 503)).toBe(1);
    expect(failures()).toBe(0);
  });

  it("a waiter that waits longer than the lowered timeout answers 503, records and clears nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    _setLookupSlotLimits({ waitTimeoutMs: 50 });
    const t = holdCalls(mSession.findUnique);
    const res = Array.from({ length: LOGIN_RATE_MAX + 2 }, () => servers({ Cookie: LIVE_USER }));
    await until(() => t.held.length === LOGIN_RATE_MAX);
    await settle();
    let answered = 0;
    res.forEach((p) => p.then(() => answered++));
    vi.advanceTimersByTime(49);
    await settle();
    expect(answered).toBe(0);
    vi.advanceTimersByTime(1);
    await settle();
    expect(answered).toBe(2);
    for (const r of await Promise.all(res.slice(-2))) await expectBusy(r);
    expect(failures()).toBe(0);
    const done = await drain(t, res, () => ({ value: LIVE_SESSION() }));
    expect(count(done, 200)).toBe(LOGIN_RATE_MAX);
    expect(count(done, 503)).toBe(2);
  });

  it("the default timeout: a waiter is refused after 10 s, not before", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = holdCalls(mApiKey.findUnique);
    const res = Array.from({ length: LOGIN_RATE_MAX + 1 }, () => servers({ Authorization: `Bearer ${VALID_KEY}` }));
    await until(() => t.held.length === LOGIN_RATE_MAX);
    await settle();
    let answered = false;
    res[LOGIN_RATE_MAX].then(() => (answered = true));
    vi.advanceTimersByTime(LOOKUP_WAIT_TIMEOUT_MS - 1);
    await settle();
    expect(answered).toBe(false);
    vi.advanceTimersByTime(1);
    await settle();
    await expectBusy(await res[LOGIN_RATE_MAX]);
    const done = await drain(t, res, () => ({ value: VALID_API_KEY }));
    expect(count(done, 200)).toBe(LOGIN_RATE_MAX);
  });

  it("a waiter that gets a slot before the timeout is not refused later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    _setLookupSlotLimits({ waitTimeoutMs: 50 });
    const t = holdCalls(mApiKey.findUnique);
    const res = Array.from({ length: LOGIN_RATE_MAX + 1 }, () => servers({ Authorization: `Bearer ${VALID_KEY}` }));
    await until(() => t.held.length === LOGIN_RATE_MAX);
    await settle();
    t.held.shift()!.resolve(VALID_API_KEY);
    await until(() => t.held.length === LOGIN_RATE_MAX);
    vi.advanceTimersByTime(1000);
    const done = await drain(t, res, () => ({ value: VALID_API_KEY }));
    expect(statuses(done)).toEqual(Array(LOGIN_RATE_MAX + 1).fill(200));
  });
});

describe("acquireLookupSlot", () => {
  const KEY = "203.0.113.50";

  it("drops the key's state once the last slot is released", async () => {
    const a = await acquireLookupSlot(KEY);
    const b = await acquireLookupSlot(KEY);
    expect(_lookupSlotStateSize()).toBe(1);
    expect(_lookupSlotsInFlight(KEY)).toBe(2);
    if (a.status !== "acquired" || b.status !== "acquired") throw new Error("not acquired");
    a.slot.release();
    expect(_lookupSlotStateSize()).toBe(1);
    b.slot.fail();
    expect(_lookupSlotStateSize()).toBe(0);
    expect(_loginFailureCount(KEY)).toBe(1);
  });

  it("fail and release take effect once: a second call releases and records nothing", async () => {
    const a = await acquireLookupSlot(KEY);
    const b = await acquireLookupSlot(KEY);
    if (a.status !== "acquired" || b.status !== "acquired") throw new Error("not acquired");
    a.slot.fail();
    a.slot.fail();
    a.slot.release();
    expect(_loginFailureCount(KEY)).toBe(1);
    expect(_lookupSlotsInFlight(KEY)).toBe(1);
    b.slot.release();
    expect(_lookupSlotStateSize()).toBe(0);
  });

  it("answers blocked without holding a slot once the budget is spent", async () => {
    for (let i = 0; i < LOGIN_RATE_MAX; i++) recordLoginFailure(KEY);
    const r = await acquireLookupSlot(KEY);
    expect(r.status).toBe("blocked");
    expect(_lookupSlotStateSize()).toBe(0);
  });

  it("hands slots to waiters in arrival order", async () => {
    const held = [];
    for (let i = 0; i < LOGIN_RATE_MAX; i++) held.push(await acquireLookupSlot(KEY));
    const order: number[] = [];
    const waiting = [0, 1, 2].map((i) =>
      acquireLookupSlot(KEY).then((r) => {
        order.push(i);
        return r;
      }),
    );
    for (const h of held) if (h.status === "acquired") h.slot.release();
    const got = await Promise.all(waiting);
    expect(order).toEqual([0, 1, 2]);
    for (const g of got) if (g.status === "acquired") g.slot.release();
    expect(_lookupSlotStateSize()).toBe(0);
  });

  it("keys are independent: one key's full slots do not hold another key", async () => {
    const held = [];
    for (let i = 0; i < LOGIN_RATE_MAX; i++) held.push(await acquireLookupSlot(KEY));
    const other = await acquireLookupSlot("198.51.100.9");
    expect(other.status).toBe("acquired");
    if (other.status === "acquired") other.slot.release();
    for (const h of held) if (h.status === "acquired") h.slot.release();
    expect(_lookupSlotStateSize()).toBe(0);
  });
});

describe("synchronous comparisons next to the lookups", () => {
  it("mixed burst: failures of synchronous comparisons are not held back by the slots (pinned at twice the budget)", async () => {
    const t = holdCalls(mApiKey.findUnique);
    const lookups = Array.from({ length: LOGIN_RATE_MAX }, () =>
      servers({ Authorization: `Bearer ${WRONG_KEY}` }),
    );
    await until(() => t.held.length === LOGIN_RATE_MAX);
    // Wrong non-dp_ Bearers take no slot: each one is compared and recorded
    // until the recorded failures alone reach the budget.
    const sync = await Promise.all(
      Array.from({ length: 15 }, () => servers({ Authorization: "Bearer wrong" })),
    );
    expect(count(sync, 401)).toBe(LOGIN_RATE_MAX);
    expect(count(sync, 429)).toBe(5);
    const done = await drain(t, lookups, () => ({ value: null }));
    expect(statuses(done)).toEqual(Array(LOGIN_RATE_MAX).fill(401));
    // Each kind at most the budget, together twice the budget.
    expect(failures()).toBe(2 * LOGIN_RATE_MAX);
    expect(mApiKey.findUnique).toHaveBeenCalledTimes(LOGIN_RATE_MAX);
  });

  for (const valid of [true, false]) {
    it(`budget edge: 9 failures, a wrong Bearer next to a ${valid ? "valid" : "missing"} user_session answers 429 before the lookup and clears the cookie`, async () => {
      for (let i = 0; i < LOGIN_RATE_MAX - 1; i++) recordLoginFailure(UNKNOWN_CLIENT_KEY);
      if (valid) mSession.findUnique.mockResolvedValue(LIVE_SESSION());
      const res = await servers({ Authorization: "Bearer wrong", Cookie: LIVE_USER });
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({ error: "rate_limited" });
      expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
      expect(res.headers.getSetCookie()).toEqual([CLEAR_USER]);
      expect(mSession.findUnique).not.toHaveBeenCalled();
      expect(failures()).toBe(LOGIN_RATE_MAX);
    });
  }

  it("a failed panel_session and a user_session woken blocked: one clear per cookie", async () => {
    const t = holdCalls(mApiKey.findUnique);
    const lookups = Array.from({ length: LOGIN_RATE_MAX - 1 }, () =>
      servers({ Authorization: `Bearer ${WRONG_KEY}` }),
    );
    await until(() => t.held.length === LOGIN_RATE_MAX - 1);
    // Its panel_session fails (1 failure), so 1 + 9 slots in flight: it waits.
    const mixed = servers({ Cookie: `panel_session=wrong; ${LIVE_USER}` });
    await settle();
    expect(failures()).toBe(1);
    const done = await drain(t, [...lookups, mixed], () => ({ value: null }));
    const res = done[done.length - 1];
    expect(res.status).toBe(429);
    expect(res.headers.getSetCookie()).toEqual([CLEAR, CLEAR_USER]);
    expect(mSession.findUnique).not.toHaveBeenCalled();
    expect(failures()).toBe(LOGIN_RATE_MAX);
  });
});

describe("waiter verdicts and the clock", () => {
  const KEY = "203.0.113.60";
  const T0 = 1_900_000_000_000;

  it("a blocked verdict is final: a stamp expiring after the pump lets no woken waiter through", async () => {
    let clock = T0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      for (let i = 0; i < LOGIN_RATE_MAX - 1; i++) recordLoginFailure(KEY, T0);
      const first = await acquireLookupSlot(KEY);
      if (first.status !== "acquired") throw new Error("not acquired");
      const waiting = Array.from({ length: 20 }, () => acquireLookupSlot(KEY));
      expect(_lookupSlotsInFlight(KEY)).toBe(1);
      // The tenth failure lands in the last millisecond of the oldest stamps...
      clock = T0 + LOGIN_RATE_WINDOW_MS - 1;
      first.slot.fail();
      // ...and they expire before the woken waiters run.
      clock = T0 + LOGIN_RATE_WINDOW_MS + 1;
      const got = await Promise.all(waiting);
      expect(got.map((g) => g.status)).toEqual(Array(20).fill("blocked"));
      for (const g of got) {
        // Oldest stamp T0, decided at T0 + window - 1: 1 ms left, rounded up to 1 s.
        if (g.status === "blocked") expect(g.retryAfterSec).toBe(1);
      }
      expect(_lookupSlotsInFlight(KEY)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("an arrival wakes waiters whose budget freed up by stamp expiry, before any release", async () => {
    let clock = T0 + 1;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      for (let i = 0; i < LOGIN_RATE_MAX - 1; i++) recordLoginFailure(KEY, T0);
      const held = await acquireLookupSlot(KEY);
      if (held.status !== "acquired") throw new Error("not acquired");
      const waiting = Array.from({ length: 3 }, () => acquireLookupSlot(KEY));
      expect(_lookupSlotsInFlight(KEY)).toBe(1);
      clock = T0 + LOGIN_RATE_WINDOW_MS + 1;
      const arrival = acquireLookupSlot(KEY);
      // The queued waiters got their slots ahead of the arrival, synchronously.
      expect(_lookupSlotsInFlight(KEY)).toBe(5);
      const got = await Promise.all([...waiting, arrival]);
      expect(got.map((g) => g.status)).toEqual(Array(4).fill("acquired"));
      for (const g of got) if (g.status === "acquired") g.slot.release();
      held.slot.release();
    } finally {
      spy.mockRestore();
    }
  });

  it("a granted waiter re-checks to tighten: a failure recorded before it runs blocks it, with the exact Retry-After", async () => {
    const clock = T0 + 300_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const held = [];
      for (let i = 0; i < LOGIN_RATE_MAX; i++) held.push(await acquireLookupSlot(KEY));
      const waiter = acquireLookupSlot(KEY);
      const [h0, ...rest] = held;
      if (h0.status !== "acquired") throw new Error("not acquired");
      h0.slot.release();
      expect(_lookupSlotsInFlight(KEY)).toBe(LOGIN_RATE_MAX);
      // Synchronous failures of other requests land before the waiter's turn:
      // the oldest at T0, nine at T0 + 100 s.
      recordLoginFailure(KEY, T0);
      for (let i = 0; i < LOGIN_RATE_MAX - 1; i++) recordLoginFailure(KEY, T0 + 100_000);
      const got = await waiter;
      // Oldest T0 leaves the window at T0 + 900 s; now is T0 + 300 s: 600 s.
      expect(got).toEqual({ status: "blocked", retryAfterSec: 600 });
      expect(_lookupSlotsInFlight(KEY)).toBe(LOGIN_RATE_MAX - 1);
      for (const h of rest) if (h.status === "acquired") h.slot.release();
    } finally {
      spy.mockRestore();
    }
  });

  it("an acquire on a spent budget answers blocked with Retry-After from the same clock read", async () => {
    let clock = T0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      _setLoginFailures(KEY, [T0, ...Array(LOGIN_RATE_MAX - 1).fill(T0 + 100_000)]);
      clock = T0 + 250_000;
      // Oldest T0 leaves the window at T0 + 900 s; now is T0 + 250 s: 650 s.
      expect(await acquireLookupSlot(KEY)).toEqual({ status: "blocked", retryAfterSec: 650 });
      clock = T0 + LOGIN_RATE_WINDOW_MS - 1;
      // 1 ms left before the oldest stamp leaves: rounded up to 1 s, never 0.
      expect(await acquireLookupSlot(KEY)).toEqual({ status: "blocked", retryAfterSec: 1 });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("recentFailures: exact window count and Retry-After", () => {
  const KEY = "203.0.113.70";
  const W = LOGIN_RATE_WINDOW_MS; // 900_000 ms
  const NOW = 2_000_000_000_000;

  // stamps (oldest first) and now -> exact count and Retry-After (seconds).
  // Boundary: a stamp counts while it is newer than now - W; a stamp exactly
  // at now - W does not count, as in checkLoginBlocked.
  const rows: { name: string; stamps: number[]; count: number; retryAfterSec: number }[] = [
    { name: "empty", stamps: [], count: 0, retryAfterSec: 0 },
    { name: "one stamp now", stamps: [NOW], count: 1, retryAfterSec: 900 },
    { name: "all stamps equal, 1 s old", stamps: [NOW - 1000, NOW - 1000, NOW - 1000], count: 3, retryAfterSec: 899 },
    {
      name: "mixed ages: oldest decides, not newest",
      stamps: [NOW - 400_000, NOW - 340_000, NOW - 100_000],
      count: 3,
      retryAfterSec: 500,
    },
    { name: "fractional remainder rounds up", stamps: [NOW - W + 1500], count: 1, retryAfterSec: 2 },
    { name: "exactly at now - W does not count", stamps: [NOW - W], count: 0, retryAfterSec: 0 },
    { name: "1 ms inside the window counts", stamps: [NOW - W + 1], count: 1, retryAfterSec: 1 },
    { name: "1 ms outside the window does not count", stamps: [NOW - W - 1], count: 0, retryAfterSec: 0 },
    {
      name: "boundary stamp next to newer ones: oldest counted one decides",
      stamps: [NOW - W, NOW - 600_000, NOW - 1000],
      count: 2,
      retryAfterSec: 300,
    },
    {
      name: "expired, boundary and inside stamps mixed",
      stamps: [NOW - W - 5000, NOW - W, NOW - W + 1, NOW],
      count: 2,
      retryAfterSec: 1,
    },
  ];

  for (const row of rows) {
    it(row.name, () => {
      _setLoginFailures(KEY, row.stamps);
      expect(_recentFailures(KEY, NOW)).toEqual({ count: row.count, retryAfterSec: row.retryAfterSec });
    });
  }

  it("agrees with checkLoginBlocked at the window boundary", () => {
    // Nine inside the window plus one exactly at now - W: 9 counted, not blocked.
    const inside = Array(LOGIN_RATE_MAX - 1).fill(NOW - 200_000);
    _setLoginFailures(KEY, [NOW - W, ...inside]);
    expect(_recentFailures(KEY, NOW).count).toBe(LOGIN_RATE_MAX - 1);
    expect(checkLoginBlocked(KEY, NOW)).toEqual({ blocked: false, retryAfterSec: 0 });
    // One ms later in the past, the tenth stamp counts for both: blocked, same Retry-After.
    _setLoginFailures(KEY, [NOW - W + 1, ...inside]);
    expect(_recentFailures(KEY, NOW)).toEqual({ count: LOGIN_RATE_MAX, retryAfterSec: 1 });
    expect(checkLoginBlocked(KEY, NOW)).toEqual({ blocked: true, retryAfterSec: 1 });
    // Mixed ages: both take the oldest counted stamp.
    _setLoginFailures(KEY, [NOW - 700_000, ...inside]);
    expect(_recentFailures(KEY, NOW)).toEqual({ count: LOGIN_RATE_MAX, retryAfterSec: 200 });
    expect(checkLoginBlocked(KEY, NOW)).toEqual({ blocked: true, retryAfterSec: 200 });
    _setLoginFailures(KEY, []);
  });
});

describe("exact Retry-After on every slot path (fixed clock, mixed-age stamps)", () => {
  const T0 = 2_100_000_000_000;
  const NOW = T0 + 300_000;
  // Valid until long after the fixed clock and the real one.
  const FAR_SESSION = () => ({ userId: "u1", expiresAt: new Date(8_000_000_000_000) });
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(Date, "now").mockImplementation(() => NOW);
  });
  afterEach(() => {
    spy.mockRestore();
  });

  it("pump-blocked waiter: Retry-After from the oldest stamp, not the newest", async () => {
    const KEY = "203.0.113.80";
    // Nine failures: the oldest at T0, eight at T0 + 100 s.
    _setLoginFailures(KEY, [T0, ...Array(LOGIN_RATE_MAX - 2).fill(T0 + 100_000)]);
    const first = await acquireLookupSlot(KEY);
    if (first.status !== "acquired") throw new Error("not acquired");
    const waiting = Array.from({ length: 5 }, () => acquireLookupSlot(KEY));
    first.slot.fail(); // tenth failure at NOW
    const got = await Promise.all(waiting);
    // Oldest T0 leaves at T0 + 900 s, now T0 + 300 s: 600 s (the newest would give 900).
    expect(got).toEqual(Array(5).fill({ status: "blocked", retryAfterSec: 600 }));
  });

  it("middleware 429 from a woken waiter carries the exact Retry-After", async () => {
    const f = 7;
    _setLoginFailures(UNKNOWN_CLIENT_KEY, [T0, ...Array(f - 1).fill(T0 + 200_000)]);
    const t = holdCalls(mApiKey.findUnique);
    const res = Array.from({ length: 12 }, () => servers({ Authorization: `Bearer ${WRONG_KEY}` }));
    const done = await drain(t, res, () => ({ value: null }));
    expect(count(done, 401)).toBe(LOGIN_RATE_MAX - f);
    const limited = done.filter((r) => r.status === 429);
    expect(limited).toHaveLength(12 - (LOGIN_RATE_MAX - f));
    for (const r of limited) expect(r.headers.get("Retry-After")).toBe("600");
  });

  it("middleware 429 from the acquire-time check (own Bearer spent the tenth failure) carries the exact Retry-After", async () => {
    _setLoginFailures(UNKNOWN_CLIENT_KEY, [T0, ...Array(LOGIN_RATE_MAX - 2).fill(T0 + 100_000)]);
    mSession.findUnique.mockResolvedValue(FAR_SESSION());
    const res = await servers({ Authorization: "Bearer wrong", Cookie: LIVE_USER });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("600");
    expect(mSession.findUnique).not.toHaveBeenCalled();
  });

  it("middleware 429 from a granted waiter that the tightening re-check blocks carries the exact Retry-After", async () => {
    // Eight failures: the oldest at T0, seven at T0 + 100 s. Two valid lookups take the last two slots.
    _setLoginFailures(UNKNOWN_CLIENT_KEY, [T0, ...Array(LOGIN_RATE_MAX - 3).fill(T0 + 100_000)]);
    const t = holdCalls(mSession.findUnique);
    const a = servers({ Cookie: LIVE_USER });
    const b = servers({ Cookie: LIVE_USER });
    await until(() => t.held.length === 2);
    const waiter = servers({ Cookie: LIVE_USER });
    await until(() => _lookupSlotWaiters(UNKNOWN_CLIENT_KEY) === 1);
    // a's lookup succeeds and releases its slot; the pump grants the waiter.
    t.held.shift()!.resolve(FAR_SESSION());
    for (let i = 0; i < 50 && _lookupSlotWaiters(UNKNOWN_CLIENT_KEY) > 0; i++) await null;
    expect(_lookupSlotWaiters(UNKNOWN_CLIENT_KEY)).toBe(0);
    // Two synchronous failures of other requests land before the waiter's turn.
    recordLoginFailure(UNKNOWN_CLIENT_KEY);
    recordLoginFailure(UNKNOWN_CLIENT_KEY);
    const w = await waiter;
    expect(w.status).toBe(429);
    expect(w.headers.get("Retry-After")).toBe("600");
    expect(w.headers.getSetCookie()).toEqual([CLEAR_USER]);
    // The waiter never started a lookup and gave its slot back.
    expect(mSession.findUnique).toHaveBeenCalledTimes(2);
    t.held.shift()!.resolve(FAR_SESSION());
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    expect(_lookupSlotsInFlight(UNKNOWN_CLIENT_KEY)).toBe(0);
  });
});
