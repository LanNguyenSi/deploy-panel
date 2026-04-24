import { afterEach, describe, expect, it, vi } from "vitest";
import { Server, type AuthContext, type Connection, type ServerConfig } from "ssh2";
import { generateKeyPairSync } from "node:crypto";
import { executeSshCommand, SshError, SshTimeoutError } from "../src/services/ssh-executor.js";

/**
 * Stand up an in-process ssh2 Server that serves one connection and
 * exposes hooks to control authentication + command behaviour. Mirrors
 * the ssh2 docs example but trimmed to what the executor's unit tests
 * actually exercise.
 */
interface MockSshServerOpts {
  acceptAuth: (ctx: AuthContext) => boolean;
  /**
   * Driver for the `exec` channel. Receives the command the client
   * sent and a stream-like bag for emitting stdout/stderr + exit.
   * Resolve by calling `exit(code)`. If you never call it, the test
   * exercises the timeout path.
   */
  onExec: (args: {
    command: string;
    emitStdout: (s: string) => void;
    emitStderr: (s: string) => void;
    exit: (code: number) => void;
  }) => void;
}

interface StartedMockServer {
  port: number;
  close: () => Promise<void>;
}

async function startMockSshServer(opts: MockSshServerOpts): Promise<StartedMockServer> {
  // Generate a throw-away RSA host key per test. 2048 bits is enough
  // for a localhost handshake and keeps keygen fast.
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  const serverConfig: ServerConfig = { hostKeys: [privateKey] };

  const server = new Server(serverConfig, (client: Connection) => {
    client.on("authentication", (ctx) => {
      if (opts.acceptAuth(ctx)) ctx.accept();
      else ctx.reject();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          opts.onExec({
            command: info.command,
            emitStdout: (s) => stream.write(s),
            emitStderr: (s) => stream.stderr.write(s),
            exit: (code) => {
              stream.exit(code);
              stream.end();
            },
          });
        });
      });
    });
    client.on("error", () => {
      // Ignored — happens when the client kills the connection during
      // timeout tests. The test asserts on the client-side rejection.
    });
  });

  return new Promise<StartedMockServer>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("executeSshCommand — ssh2 mock server integration", () => {
  let mock: StartedMockServer;

  afterEach(async () => {
    await mock?.close();
    vi.restoreAllMocks();
  });

  it("runs a command to completion, streams stdout, returns exit 0", async () => {
    mock = await startMockSshServer({
      acceptAuth: (ctx) => ctx.method === "password" && ctx.password === "correct",
      onExec: ({ emitStdout, exit }) => {
        emitStdout("hello\nworld\n");
        exit(0);
      },
    });
    const stdoutLines: string[] = [];
    const result = await executeSshCommand({
      host: "127.0.0.1",
      port: mock.port,
      user: "tester",
      auth: { kind: "password", password: "correct" },
      command: "echo hello; echo world",
      onStdout: (line) => stdoutLines.push(line),
      acceptAnyHostKey: true,
    });
    expect(result).toEqual({ exitCode: 0, finished: true });
    expect(stdoutLines).toEqual(["hello", "world"]);
  });

  it("streams stderr separately from stdout", async () => {
    mock = await startMockSshServer({
      acceptAuth: () => true,
      onExec: ({ emitStdout, emitStderr, exit }) => {
        emitStdout("out-line\n");
        emitStderr("err-line\n");
        exit(0);
      },
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    await executeSshCommand({
      host: "127.0.0.1",
      port: mock.port,
      user: "tester",
      auth: { kind: "password", password: "anything" },
      command: "script",
      onStdout: (l) => stdout.push(l),
      onStderr: (l) => stderr.push(l),
      acceptAnyHostKey: true,
    });
    expect(stdout).toEqual(["out-line"]);
    expect(stderr).toEqual(["err-line"]);
  });

  it("surfaces a non-zero exit code without throwing", async () => {
    mock = await startMockSshServer({
      acceptAuth: () => true,
      onExec: ({ emitStderr, exit }) => {
        emitStderr("install failed\n");
        exit(7);
      },
    });
    const result = await executeSshCommand({
      host: "127.0.0.1",
      port: mock.port,
      user: "tester",
      auth: { kind: "password", password: "anything" },
      command: "false",
      acceptAnyHostKey: true,
    });
    // A non-zero exit is a valid outcome: the command ran, it just
    // failed. The caller decides whether to treat that as a user-visible
    // error (install failed) or a soft state (e.g. preflight said no).
    expect(result).toEqual({ exitCode: 7, finished: true });
  });

  it("rejects with auth_failed on wrong password", async () => {
    mock = await startMockSshServer({
      acceptAuth: (ctx) => ctx.method === "password" && ctx.password === "correct",
      onExec: () => {},
    });
    await expect(
      executeSshCommand({
        host: "127.0.0.1",
        port: mock.port,
        user: "tester",
        auth: { kind: "password", password: "WRONG" },
        command: "echo never-runs",
        acceptAnyHostKey: true,
      }),
    ).rejects.toMatchObject({ kind: "auth_failed" });
  });

  it("rejects with timeout when the command never finishes", async () => {
    mock = await startMockSshServer({
      acceptAuth: () => true,
      // onExec never calls exit() — command hangs on the server side.
      onExec: () => {},
    });
    const start = Date.now();
    await expect(
      executeSshCommand({
        host: "127.0.0.1",
        port: mock.port,
        user: "tester",
        auth: { kind: "password", password: "anything" },
        command: "sleep 9999",
        timeoutMs: 400,
        acceptAnyHostKey: true,
      }),
    ).rejects.toBeInstanceOf(SshTimeoutError);
    const elapsed = Date.now() - start;
    // The timeout fires at ~400ms; allow a generous upper bound for
    // the teardown + reject to propagate without being flaky.
    expect(elapsed).toBeLessThan(2000);
  });

  it("source never imports fs / path / os (no disk or env surface)", async () => {
    // Belt-and-braces: the executor's security posture demands that
    // credentials never land on disk (writeFile, tempfile, …) or leak
    // via environment inspection (path joins, os.tmpdir, …). ESM
    // prevents reliable runtime-spy verification (vitest's spyOn fails
    // on fs namespace exports) so we assert against the source text
    // instead. If a future change legitimately needs fs (e.g. SSH-agent
    // integration), the new import path is explicit and reviewable —
    // this test becomes the conversation-starter, not a blocker.
    const fsp = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const src = await fsp.readFile(
      resolve(__dirname, "../src/services/ssh-executor.ts"),
      "utf8",
    );
    const bannedImports = [
      'from "node:fs"',
      'from "node:fs/promises"',
      'from "node:path"',
      'from "node:os"',
      'require("node:fs")',
      'require("node:fs/promises")',
      'require("node:os")',
    ];
    for (const banned of bannedImports) {
      expect(src, `ssh-executor must not depend on ${banned}`).not.toContain(banned);
    }
    // ESM-purity guard. The backend is `"type": "module"` in prod; any
    // `require(...)` in this file compiles fine but throws
    // `ReferenceError: require is not defined` at runtime on the first
    // call. Vitest's transform provides a shim, so the mocked-SSH tests
    // above passed for weeks with a hidden `require("node:crypto")`.
    // This regex catches the regression at source-lint time. Named
    // imports at the top of the file are the supported path.
    expect(src, "ssh-executor must not use require(...) — ESM-only module").not.toMatch(
      /\brequire\s*\(/,
    );
  });

  it("reports the host-key fingerprint via onHostKey on first contact", async () => {
    mock = await startMockSshServer({
      acceptAuth: () => true,
      onExec: ({ exit }) => exit(0),
    });
    const fingerprints: Array<{ algo: string; sha256: string }> = [];
    await executeSshCommand({
      host: "127.0.0.1",
      port: mock.port,
      user: "tester",
      auth: { kind: "password", password: "x" },
      command: "true",
      acceptAnyHostKey: true,
      onHostKey: (fp) => fingerprints.push(fp),
    });
    expect(fingerprints.length).toBe(1);
    // SHA-256 digests are 32 bytes → 44 base64 chars (including padding).
    expect(fingerprints[0].sha256).toMatch(/^[A-Za-z0-9+/=]{40,}$/);
  });
});

describe("executeSshCommand — error shape", () => {
  it("SshError keeps its discriminant on instanceof / kind", () => {
    const err = new SshError("nope", "auth_failed");
    expect(err.kind).toBe("auth_failed");
    expect(err).toBeInstanceOf(SshError);
  });
});
