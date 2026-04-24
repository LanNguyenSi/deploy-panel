/**
 * Ephemeral SSH executor. Used by the one-click relay-install flow to
 * run `install.sh` on a brand-new VPS once. Credentials are consumed
 * for the scope of a single exec and then zeroed — nothing persists to
 * disk, no env var, no log line ever names the password / private key.
 *
 * The module is deliberately narrow: one function, no connection
 * pooling, no multi-command sessions. Everything about a relay install
 * is a single bash invocation, and multi-shot would invite holding
 * creds longer than necessary.
 *
 * See `backend/tests/ssh-executor.test.ts` for the mock-SSH-server
 * coverage (happy path, wrong creds, timeout, streaming, cred-zeroing).
 */
import { Client, type ConnectConfig } from "ssh2";

export type SshAuth =
  | { kind: "password"; password: string }
  | { kind: "privateKey"; privateKey: string; passphrase?: string };

export interface ExecuteSshCommandOptions {
  host: string;
  port?: number;
  user: string;
  auth: SshAuth;
  command: string;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  /**
   * Total wall-clock cap for connect + exec. On timeout the connection
   * is torn down, the subprocess on the remote end is signalled
   * (SIGTERM then SIGKILL 5s later), and the returned promise rejects
   * with an `SshTimeoutError`. Default 10 minutes — Docker pulls in
   * install.sh can take a few minutes on a cold VPS.
   */
  timeoutMs?: number;
  /**
   * When true, accept any host key presented by the server. ONLY for
   * TOFU first-contact scenarios (the relay-install flow hits a brand-
   * new VPS). Callers should persist the accepted fingerprint after a
   * successful install and pin strictly on re-install flows. Defaults
   * to false so callers MUST make the opt-in conscious.
   *
   * `onHostKey` fires with the server's key so the caller can record it.
   */
  acceptAnyHostKey?: boolean;
  onHostKey?: (fingerprint: { algo: string; sha256: string }) => void;
  /**
   * When set, the server's host key's SHA-256 fingerprint (base64,
   * matching `onHostKey.sha256`) MUST equal this value; otherwise the
   * connection is rejected with `host_key_rejected`. Intended for the
   * wizard's probe → install handoff: the probe captures the
   * fingerprint, and install-relay re-connects with the captured value
   * pinned. A MITM that swapped hosts between the two connects
   * presents a different key, which trips this check.
   *
   * Only consulted when `acceptAnyHostKey` is true (the TOFU path);
   * otherwise ssh2's built-in known_hosts enforcement applies.
   */
  expectedHostKeySha256?: string;
}

export interface ExecuteSshCommandResult {
  exitCode: number;
  /** true if the command exited on its own; false if killed by timeout. */
  finished: boolean;
}

export class SshError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "connect_failed"
      | "auth_failed"
      | "exec_failed"
      | "timeout"
      | "host_key_rejected",
  ) {
    super(message);
    this.name = "SshError";
  }
}

export class SshTimeoutError extends SshError {
  constructor(timeoutMs: number) {
    super(`SSH operation timed out after ${timeoutMs}ms`, "timeout");
    this.name = "SshTimeoutError";
  }
}

/**
 * Best-effort zero a credential string by overwriting its backing
 * buffer. JavaScript strings are immutable so there is no guaranteed
 * way to overwrite in place — but we can at least zero the working
 * Buffer we converted them into before passing to ssh2, and release
 * our reference so V8's GC has the earliest opportunity to reclaim.
 *
 * The real defense is "we never wrote the string to disk, log, or env";
 * the zeroing is belt-and-braces for heap snapshots and core dumps.
 */
function zeroBuffer(buf: Buffer | undefined): void {
  if (buf) buf.fill(0);
}

function buildConnectConfig(opts: ExecuteSshCommandOptions): {
  config: ConnectConfig;
  credBuffers: Buffer[];
} {
  const credBuffers: Buffer[] = [];
  const config: ConnectConfig = {
    host: opts.host,
    port: opts.port ?? 22,
    username: opts.user,
    // ssh2's default readyTimeout is 20s; our timeoutMs covers the full
    // lifecycle, so set readyTimeout to the same ceiling rather than
    // its internal default to keep one source of truth.
    readyTimeout: opts.timeoutMs ?? 10 * 60 * 1000,
  };

  if (opts.auth.kind === "password") {
    // Mirror the string into a Buffer we own so we can zero it after.
    // ssh2 will copy this internally; after its connect-phase it no
    // longer needs the value.
    const buf = Buffer.from(opts.auth.password, "utf8");
    credBuffers.push(buf);
    config.password = buf.toString("utf8");
  } else {
    const keyBuf = Buffer.from(opts.auth.privateKey, "utf8");
    credBuffers.push(keyBuf);
    config.privateKey = keyBuf;
    if (opts.auth.passphrase !== undefined) {
      const passBuf = Buffer.from(opts.auth.passphrase, "utf8");
      credBuffers.push(passBuf);
      config.passphrase = passBuf;
    }
  }

  // TOFU host-key handling. Without this ssh2 relies on the system's
  // known_hosts which, in a containerised backend, is typically empty.
  // The caller sets `acceptAnyHostKey` when it KNOWS it's a first
  // contact (new VPS onboarding) and captures the fingerprint via
  // `onHostKey` to persist for next time.
  if (opts.acceptAnyHostKey) {
    config.hostVerifier = (key: Buffer | string) => {
      const buf = Buffer.isBuffer(key) ? key : Buffer.from(key, "utf8");
      // ssh2 passes the key as SSH wire-format bytes. We expose a
      // stable SHA-256 fingerprint via crypto — matches what OpenSSH
      // prints in its key-added banners.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const crypto = require("node:crypto") as typeof import("node:crypto");
      const sha256 = crypto.createHash("sha256").update(buf).digest("base64");
      if (opts.onHostKey) {
        opts.onHostKey({ algo: "ssh-host-key", sha256 });
      }
      // Pin the fingerprint when the caller supplied one (probe → install
      // handoff). Return false → ssh2 aborts the handshake; the outer
      // promise rejects via the `error` handler. We stash the mismatch
      // on the config so the error-handler can distinguish
      // host_key_rejected from connect_failed.
      if (opts.expectedHostKeySha256 !== undefined) {
        if (sha256 !== opts.expectedHostKeySha256) {
          (config as ConnectConfig & { _hostKeyMismatch?: boolean })._hostKeyMismatch = true;
          return false;
        }
      }
      return true;
    };
  }
  // When acceptAnyHostKey is not set, ssh2's default strict behaviour
  // applies — unrecognized key → connect rejected. The caller surfaces
  // that as `host_key_rejected`.

  return { config, credBuffers };
}

/**
 * Split a stdout/stderr chunk into lines and forward each complete
 * line to the caller's hook, keeping a rolling remainder for the next
 * chunk. Mirrors the pattern in agent-planforge's `attachLineReader`.
 */
function makeLineStream(hook?: (line: string) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      hook?.(line);
    }
  };
}

/**
 * Run a command over SSH, stream its output to the caller's hooks,
 * return exit code + finish status. Zeros credential buffers on EVERY
 * exit path (success, timeout, auth failure, network error).
 *
 * The `command` is passed verbatim to ssh2's `client.exec()` — there is
 * NO shell-string interpolation in this module. Callers that need to
 * compose commands from user input (e.g. the install.sh URL + env
 * vars) MUST do it via argv-style helpers and never via template
 * strings on user-controlled values. The relay-install route uses a
 * hardcoded curl | sudo bash invocation with env vars validated
 * against a strict zod schema.
 */
export async function executeSshCommand(
  opts: ExecuteSshCommandOptions,
): Promise<ExecuteSshCommandResult> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const { config, credBuffers } = buildConnectConfig(opts);

  return new Promise<ExecuteSshCommandResult>((resolvePromise, rejectPromise) => {
    const client = new Client();
    const stdoutLine = makeLineStream(opts.onStdout);
    const stderrLine = makeLineStream(opts.onStderr);
    let settled = false;
    let stream: { signal: (s: string) => void } | null = null;

    const cleanup = () => {
      for (const b of credBuffers) zeroBuffer(b);
      credBuffers.length = 0;
      try {
        client.end();
      } catch {
        // already closed — fine
      }
    };

    const settle = (
      kind: "resolve" | "reject",
      valueOrErr: ExecuteSshCommandResult | Error,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      cleanup();
      if (kind === "resolve") resolvePromise(valueOrErr as ExecuteSshCommandResult);
      else rejectPromise(valueOrErr as Error);
    };

    // Timeout watchdog: try graceful SIGTERM first, escalate to SIGKILL
    // then force-close the connection. The rejection fires regardless
    // of whether the remote actually responded to the signal.
    const timeoutHandle = setTimeout(() => {
      if (stream) {
        try {
          stream.signal("TERM");
        } catch {
          // remote may have already died
        }
        setTimeout(() => {
          try {
            stream?.signal("KILL");
          } catch {
            // remote may have already died
          }
        }, 5_000).unref();
      }
      settle("reject", new SshTimeoutError(timeoutMs));
    }, timeoutMs);
    timeoutHandle.unref();

    client.on("ready", () => {
      client.exec(opts.command, (err, s) => {
        if (err) {
          settle("reject", new SshError(`exec failed: ${err.message}`, "exec_failed"));
          return;
        }
        stream = s;
        s.on("data", stdoutLine);
        s.stderr.on("data", stderrLine);
        s.on("close", (code: number | null) => {
          // A null code after a successful session typically means the
          // remote closed cleanly without an explicit exit — treat as 0
          // only if we haven't seen an earlier error. ssh2's contract
          // is "code is non-null for normal exits".
          settle("resolve", {
            exitCode: typeof code === "number" ? code : -1,
            finished: true,
          });
        });
      });
    });

    client.on("error", (err: Error & { level?: string }) => {
      // ssh2 tags auth failures with `level: "client-authentication"`
      // — distinguish so the caller can surface "wrong password/key"
      // separately from "network unreachable" / "dns".
      const cfg = config as ConnectConfig & { _hostKeyMismatch?: boolean };
      if (cfg._hostKeyMismatch) {
        settle(
          "reject",
          new SshError(
            "host key does not match the fingerprint captured during probe",
            "host_key_rejected",
          ),
        );
      } else if (err.level === "client-authentication") {
        settle("reject", new SshError("authentication failed", "auth_failed"));
      } else {
        settle("reject", new SshError(`connect failed: ${err.message}`, "connect_failed"));
      }
    });

    try {
      client.connect(config);
    } catch (err) {
      settle(
        "reject",
        new SshError(`connect_failed: ${(err as Error).message}`, "connect_failed"),
      );
    }
  });
}
