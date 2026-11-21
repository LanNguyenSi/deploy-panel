import { Server, type AuthContext, type Connection, type ServerConfig } from "ssh2";
import { generateKeyPairSync } from "node:crypto";

/**
 * Stand up an in-process ssh2 Server that serves one connection and
 * exposes hooks to control authentication + command behaviour. Mirrors
 * the ssh2 docs example but trimmed to what the executor's unit tests
 * actually exercise.
 */
export interface MockSshServerOpts {
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

export interface StartedMockServer {
  port: number;
  close: () => Promise<void>;
}

export async function startMockSshServer(opts: MockSshServerOpts): Promise<StartedMockServer> {
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
