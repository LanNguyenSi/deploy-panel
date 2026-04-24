/**
 * Pre-install VPS probe. Runs one diagnostic SSH command against the
 * target host and parses the output into a structured summary the
 * wizard can use to suggest an install mode (greenfield /
 * existing-traefik / port-only) *before* committing to the 2–5 minute
 * install.sh run.
 *
 * The detection logic mirrors what install.sh v0.2.0's `port80_owner`
 * function does on the VPS side: inspect `docker ps` for a container
 * publishing :80, match its image against Traefik shapes, and fall
 * back to `ss -tlnp` for non-docker listeners. Keeping the logic in
 * sync with install.sh's auto-mode means the wizard's suggestion is
 * the same mode install.sh would pick if left to auto.
 */

import { executeSshCommand, type SshAuth } from "./ssh-executor.js";
import type { RelayMode } from "./install-relay.js";

export type Port80Owner =
  | { kind: "free" }
  | { kind: "traefik"; name: string; image: string }
  | { kind: "docker"; name: string; image: string }
  | { kind: "proc"; process: string }
  | { kind: "unknown" };

export interface DockerPsRow {
  name: string;
  image: string;
  ports: string;
  networks: string[];
}

export interface VpsProbeResult {
  port80: Port80Owner;
  port443: Port80Owner;
  containers: DockerPsRow[];
  networks: string[];
  suggestedMode: Extract<RelayMode, "greenfield" | "existing-traefik" | "port-only">;
  /**
   * When suggestedMode is existing-traefik, the detected Traefik
   * container's primary non-default network. The wizard pre-fills
   * TRAEFIK_NETWORK with this so the relay joins the right place.
   */
  suggestedTraefikNetwork?: string;
}

export interface ProbeVpsOptions {
  host: string;
  port?: number;
  user: string;
  auth: SshAuth;
  timeoutMs?: number;
  acceptAnyHostKey?: boolean;
}

/**
 * Probe script. One bash -c invocation so the whole diagnostic is a
 * single exec on the remote end. Markers (`===SS80===`, etc.) let the
 * local parser split streams without relying on delimiter-perfect
 * output. Every sub-command tolerates missing binaries (`ss`, `docker`)
 * by swallowing stderr and continuing — a host without docker simply
 * yields an empty DOCKER section, which we map to a free-port-greenfield
 * suggestion the same way install.sh would.
 */
const PROBE_SCRIPT = `
set +e
echo '===SS80==='
ss -H -tlnp 2>/dev/null | awk '$4 ~ /:80$/'
echo '===SS443==='
ss -H -tlnp 2>/dev/null | awk '$4 ~ /:443$/'
echo '===DOCKER==='
docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}' 2>/dev/null
echo '===NETWORKS==='
for name in $(docker ps --format '{{.Names}}' 2>/dev/null); do
  nets=$(docker inspect --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$name" 2>/dev/null)
  printf '%s|%s\\n' "$name" "$nets"
done
echo '===ALLNETS==='
docker network ls --format '{{.Name}}' 2>/dev/null
echo '===END==='
`;

function isTraefikImage(image: string): boolean {
  // Mirrors install.sh's is_traefik_image glob.
  // Matches: traefik, traefik:v3, registry.example.com/traefik,
  // registry.example.com/traefik:v3, registry.example.com/team/traefik.
  const trimmed = image.trim();
  if (trimmed === "traefik") return true;
  if (/^traefik:/.test(trimmed)) return true;
  if (/\/traefik$/.test(trimmed)) return true;
  if (/\/traefik:/.test(trimmed)) return true;
  return false;
}

function parseSsLine(line: string): string | undefined {
  // `users:(("nginx",pid=12345,fd=6))` → nginx
  const m = line.match(/users:\(\("([^"]+)"/);
  return m ? m[1] : undefined;
}

function isContainerPublishingPort(row: DockerPsRow, port: number): boolean {
  // `0.0.0.0:80->80/tcp` or `[::]:80->80/tcp` or `127.0.0.1:80->80/tcp`
  // NOT `0.0.0.0:8080->80/tcp` — we only care about the HOST side.
  return new RegExp(`:${port}->`).test(row.ports);
}

export function parseProbeOutput(stdout: string): Omit<VpsProbeResult, "suggestedMode" | "suggestedTraefikNetwork"> & {
  suggestedMode: VpsProbeResult["suggestedMode"];
  suggestedTraefikNetwork?: string;
} {
  // Split the single stdout blob by markers. Lenient line-endings.
  const sections: Record<string, string[]> = {
    SS80: [],
    SS443: [],
    DOCKER: [],
    NETWORKS: [],
    ALLNETS: [],
  };
  let current: keyof typeof sections | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const marker = line.match(/^===([A-Z0-9]+)===$/);
    if (marker) {
      const name = marker[1];
      if (name === "END") {
        current = null;
        continue;
      }
      if (name in sections) {
        current = name as keyof typeof sections;
        continue;
      }
    }
    if (current && line) sections[current].push(line);
  }

  // Parse docker containers.
  const networksByName: Record<string, string[]> = {};
  for (const line of sections.NETWORKS) {
    const [name, nets] = line.split("|", 2);
    if (!name) continue;
    networksByName[name] = (nets ?? "")
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  const containers: DockerPsRow[] = [];
  for (const line of sections.DOCKER) {
    const [name, image, ports] = line.split("|");
    if (!name || !image) continue;
    containers.push({
      name,
      image,
      ports: ports ?? "",
      networks: networksByName[name] ?? [],
    });
  }

  const resolvePort = (portNum: number, ssLines: string[]): Port80Owner => {
    const dockerMatch = containers.find((c) => isContainerPublishingPort(c, portNum));
    if (dockerMatch) {
      if (isTraefikImage(dockerMatch.image)) {
        return { kind: "traefik", name: dockerMatch.name, image: dockerMatch.image };
      }
      return { kind: "docker", name: dockerMatch.name, image: dockerMatch.image };
    }
    if (ssLines.length === 0) return { kind: "free" };
    const proc = parseSsLine(ssLines[0]);
    return proc ? { kind: "proc", process: proc } : { kind: "unknown" };
  };

  const port80 = resolvePort(80, sections.SS80);
  const port443 = resolvePort(443, sections.SS443);

  // Auto-mode decision (mirrors install.sh's Step-3 dispatch, minus the
  // refuse-on-unknown branch — the wizard surfaces the suggestion but
  // the user confirms before install runs, so an "unknown" port 80
  // still needs a concrete suggestion. We pick port-only in that case;
  // the operator can override via the dropdown.)
  let suggestedMode: VpsProbeResult["suggestedMode"];
  let suggestedTraefikNetwork: string | undefined;
  if (port80.kind === "free") {
    suggestedMode = "greenfield";
  } else if (port80.kind === "traefik") {
    suggestedMode = "existing-traefik";
    const container = containers.find((c) => c.name === port80.name);
    const candidateNet = container?.networks.find(
      (n) => n !== "bridge" && n !== "host" && n !== "none",
    );
    if (candidateNet) suggestedTraefikNetwork = candidateNet;
  } else {
    suggestedMode = "port-only";
  }

  const networks = sections.ALLNETS.filter((n) => n.length > 0);
  return {
    port80,
    port443,
    containers,
    networks,
    suggestedMode,
    ...(suggestedTraefikNetwork ? { suggestedTraefikNetwork } : {}),
  };
}

export async function probeVps(opts: ProbeVpsOptions): Promise<VpsProbeResult> {
  let stdoutBuffer = "";
  await executeSshCommand({
    host: opts.host,
    port: opts.port,
    user: opts.user,
    auth: opts.auth,
    // ssh2 exec passes the command string to the remote's login shell
    // as the `-c` arg; multi-line scripts with actual newlines work
    // fine (no JSON-escape wrapper — that would encode \n as two chars
    // and break the script).
    command: PROBE_SCRIPT,
    onStdout: (line) => {
      stdoutBuffer += line + "\n";
    },
    acceptAnyHostKey: opts.acceptAnyHostKey ?? true,
    // Short: the probe is two local commands on the VPS. 30s is
    // generous even for a laggy SSH round-trip.
    timeoutMs: opts.timeoutMs ?? 30_000,
  });
  return parseProbeOutput(stdoutBuffer);
}
