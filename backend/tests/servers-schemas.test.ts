import { describe, expect, it } from "vitest";

/**
 * Accept-set and output pins for the servers-route schemas across the
 * zod 3 -> 4 migration. Every expected value here is the zod 3 behaviour
 * (captured on the base with zod 3.25.76) that zod 4 must reproduce.
 *
 * The composite schemas chain `.merge(installEnvSchema)` with
 * `.and(sshAuthSchema)` (a refined object): in zod 4 merge/extend on a
 * schema carrying refinements is rejected, so these pins prove the left
 * sides (plain objects) merge unchanged and that the intersection still
 * applies the sshUser/sshPort defaults and the password-XOR-privateKey
 * refine.
 */

import {
  createServerSchema,
  installRelaySchema,
  probeVpsSchema,
  reinstallRelaySchema,
  updateRelayImageSchema,
} from "../src/routes/servers.js";

const B64_SHA = "nqUuS1a1G1zQ8Yd1F0m2P7s4Xc9Vb3Hk6JwLpRtEOIa=";

describe("installRelaySchema (merge + and accept set)", () => {
  it("accepts valid password auth and applies the sshUser/sshPort defaults", () => {
    const r = installRelaySchema.safeParse({ name: "vps", host: "1.2.3.4", sshPassword: "pw" });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      name: "vps",
      host: "1.2.3.4",
      sshPassword: "pw",
      sshUser: "root",
      sshPort: 22,
    });
  });

  it("accepts valid key auth", () => {
    const r = installRelaySchema.safeParse({ name: "vps", host: "h", sshPrivateKey: "KEY" });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      name: "vps",
      host: "h",
      sshPrivateKey: "KEY",
      sshUser: "root",
      sshPort: 22,
    });
  });

  it("rejects a body with BOTH sshPassword and sshPrivateKey (refine)", () => {
    const r = installRelaySchema.safeParse({
      name: "vps",
      host: "h",
      sshPassword: "pw",
      sshPrivateKey: "KEY",
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    const issue = r.error.issues.find(
      (i) => i.message === "exactly one of sshPassword or sshPrivateKey must be provided",
    );
    expect(issue).toBeDefined();
    expect(issue?.code).toBe("custom");
  });

  it("rejects a body with NEITHER sshPassword nor sshPrivateKey (refine)", () => {
    const r = installRelaySchema.safeParse({ name: "vps", host: "h" });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(
      r.error.issues.some(
        (i) => i.message === "exactly one of sshPassword or sshPrivateKey must be provided",
      ),
    ).toBe(true);
  });

  it("keeps the sshPort defaults strict: string port and out-of-range port rejected", () => {
    expect(
      installRelaySchema.safeParse({ name: "v", host: "h", sshPassword: "p", sshPort: "22" })
        .success,
    ).toBe(false);
    expect(
      installRelaySchema.safeParse({ name: "v", host: "h", sshPassword: "p", sshPort: 65536 })
        .success,
    ).toBe(false);
    expect(
      installRelaySchema.safeParse({ name: "v", host: "h", sshPassword: "p", sshPort: 22.5 })
        .success,
    ).toBe(false);
  });

  it("keeps the custom regex messages identical (relayDomain, appsDir, host key)", () => {
    const bad = installRelaySchema.safeParse({
      name: "v",
      host: "h",
      sshPassword: "p",
      relayDomain: "bad host!",
    });
    expect(bad.success).toBe(false);
    if (bad.success) return;
    expect(bad.error.issues.map((i) => i.message)).toContain(
      "relayDomain must be a valid hostname",
    );
  });

  it("rejects appsDir with a `..` segment with the stable refine message", () => {
    const r = installRelaySchema.safeParse({
      name: "v",
      host: "h",
      sshPassword: "p",
      appsDir: "/srv/../etc",
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.message)).toContain("appsDir must not contain `..`");
  });

  it("accepts an appsDir whose component merely starts with `..`", () => {
    const r = installRelaySchema.safeParse({
      name: "v",
      host: "h",
      sshPassword: "p",
      appsDir: "/srv/..hidden",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a full valid env block (merged installEnvSchema fields)", () => {
    const r = installRelaySchema.safeParse({
      name: "v",
      host: "h",
      sshPassword: "p",
      relayDomain: "relay.example.com",
      traefikEmail: "ops@example.com",
      appsDir: "/srv/apps",
      relayMode: "auto",
      relayDir: "/opt/agent-relay",
      relayComposeFile: "docker-compose.yml",
      expectedHostKeySha256: B64_SHA,
    });
    expect(r.success).toBe(true);
    expect(r.data?.relayComposeFile).toBe("docker-compose.yml");
    expect(r.data?.expectedHostKeySha256).toBe(B64_SHA);
  });

  it("rejects a prefixed expectedHostKeySha256 with the stable regex message", () => {
    const r = installRelaySchema.safeParse({
      name: "v",
      host: "h",
      sshPassword: "p",
      expectedHostKeySha256: `SHA256:${B64_SHA.slice(0, 37)}`,
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.message)).toContain(
      "expectedHostKeySha256 must be raw base64 sha256 (no SHA256: prefix)",
    );
  });
});

describe("installEnvSchema email format (traefikEmail)", () => {
  const parse = (e: string) =>
    installRelaySchema.safeParse({ name: "v", host: "h", sshPassword: "p", traefikEmail: e });

  it("accepts a plain address", () => {
    expect(parse("ops@example.com").success).toBe(true);
  });

  it("accepts plus-tags and subdomains", () => {
    expect(parse("a.b+c@sub.domain.io").success).toBe(true);
  });

  it("accepts a short public-suffix address (v3 parity: a@b.co)", () => {
    expect(parse("a@b.co").success).toBe(true);
  });

  it("rejects a non-address with the zod format message", () => {
    const r = parse("not-an-email");
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.message)).toContain("Invalid email address");
  });

  it("rejects a missing TLD (v3 parity)", () => {
    expect(parse("a@b").success).toBe(false);
  });

  it("rejects a double @ (v3 parity)", () => {
    expect(parse("a@@b.co").success).toBe(false);
  });

  it("rejects a non-ASCII local part (v3 parity)", () => {
    expect(parse("上@a.com").success).toBe(false);
  });

  it("rejects consecutive dots in the domain (v3 parity)", () => {
    expect(parse("a@b..com").success).toBe(false);
  });
});

describe("probeVpsSchema (and-only chain)", () => {
  it("applies defaults and accepts password auth", () => {
    const r = probeVpsSchema.safeParse({ host: "1.2.3.4", sshPassword: "p" });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ host: "1.2.3.4", sshPassword: "p", sshUser: "root", sshPort: 22 });
  });

  it("rejects both auth methods", () => {
    expect(
      probeVpsSchema.safeParse({ host: "h", sshPassword: "p", sshPrivateKey: "K" }).success,
    ).toBe(false);
  });

  it("rejects no auth method", () => {
    expect(probeVpsSchema.safeParse({ host: "h" }).success).toBe(false);
  });
});

describe("reinstallRelaySchema (merge + and)", () => {
  it("accepts rotateToken + env fields + key auth, outputs them unchanged", () => {
    const r = reinstallRelaySchema.safeParse({
      rotateToken: true,
      relayDir: "/opt/relay",
      sshPrivateKey: "K",
    });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      rotateToken: true,
      relayDir: "/opt/relay",
      sshPrivateKey: "K",
      sshUser: "root",
      sshPort: 22,
    });
  });

  it("rejects relayDir with a `..` segment with the stable refine message", () => {
    const r = reinstallRelaySchema.safeParse({ sshPrivateKey: "K", relayDir: "/opt/../etc" });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.message)).toContain("relayDir must not contain `..`");
  });
});

describe("updateRelayImageSchema (and-only chain)", () => {
  it("accepts dir + compose file overrides", () => {
    const r = updateRelayImageSchema.safeParse({
      sshPassword: "p",
      relayDir: "/opt/relay",
      relayComposeFile: "c.yaml",
    });
    expect(r.success).toBe(true);
  });

  it("rejects `..` segments but accepts `..x` components", () => {
    expect(updateRelayImageSchema.safeParse({ sshPassword: "p", relayDir: "/opt/../etc" }).success).toBe(
      false,
    );
    expect(updateRelayImageSchema.safeParse({ sshPassword: "p", relayDir: "/opt/..x" }).success).toBe(
      true,
    );
  });

  it("rejects a body without either auth method", () => {
    expect(updateRelayImageSchema.safeParse({}).success).toBe(false);
  });
});

describe("createServerSchema relayUrl url format", () => {
  const parse = (relayUrl: string) => createServerSchema.safeParse({ name: "s", host: "h", relayUrl });

  it("accepts an http URL and keeps the value unnormalized in the output", () => {
    const r = parse("http://relay.example.com");
    expect(r.success).toBe(true);
    expect(r.data?.relayUrl).toBe("http://relay.example.com");
  });

  it("does not normalize case, port or query fragments (v3 parity)", () => {
    const r = parse("HTTP://RELAY.Example.COM:8443/Path?q=1#f");
    expect(r.success).toBe(true);
    expect(r.data?.relayUrl).toBe("HTTP://RELAY.Example.COM:8443/Path?q=1#f");
  });

  it("rejects a bare word with the zod 4 format code", () => {
    const r = parse("not-a-url");
    expect(r.success).toBe(false);
    if (r.success) return;
    const issue = r.error.issues[0];
    expect(issue.code).toBe("invalid_format");
    expect(issue.message).toBe("Invalid URL");
  });

  it("rejects a protocol-less host (v3 parity)", () => {
    expect(parse("relay.example.com").success).toBe(false);
  });

  it("rejects an embedded space (v3 parity)", () => {
    expect(parse("http://exa mple.com").success).toBe(false);
  });

  it("accepts non-http schemes and userinfo URLs (v3 parity: both accepted, unchanged)", () => {
    expect(parse("mailto:a@b.co").data?.relayUrl).toBe("mailto:a@b.co");
    expect(parse("http://user:pw@host").data?.relayUrl).toBe("http://user:pw@host");
  });

  it("accepts bracketed IPv6 hosts", () => {
    expect(parse("http://[::1]:8080").success).toBe(true);
  });
});
