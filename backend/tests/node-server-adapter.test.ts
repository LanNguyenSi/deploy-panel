/**
 * Adapter-level coverage for the @hono/node-server transport.
 *
 * Every other backend suite calls app.fetch() / app.request(), which invokes
 * the Hono handler directly and bypasses the @hono/node-server adapter that
 * production uses (backend/src/server.ts cannot be imported by tests because
 * it calls serve() plus a scheduler at module top level). A broken adapter,
 * for example one that buffers a streamed response, would pass every app.fetch()
 * suite. These tests serve the real createApp() through serve() on an
 * ephemeral loopback port and talk to it with fetch over a real socket:
 * one JSON round trip, one SSE stream proven to arrive incrementally.
 *
 * Tracker task 46a3a7b9.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    // Not exercised with the panel token; present so requireAuth never
    // touches a missing mock.
    apiKey: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
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
  },
  allowedGitHubLogins: [],
}));

vi.mock("../src/services/ssh-executor.js", () => {
  class SshError extends Error {
    constructor(message: string, readonly kind?: string) {
      super(message);
      this.name = "SshError";
    }
  }
  class SshTimeoutError extends Error {
    constructor(timeoutMs: number) {
      super(`SSH operation timed out after ${timeoutMs}ms`);
      this.name = "SshTimeoutError";
    }
  }
  return { executeSshCommand: vi.fn(), SshError, SshTimeoutError };
});

import { createApp } from "../src/app.js";
import { executeSshCommand } from "../src/services/ssh-executor.js";
import { activeInstalls } from "../src/services/active-installs.js";
import { startNodeServer, type RunningServer } from "./helpers/node-server.js";

const validBody = {
  name: "vps-1",
  host: "1.2.3.4",
  relayDomain: "relay.example.com",
  traefikEmail: "ops@example.com",
  sshUser: "root",
  sshPort: 22,
  sshPassword: "hunter2",
};

let running: RunningServer | undefined;
const cleanups: Array<() => void> = [];

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()?.();
  await running?.close();
  running = undefined;
  activeInstalls.clear();
  vi.mocked(executeSshCommand).mockReset();
});

describe("node-server adapter: JSON round trip", () => {
  it("serves GET /api/health over a real socket with security headers", async () => {
    running = await startNodeServer(createApp("http://localhost:3000"));

    const res = await fetch(`${running.url}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: "0.1.0" });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("node-server adapter: SSE streaming", () => {
  it("delivers progress events to the client before the stream ends", async () => {
    // Deterministic handshake instead of timing thresholds: the mocked SSH
    // executor only emits its next line after the client has proven it
    // already received the previous one. A response buffered by the adapter
    // would leave the client waiting on a needle that only lands at the
    // very end, so the first readUntil would time out.
    let ackFirst!: () => void;
    let ackSecond!: () => void;
    const firstRead = new Promise<void>((r) => (ackFirst = r));
    const secondRead = new Promise<void>((r) => (ackSecond = r));
    cleanups.push(ackFirst, ackSecond); // release the server side on any failure path

    vi.mocked(executeSshCommand).mockImplementation(async (opts) => {
      opts.onStdout?.("first-line");
      await firstRead; // a buffered response never lets the client see first-line, so this never resolves
      opts.onStdout?.("second-line");
      await secondRead;
      return { exitCode: 0, finished: true };
    });

    running = await startNodeServer(createApp("http://localhost:3000"));

    const res = await fetch(`${running.url}/api/servers/install-relay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer panel-token-must-be-16chars",
      },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const state = { text: "" };

    function readUntil(
      rdr: ReadableStreamDefaultReader<Uint8Array>,
      st: { text: string },
      needle: string,
      label: string,
    ): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), 5000);
      });
      const loop = async () => {
        while (!st.text.includes(needle)) {
          const pending = rdr.read();
          // Swallow late rejections from this read if the race settles on
          // the timeout first and afterEach closes the socket underneath.
          pending.catch(() => {});
          const raced = await Promise.race([pending, timeout]);
          if (raced === "timeout" || raced.done) {
            throw new Error(`${label}: not streamed incrementally`);
          }
          st.text += decoder.decode(raced.value, { stream: true });
        }
      };
      return loop().finally(() => {
        if (timer) clearTimeout(timer);
      });
    }

    async function readToEnd(): Promise<void> {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        state.text += decoder.decode(r.value, { stream: true });
      }
    }

    await readUntil(reader, state, '"line":"first-line"', "first event");
    ackFirst();

    await readUntil(reader, state, '"line":"second-line"', "second event");
    ackSecond();

    await readToEnd();

    expect(state.text).toContain("event: progress");
    expect(state.text).toContain("event: error");
    expect(vi.mocked(executeSshCommand)).toHaveBeenCalledTimes(1);
  });
});
