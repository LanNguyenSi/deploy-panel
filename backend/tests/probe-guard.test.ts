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

describe("isPrivateOrLoopbackHost: every blocked range and spelling", () => {
  // One literal per blocked range, first and last address where it matters.
  it.each([
    ["0/8", "0.1.2.3"],
    ["10/8", "10.200.1.1"],
    ["100.64/10 low", "100.64.0.0"],
    ["100.64/10 high", "100.127.255.255"],
    ["127/8", "127.255.255.254"],
    ["169.254/16", "169.254.0.1"],
    ["172.16/12 low", "172.16.0.0"],
    ["172.16/12 high", "172.31.255.255"],
    ["192.168/16", "192.168.255.255"],
    ["198.18/15 low", "198.18.0.1"],
    ["198.18/15 high", "198.19.255.255"],
    ["224/4 low", "224.0.0.1"],
    ["224/4 high", "239.255.255.255"],
    ["240/4", "240.0.0.1"],
    ["240/4 broadcast", "255.255.255.255"],
    ["octet above 255", "300.1.1.1"],
  ])("denies IPv4 %s (%s)", (_range, host) => {
    expect(isPrivateOrLoopbackHost(host)).toBe(true);
  });

  it.each([
    ["::1/128 full form", "0:0:0:0:0:0:0:1"],
    ["::1/128 short zero run", "0::1"],
    ["::1/128 split zero run", "::0:1"],
    ["::1/128 leading zeros", "0000:0000:0000:0000:0000:0000:0000:0001"],
    ["::1/128 bracketed full form", "[0:0:0:0:0:0:0:1]"],
    ["::/128 full form", "0:0:0:0:0:0:0:0"],
    ["::/128", "::"],
    ["mapped full form hex", "0:0:0:0:0:ffff:7f00:1"],
    ["mapped full form dotted", "0:0:0:0:0:ffff:127.0.0.1"],
    ["mapped uppercase", "::FFFF:7F00:1"],
    ["mapped private 10/8", "::ffff:10.1.2.3"],
    ["mapped metadata", "::ffff:a9fe:a9fe"],
    ["IPv4-compatible dotted", "::127.0.0.1"],
    ["IPv4-compatible hex", "::7f00:1"],
    ["IPv4-compatible 192.168", "::192.168.1.1"],
    ["NAT64 loopback", "64:ff9b::127.0.0.1"],
    ["NAT64 metadata hex", "64:ff9b::a9fe:a9fe"],
    ["NAT64 full form", "0064:ff9b:0:0:0:0:a00:1"],
    ["fe80::/10 low", "fe80::1"],
    ["fe80::/10 high", "febf::1"],
    ["fe80::/10 with zone", "fe80::1%eth0"],
    ["mapped dotted with zone", "::ffff:127.0.0.1%eth0"],
    ["fec0::/10 low", "fec0::1"],
    ["fec0::/10 high", "feff::1"],
    ["fc00::/7 fc", "fc00::1"],
    ["fc00::/7 fd", "fdff:ffff::1"],
  ])("denies IPv6 %s (%s)", (_range, host) => {
    expect(isPrivateOrLoopbackHost(host)).toBe(true);
  });

  it.each([
    "198.17.255.255",
    "198.20.0.0",
    "223.255.255.255",
    "11.0.0.1",
    "126.255.255.255",
    "128.0.0.1",
    "2001:4860:4860::8888",
    "2606:4700::1111",
    "0:0:0:0:0:ffff:808:808",
    "::ffff:8.8.8.8",
    "::8.8.8.8",
    "64:ff9b::808:808",
    "64:ff9b:1::1",
    "fe7f::1",
    "ff02::1",
    "fbff::1",
    "fe00::1",
    "0:0:0:1::1",
  ])("allows %s", (host) => {
    // ff02::1 (multicast) and the like are not in the denied set today and
    // are not added here; the DNS pass is the backstop for names.
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
