// Every read site that turns `Server.relayToken` into a bearer header goes
// through openRelayToken (lib/relay-token.ts), one sealed-fixture test per
// site: relayRequest (lib/relay.ts), the /health probe (lib/ghcr.ts) and the
// self-update record read (services/relay-self-update.ts). streamDeploy
// (lib/stream-deploy.ts) and the routes in routes/servers.ts are covered by
// their own suites (stream-deploy-deploy-id, server-probe-status,
// update-relay-image-route, relay-self-update-record, relay-token-routes).
//
// Contract pinned here: a sealed value is sent OPENED, and a stored value in
// ciphertext shape that does not decrypt fails the call with the named error
// WITHOUT issuing the fetch (the stored value never goes out as a bearer).
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/guarded-fetch.js", () => ({
  guardedFetch: vi.fn((url: string, init?: RequestInit) => globalThis.fetch(url, init)),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from "../src/lib/prisma.js";
import { relayRequest } from "../src/lib/relay.js";
import { fetchRelayHealth } from "../src/lib/ghcr.js";
import { readRelaySelfUpdateOutcome } from "../src/services/relay-self-update.js";
import { openRelayToken, RelayTokenDecryptError, sealRelayToken } from "../src/lib/relay-token.js";

const PLAIN = "bearer-under-key";
const SEALED = sealRelayToken(PLAIN);
/** Ciphertext shape, never decryptable: a fake `v1:` plaintext. */
const FAKE = "v1:AAA:BBB:CCC";

function bearerOf(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.["Authorization"];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("relayRequest (lib/relay.ts)", () => {
  it("sends the OPENED token when the stored value is ciphertext", async () => {
    vi.mocked(prisma.server.findUnique).mockResolvedValue({
      id: "srv",
      relayUrl: "http://relay.example",
      relayToken: SEALED,
    } as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await relayRequest({ serverId: "srv", path: "/api/x" });

    expect(bearerOf(fetchSpy.mock.calls[0][1] as RequestInit)).toBe(`Bearer ${PLAIN}`);
    fetchSpy.mockRestore();
  });

  it("a stored value that does not open fails the call and never issues the fetch", async () => {
    vi.mocked(prisma.server.findUnique).mockResolvedValue({
      id: "srv",
      relayUrl: "http://relay.example",
      relayToken: FAKE,
    } as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(relayRequest({ serverId: "srv", path: "/api/x" })).rejects.toBeInstanceOf(
      RelayTokenDecryptError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("fetchRelayHealth (lib/ghcr.ts)", () => {
  const server = {
    id: "srv",
    userId: "user-a",
    relayUrl: "http://relay.example",
    relayToken: SEALED,
  };

  it("probes /health with the OPENED token", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ status: "ok", revision: "abc1234" }));

    const probe = await fetchRelayHealth(server);

    expect(probe.online).toBe(true);
    expect(bearerOf(fetchSpy.mock.calls[0][1])).toBe(`Bearer ${PLAIN}`);
    fetchSpy.mockRestore();
  });

  it("a stored value that does not open reports a failed probe and never issues the fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));

    const probe = await fetchRelayHealth({ ...server, relayToken: FAKE });

    expect(probe.online).toBe(false);
    expect(probe.failureStatus).toBe("unknown");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("readRelaySelfUpdateOutcome (services/relay-self-update.ts)", () => {
  const baseOpts = {
    previousRevision: null,
    targetRevision: null,
    mode: "window" as const,
    notBefore: Date.now(),
  };

  it("reads the record with the OPENED token", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ state: null }), { status: 200 }));

    await readRelaySelfUpdateOutcome({
      ...baseOpts,
      server: { id: "srv", userId: "user-a", relayUrl: "http://relay.example", relayToken: SEALED },
    });

    expect(bearerOf(fetchSpy.mock.calls[0][1])).toBe(`Bearer ${PLAIN}`);
    fetchSpy.mockRestore();
  });

  it("a stored value that does not open maps to none and never issues the fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));

    const outcome = await readRelaySelfUpdateOutcome({
      ...baseOpts,
      server: { id: "srv", userId: "user-a", relayUrl: "http://relay.example", relayToken: FAKE },
    });

    expect(outcome).toEqual({ kind: "none" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

// Sanity for the fixtures themselves: the sealed value opens (so the "opened"
// assertions above are not passing on an accident), and null stays null.
describe("fixtures", () => {
  it("the sealed fixture opens and the fake does not", () => {
    expect(openRelayToken(SEALED)).toBe(PLAIN);
    expect(() => openRelayToken(FAKE)).toThrow(RelayTokenDecryptError);
  });
});
