import { describe, expect, it, beforeEach, vi } from "vitest";

// Mock dns.lookup so we can drive `assertHostAllowedForNonAdmin`
// deterministically.
const lookupMock = vi.fn();
vi.mock("node:dns", () => ({
  promises: {
    lookup: (...args: unknown[]) => lookupMock(...args),
  },
}));

import {
  consumeProbeQuota,
  isPrivateOrLoopbackHost,
  assertHostAllowedForNonAdmin,
  _resetProbeQuota,
  _probeHistorySize,
} from "../src/services/probe-guard.js";

describe("isPrivateOrLoopbackHost", () => {
  it.each([
    "localhost",
    "127.0.0.1",
    "127.0.0.5",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "192.168.50.50",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "[::1]",
    "",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:192.168.1.1",
    "::ffff:7f00:1",
    "::ffff:0a00:0001",
  ])("rejects %s", (host) => {
    expect(isPrivateOrLoopbackHost(host)).toBe(true);
  });

  it.each([
    "1.2.3.4",
    "8.8.8.8",
    "85.215.150.76",
    "172.15.0.1",
    "172.32.0.1",
    "192.169.0.1",
    "100.63.0.1",
    "100.128.0.1",
    "vps.example.com",
    "deploy.opentriologue.ai",
    "2001:db8::1",
    "::ffff:8.8.8.8",
  ])("allows %s", (host) => {
    expect(isPrivateOrLoopbackHost(host)).toBe(false);
  });
});

describe("assertHostAllowedForNonAdmin", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it("rejects literal private IPs without resolving", async () => {
    const result = await assertHostAllowedForNonAdmin("10.0.0.1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("literal");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects IPv4 shorthand once resolved (e.g. 127.1 → 127.0.0.1)", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const result = await assertHostAllowedForNonAdmin("127.1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("resolved_private");
  });

  it("rejects hostnames whose DNS points to private space", async () => {
    lookupMock.mockResolvedValue([{ address: "192.168.1.50", family: 4 }]);
    const result = await assertHostAllowedForNonAdmin("evil.example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("resolved_private");
  });

  it("rejects when ANY resolved address is private (mixed v4+v6)", async () => {
    lookupMock.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "::1", family: 6 },
    ]);
    const result = await assertHostAllowedForNonAdmin("split.example.com");
    expect(result.ok).toBe(false);
  });

  it("allows public hostnames that resolve to public IPs", async () => {
    lookupMock.mockResolvedValue([{ address: "85.215.150.76", family: 4 }]);
    const result = await assertHostAllowedForNonAdmin("vps.example.com");
    expect(result.ok).toBe(true);
  });

  it("treats DNS resolution failures as allow (SSH layer is the backstop)", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    const result = await assertHostAllowedForNonAdmin("nx.example.com");
    expect(result.ok).toBe(true);
  });
});

describe("consumeProbeQuota", () => {
  beforeEach(() => {
    _resetProbeQuota();
  });

  it("allows the first 5 calls and blocks the 6th", () => {
    const t = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(consumeProbeQuota("user-a", t + i * 1000)).toBe(true);
    }
    expect(consumeProbeQuota("user-a", t + 5000)).toBe(false);
  });

  it("isolates quota per actor", () => {
    const t = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(consumeProbeQuota("user-a", t)).toBe(true);
    }
    expect(consumeProbeQuota("user-a", t)).toBe(false);
    expect(consumeProbeQuota("user-b", t)).toBe(true);
  });

  it("releases slots after the 60s window slides past", () => {
    const t = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(consumeProbeQuota("user-a", t)).toBe(true);
    }
    expect(consumeProbeQuota("user-a", t + 30_000)).toBe(false);
    // 61s later, the original 5 timestamps have all fallen outside the window
    expect(consumeProbeQuota("user-a", t + 61_000)).toBe(true);
  });

  it("prunes stale actor entries to keep memory bounded", () => {
    // Seed history for 100 ephemeral actors, all with timestamps from
    // long ago. The 100th call triggers pruneProbeHistory(now), which
    // should drop every entry whose newest stamp fell outside the window.
    const t = 1_000_000;
    for (let i = 0; i < 99; i++) {
      consumeProbeQuota(`ephemeral-${i}`, t);
    }
    expect(_probeHistorySize()).toBe(99);
    // 100th call lands far in the future — every prior entry is stale.
    consumeProbeQuota("fresh", t + 120_000);
    expect(_probeHistorySize()).toBe(1);
  });
});
