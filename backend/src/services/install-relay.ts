/**
 * Relay-install orchestration. Wraps `executeSshCommand` with the
 * installer-specific concerns:
 *
 * 1. Build a shell-safe command string that injects validated env vars
 *    into `install.sh` without string-interpolating user input.
 * 2. Parse `URL:` and `Token:` out of the installer's final output.
 *
 * The module is pure — no SSH client state, no I/O of its own — so the
 * route layer can test it in isolation and the SSH-execution layer
 * (commit 1) stays focused on the transport.
 */

/**
 * URL the installer is pulled from. Hardcoded (not user-configurable
 * via request body) so a malicious caller cannot redirect the install
 * to a lookalike script.
 *
 * The installer script is pinned to an agent-relay release tag instead
 * of the `main` branch, so a push to `main` cannot change the script
 * that runs as root on a VPS. The `refs/tags/` form means a branch that
 * happens to share the tag's name cannot shadow it. Renovate proposes
 * bumps through the regex manager in `renovate.json`, which reads the
 * tag out of the line below: keep the URL on one line and in this
 * shape. Every bump waits for approval on the Dependency Dashboard
 * while agent-relay is 0.x. Not pinned: the script's own fetches. It
 * deploys `ghcr.io/lannguyensi/agent-relay:latest` (follows agent-relay
 * `main`, runs with the Docker socket mounted) and runs
 * `curl -fsSL https://get.docker.com | bash` when Docker is missing.
 * A git tag can also be moved by an agent-relay admin.
 */
export const INSTALL_SCRIPT_URL =
  "https://raw.githubusercontent.com/LanNguyenSi/agent-relay/refs/tags/v0.9.0/install.sh";

export type RelayMode = "auto" | "greenfield" | "existing-traefik" | "port-only";

export interface InstallEnvVars {
  /** FQDN for Traefik TLS. Omit for port-only mode. */
  relayDomain?: string;
  /** Email for Let's Encrypt. Required if relayDomain is set. */
  traefikEmail?: string;
  /** Host dir on the VPS containing app repos. Defaults to install.sh's own default when omitted. */
  appsDir?: string;
  /** install.sh v0.2.0 mode. Omit to let the installer auto-detect. */
  relayMode?: RelayMode;
  /** Docker network for existing-traefik mode. Default `traefik-public` on the installer side. */
  traefikNetwork?: string;
  /** ACME resolver name on an existing Traefik. Default `letsencrypt`. */
  traefikCertResolver?: string;
  /** Host bind IP, for port-only and greenfield (greenfield with TLS defaults to `127.0.0.1`, without it empty means all interfaces); ignored with existing Traefik. */
  relayBind?: string;
  /** Absolute path on the VPS where install.sh should put compose + .env. Default `/opt/agent-relay`. */
  relayDir?: string;
}

/**
 * Shell-escape a value for embedding in a single-quoted string.
 * Wraps in `'…'` and replaces any internal single-quote with
 * `'"'"'` (close quote, literal quote, reopen). This is the standard
 * POSIX-portable shell-escape and protects against any metachar in
 * the value.
 */
function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Exit code the remote command uses when it could not download the
 * installer. The download happens before the installer runs and before
 * a re-install removes the relay's .env, so this code means the installer
 * did not run. Any other non-zero exit means the installer itself (or a
 * step after the download) failed.
 */
export const INSTALLER_FETCH_FAILED_EXIT_CODE = 97;

export interface BuildInstallCommandOptions {
  /**
   * Absolute path of a file to remove with `sudo rm -f` after the
   * installer was downloaded and before it runs (token rotation: the
   * installer keeps the token of an existing `.env`). The removal sits
   * behind the download, so a failed download leaves the file alone.
   */
  removeBeforeRun?: string;
}

// Same shape the route schema enforces for `relayDir`. Checked again here
// because the path goes into the remote script without quoting.
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]*$/;

/**
 * Build the command that runs on the VPS. Structured as:
 *
 *   env VAR='…' VAR='…' bash -c '<script>'
 *
 * where the script downloads the installer to a temp file first and only
 * then runs it as root:
 *
 *   set -euo pipefail
 *   f=$(mktemp); trap 'rm -f "$f"' EXIT
 *   curl -fsSL <url> -o "$f" || exit 97
 *   [sudo rm -f <removeBeforeRun>]
 *   sudo -E bash "$f" </dev/null || { rc=$?; [ "$rc" -ne 97 ] || rc=1; exit "$rc"; }
 *
 * The installer reads no stdin (the ssh channel's stdin is closed off), and
 * an installer exit of 97 is rewritten to 1 so that 97 can only come from
 * the download step.
 *
 * User-supplied env values are single-quote-escaped so no value can
 * break out of its quoting. The script is a FIXED string: the installer
 * URL is compile-time and has no user-controlled parts.
 *
 * Fetching to a file keeps a failed download apart from a failed
 * installer (exit 97 versus the installer's own code) and lets the
 * caller order destructive steps behind the download. `curl -f` makes a
 * 404 or a network error a failure instead of a body to execute, so
 * nothing is ever piped into a root shell.
 *
 * `sudo -E bash` preserves the env vars we set; install.sh reads
 * RELAY_DOMAIN, TRAEFIK_EMAIL, APPS_DIR from its process env.
 */
export function buildInstallCommand(
  env: InstallEnvVars,
  opts: BuildInstallCommandOptions = {},
): string {
  const envPairs: string[] = [];
  if (env.relayDomain !== undefined) {
    envPairs.push(`RELAY_DOMAIN=${shellEscape(env.relayDomain)}`);
  }
  if (env.traefikEmail !== undefined) {
    envPairs.push(`TRAEFIK_EMAIL=${shellEscape(env.traefikEmail)}`);
  }
  if (env.appsDir !== undefined) {
    envPairs.push(`APPS_DIR=${shellEscape(env.appsDir)}`);
  }
  if (env.relayMode !== undefined) {
    envPairs.push(`RELAY_MODE=${shellEscape(env.relayMode)}`);
  }
  if (env.traefikNetwork !== undefined) {
    envPairs.push(`TRAEFIK_NETWORK=${shellEscape(env.traefikNetwork)}`);
  }
  if (env.traefikCertResolver !== undefined) {
    envPairs.push(`TRAEFIK_CERTRESOLVER=${shellEscape(env.traefikCertResolver)}`);
  }
  if (env.relayBind !== undefined) {
    envPairs.push(`RELAY_BIND=${shellEscape(env.relayBind)}`);
  }
  if (env.relayDir !== undefined) {
    envPairs.push(`RELAY_DIR=${shellEscape(env.relayDir)}`);
  }
  const envPrefix = envPairs.length > 0 ? `env ${envPairs.join(" ")} ` : "";
  const removeStep =
    opts.removeBeforeRun !== undefined
      ? `sudo rm -f ${assertSafeAbsolutePath(opts.removeBeforeRun)}; `
      : "";
  // INSTALL_SCRIPT_URL is a compile-time constant, not exposed to the
  // caller, so no interpolation risk here. The script is one fixed
  // string, quoted as a whole so the `$f` and the trap's inner quotes
  // reach the remote bash untouched.
  const script =
    `set -euo pipefail; f=$(mktemp); trap 'rm -f "$f"' EXIT; ` +
    `curl -fsSL ${INSTALL_SCRIPT_URL} -o "$f" || exit ${INSTALLER_FETCH_FAILED_EXIT_CODE}; ` +
    `${removeStep}sudo -E bash "$f" </dev/null || ` +
    `{ rc=$?; [ "$rc" -ne ${INSTALLER_FETCH_FAILED_EXIT_CODE} ] || rc=1; exit "$rc"; }`;
  return `${envPrefix}bash -c ${shellEscape(script)}`;
}

function assertSafeAbsolutePath(p: string): string {
  if (!SAFE_ABSOLUTE_PATH.test(p) || p.split("/").includes("..")) {
    throw new Error("refusing to build an install command with an unsafe path");
  }
  return p;
}

/**
 * Strip ANSI color / cursor escape sequences so the token-parse regex
 * sees bare text. install.sh uses `${CYAN}…${NC}` around the URL and
 * `${YELLOW}…${NC}` around the token; those escapes would otherwise
 * sit between the label and the value.
 */
function stripAnsi(s: string): string {
  // Covers CSI sequences (`\x1b[…m`, `\x1b[…H`, etc.) and OSC close.
  // Small regex; not a full ANSI parser, but install.sh uses only the
  // simple color forms.
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

export interface InstallOutputParseResult {
  relayUrl: string;
  relayToken: string;
  /** Install mode reported by agent-relay v0.2.0+. Absent for older installers. */
  relayMode?: RelayMode;
}

export interface InstallOutputParseError {
  kind: "token_not_found" | "url_not_found";
  message: string;
}

/**
 * Parse the final `URL: …` and `Token: …` lines from a successful
 * install.sh run. Matches the primary connection-info block (2-space
 * indent); the "Add to deploy-panel:" block later on uses "Relay URL:"
 * / "Relay Token:" labels and we deliberately don't match those —
 * they're the same values restated, and pinning to one source of
 * truth makes a future installer-format change easier to spot.
 *
 * Regex notes:
 * - `/m` to match per line
 * - `^\s*URL:\s+(\S+)` — tolerates the indent + any whitespace run
 * - We require `URL:` not `Relay URL:` to avoid matching the
 *   lower block. The negative-lookbehind would also work but adds
 *   regex complexity with no win.
 */
export function parseInstallOutput(
  stdout: string,
): { ok: true; value: InstallOutputParseResult } | { ok: false; error: InstallOutputParseError } {
  const clean = stripAnsi(stdout);
  const urlMatch = clean.match(/^[ \t]*URL:\s+(\S+)/m);
  if (!urlMatch) {
    return {
      ok: false,
      error: {
        kind: "url_not_found",
        message: "installer output did not contain a `URL:` line",
      },
    };
  }
  const tokenMatch = clean.match(/^[ \t]*Token:\s+(\S+)/m);
  if (!tokenMatch) {
    return {
      ok: false,
      error: {
        kind: "token_not_found",
        message: "installer output did not contain a `Token:` line",
      },
    };
  }
  // install.sh v0.2.0+ prints `  Mode:  <mode>` above the URL line.
  // Treat this as optional — older installers (v0.1.x) will still parse
  // fine because Mode is not required by the contract.
  const modeMatch = clean.match(/^[ \t]*Mode:\s+(\S+)/m);
  let relayMode: RelayMode | undefined;
  if (modeMatch) {
    const candidate = modeMatch[1];
    if (
      candidate === "greenfield" ||
      candidate === "existing-traefik" ||
      candidate === "port-only" ||
      candidate === "auto"
    ) {
      relayMode = candidate;
    }
  }
  return {
    ok: true,
    value: {
      relayUrl: urlMatch[1],
      relayToken: tokenMatch[1],
      ...(relayMode ? { relayMode } : {}),
    },
  };
}

export interface InstallExitError {
  kind: "installer_fetch_failed" | "installer_failed";
  message: string;
}

const STDERR_MESSAGE_MAX = 200;

/**
 * Reduce one stderr line from the VPS to text that is safe to put into an
 * error message: no escape sequences, no control characters, bounded
 * length. The line is output of a host the caller may control.
 */
function sanitizeStderrLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  const bare = stripAnsi(line).replace(/[\x00-\x1f\x7f]/g, " ").trim();
  return bare.length > STDERR_MESSAGE_MAX ? `${bare.slice(0, STDERR_MESSAGE_MAX)}…` : bare;
}

/**
 * Classify the exit code of the install command. Returns null for exit 0
 * (the caller then parses stdout). Exit 97 means the installer download
 * failed before the installer ran; any other non-zero exit (including -1, no
 * code reported) means the installer or a step after the download failed,
 * whatever stdout contains: a complete URL/Token block printed before a
 * late failure is not a success.
 */
export function classifyInstallExit(
  exitCode: number,
  lastStderrLine?: string,
): InstallExitError | null {
  if (exitCode === 0) return null;
  const detail = lastStderrLine ? sanitizeStderrLine(lastStderrLine) : "";
  if (exitCode === INSTALLER_FETCH_FAILED_EXIT_CODE) {
    return {
      kind: "installer_fetch_failed",
      message: detail
        ? `could not download the installer: ${detail}`
        : "could not download the installer",
    };
  }
  return {
    kind: "installer_failed",
    message: `the installer exited with code ${exitCode}${detail ? `: ${detail}` : ""}`,
  };
}
