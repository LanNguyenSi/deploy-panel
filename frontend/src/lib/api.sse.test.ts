import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";

// Scope of this file: the SSE async generators (installRelayStream,
// reinstallRelayStream, updateRelayImageStream — all thin wrappers over the
// shared sseStream() helper) and probeVps(). These are split out of
// api.test.ts because they need a streaming fetch-response mock instead of
// a plain jsonResponse().
//
// A fake `Response`-shaped object is enough: sseStream() only ever calls
// `res.ok`, `res.body.getReader()` and `res.json()`, so a minimal object
// with those members exercises the real parsing/branch logic without
// depending on the platform's actual ReadableStream implementation.
const BASE = "http://localhost:3001";

function fakeStreamBody(chunks: string[]) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (i < chunks.length) {
          const value = encoder.encode(chunks[i]);
          i += 1;
          return { value, done: false };
        }
        return { value: undefined, done: true };
      },
    }),
  };
}

function fakeSseResponse(chunks: string[]) {
  return {
    ok: true,
    body: fakeStreamBody(chunks),
    json: async () => ({}),
  } as unknown as Response;
}

function fakeErrorResponse(status: number, body: unknown) {
  return {
    ok: false,
    status,
    json: async () => body,
  } as unknown as Response;
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const evt of gen) out.push(evt);
  return out;
}

describe("sseStream-based generators", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("installRelayStream POSTs the exact URL/headers/body and yields parsed progress + done frames", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeSseResponse([
        'event: progress\ndata: {"stream":"stdout","line":"cloning repo"}\n\n',
        'event: done\ndata: {"serverId":"srv-1","name":"prod","host":"1.2.3.4","relayUrl":"https://relay"}\n\n',
      ]),
    );

    const req: api.InstallRelayRequest = { name: "prod", host: "1.2.3.4" };
    const events = await collect(api.installRelayStream(req));

    // Wrong URL/method/body here would silently target a different server
    // or drop install params — assert the exact fetch call.
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/servers/install-relay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      credentials: "include",
      body: JSON.stringify(req),
      signal: undefined,
    });

    expect(events).toEqual([
      { event: "progress", data: { stream: "stdout", line: "cloning repo" } },
      {
        event: "done",
        data: { serverId: "srv-1", name: "prod", host: "1.2.3.4", relayUrl: "https://relay" },
      },
    ]);
  });

  it("installRelayStream splits a frame across multiple reader chunks and still parses it", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeSseResponse(['event: progress\ndata: {"stream"', ':"stdout","line":"partial"}\n\n']),
    );

    const events = await collect(api.installRelayStream({ name: "prod", host: "1.2.3.4" }));

    expect(events).toEqual([{ event: "progress", data: { stream: "stdout", line: "partial" } }]);
  });

  it("yields a synthetic error frame when the initial POST is not ok", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeErrorResponse(500, { error: "install_failed", message: "ssh unreachable" }),
    );

    const events = await collect(api.installRelayStream({ name: "prod", host: "1.2.3.4" }));

    expect(events).toEqual([
      { event: "error", data: { kind: "install_failed", message: "ssh unreachable" } },
    ]);
  });

  it("yields the catch-shaped 'HTTP <status>' message when the not-ok body has no parseable json", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);

    const events = await collect(api.installRelayStream({ name: "prod", host: "1.2.3.4" }));

    // The .catch(() => ({ message: `HTTP ${res.status}` })) fallback fires first,
    // so the yield-time `?? request failed with status ...` default never applies here.
    expect(events).toEqual([{ event: "error", data: { kind: "http_error", message: "HTTP 502" } }]);
  });

  it("falls back to 'request failed with status <status>' when the not-ok body parses but has no message", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as unknown as Response);

    const events = await collect(api.installRelayStream({ name: "prod", host: "1.2.3.4" }));

    expect(events).toEqual([
      { event: "error", data: { kind: "http_error", message: "request failed with status 503" } },
    ]);
  });

  it("yields a no_body error frame when res.body is missing", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, body: null, json: async () => ({}) } as unknown as Response);

    const events = await collect(api.installRelayStream({ name: "prod", host: "1.2.3.4" }));

    expect(events).toEqual([
      { event: "error", data: { kind: "no_body", message: "server returned empty stream" } },
    ]);
  });

  it("yields a parse_error frame for a malformed data line and continues", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeSseResponse([
        "event: progress\ndata: {not json}\n\n",
        'event: done\ndata: {"serverId":"srv-1","name":"prod","host":"1.2.3.4","relayUrl":"https://relay"}\n\n',
      ]),
    );

    const events = await collect(api.installRelayStream({ name: "prod", host: "1.2.3.4" }));

    expect(events[0]).toEqual({
      event: "error",
      data: { kind: "parse_error", message: "malformed data frame: {not json}" },
    });
    expect(events[1]).toEqual({
      event: "done",
      data: { serverId: "srv-1", name: "prod", host: "1.2.3.4", relayUrl: "https://relay" },
    });
  });

  it("reinstallRelayStream POSTs /api/servers/:serverId/install-relay with the exact body", async () => {
    fetchMock.mockResolvedValueOnce(fakeSseResponse([]));

    const req: api.ReinstallRelayRequest = { rotateToken: true };
    await collect(api.reinstallRelayStream("srv-1", req));

    // A wrong serverId here would re-install onto the WRONG server.
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/servers/srv-1/install-relay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      credentials: "include",
      body: JSON.stringify(req),
      signal: undefined,
    });
  });

  it("updateRelayImageStream POSTs /api/servers/:serverId/update-relay-image with the exact body", async () => {
    fetchMock.mockResolvedValueOnce(fakeSseResponse([]));

    const req: api.UpdateRelayImageRequest = { relayDir: "/opt/agent-relay" };
    await collect(api.updateRelayImageStream("srv-1", req));

    // A wrong serverId here would update the image on the WRONG server.
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/servers/srv-1/update-relay-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      credentials: "include",
      body: JSON.stringify(req),
      signal: undefined,
    });
  });

  it("forwards an AbortSignal through to fetch", async () => {
    fetchMock.mockResolvedValueOnce(fakeSseResponse([]));
    const controller = new AbortController();

    await collect(api.installRelayStream({ name: "prod", host: "1.2.3.4" }, controller.signal));

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/api/servers/install-relay`,
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("probeVps", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs /api/servers/probe-vps with the exact body and returns the parsed probe result", async () => {
    const probeResponse = {
      probe: {
        port80: { kind: "free" },
        port443: { kind: "free" },
        containers: [],
        networks: [],
        suggestedMode: "greenfield",
      },
      hostKeySha256: "abc123",
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(probeResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const req: api.ProbeVpsRequest = { host: "1.2.3.4" };
    await expect(api.probeVps(req)).resolves.toEqual(probeResponse);

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/servers/probe-vps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(req),
    });
  });

  it("throws an Error with .kind from the response body on failure", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "ssh_auth_failed", message: "bad credentials" }), {
        status: 401,
      }),
    );

    const err = (await api.probeVps({ host: "1.2.3.4" }).catch((e) => e)) as Error & { kind?: string };
    expect(err.message).toBe("bad credentials");
    expect(err.kind).toBe("ssh_auth_failed");
  });

  it("falls back to the catch-shaped 'HTTP <status>' message when the failure body has no parseable json", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 503 }));

    // The .catch(() => ({ message: `HTTP ${res.status}` })) fallback fires first,
    // so the throw-time `?? probe failed (HTTP ...)` default never applies here.
    const err = (await api.probeVps({ host: "1.2.3.4" }).catch((e) => e)) as Error & { kind?: string };
    expect(err.message).toBe("HTTP 503");
    expect(err.kind).toBe("probe_failed");
  });

  it("falls back to 'probe failed (HTTP <status>)' when the failure body parses but has no message", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 504 }));

    const err = (await api.probeVps({ host: "1.2.3.4" }).catch((e) => e)) as Error & { kind?: string };
    expect(err.message).toBe("probe failed (HTTP 504)");
    expect(err.kind).toBe("probe_failed");
  });
});
