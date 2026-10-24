/**
 * Resolve the newest published `ghcr.io/lannguyensi/agent-relay:latest` image
 * revision via GHCR's anonymous token + OCI manifest/config endpoints, and
 * compare it against a server's running relay `/health` revision.
 *
 * Fail-soft rule: if GHCR is unreachable, rate-limited, returns an unexpected
 * shape, or the relay is unreachable / reports `"unknown"` (or no revision),
 * `relayOutdated` is `null` (state `"unknown"`), never `true`.
 */

export const GHCR_TOKEN_URL =
  "https://ghcr.io/token?scope=repository:lannguyensi/agent-relay:pull";
export const GHCR_MANIFEST_URL =
  "https://ghcr.io/v2/lannguyensi/agent-relay/manifests/latest";
export const GHCR_MANIFEST_BY_DIGEST_PREFIX =
  "https://ghcr.io/v2/lannguyensi/agent-relay/manifests/";
export const GHCR_BLOB_URL_PREFIX =
  "https://ghcr.io/v2/lannguyensi/agent-relay/blobs/";

export const GHCR_CACHE_TTL_MS = 5 * 60 * 1000;
const GHCR_TIMEOUT_MS = 5_000;

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const BLOB_ACCEPT = [
  "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.container.image.v1+json",
  "application/json",
].join(", ");

interface CachedRevision {
  value: string;
  expiresAt: number;
}

let cachedLatestRevision: CachedRevision | null = null;

export function resetGhcrCache(): void {
  cachedLatestRevision = null;
}

/**
 * Normalize a commit SHA string. Accepts 7–40 hex characters.
 * Returns `null` for missing values, `"unknown"`, or non-hex strings.
 */
export function normalizeRevision(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === "unknown") return null;
  if (!/^[0-9a-f]{7,40}$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Compare the relay's running revision against the newest published GHCR
 * revision. Returns `null` whenever either side is unknown/missing so an
 * unreachable relay or GHCR never produces a false `"outdated"` badge.
 */
export function computeRelayOutdated(
  relayRevision: string | null | undefined,
  latestRevision: string | null | undefined,
): boolean | null {
  const running = normalizeRevision(relayRevision);
  const latest = normalizeRevision(latestRevision);
  if (!running || !latest) return null;
  return running !== latest;
}

async function extractRevisionFromManifest(
  manifest: Record<string, any>,
  token: string,
): Promise<string | null> {
  const directAnnotation = normalizeRevision(
    manifest?.annotations?.["org.opencontainers.image.revision"],
  );
  if (directAnnotation) return directAnnotation;

  let configDigest: string | null =
    typeof manifest?.config?.digest === "string" ? manifest.config.digest : null;

  if (!configDigest && Array.isArray(manifest?.manifests) && manifest.manifests.length > 0) {
    for (const entry of manifest.manifests) {
      const entryRev = normalizeRevision(
        entry?.annotations?.["org.opencontainers.image.revision"],
      );
      if (entryRev) return entryRev;
    }

    const platformEntry =
      manifest.manifests.find(
        (m: any) =>
          typeof m?.digest === "string" &&
          m?.platform?.architecture &&
          m.platform.architecture !== "unknown",
      ) ?? manifest.manifests.find((m: any) => typeof m?.digest === "string");

    if (platformEntry?.digest) {
      const subRes = await fetch(
        `${GHCR_MANIFEST_BY_DIGEST_PREFIX}${platformEntry.digest}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: MANIFEST_ACCEPT,
          },
          signal: AbortSignal.timeout(GHCR_TIMEOUT_MS),
        },
      );
      if (!subRes.ok) return null;
      const subManifest = (await subRes.json()) as Record<string, any>;
      const subAnnotation = normalizeRevision(
        subManifest?.annotations?.["org.opencontainers.image.revision"],
      );
      if (subAnnotation) return subAnnotation;
      if (typeof subManifest?.config?.digest === "string") {
        configDigest = subManifest.config.digest;
      }
    }
  }

  if (!configDigest) return null;

  const blobRes = await fetch(`${GHCR_BLOB_URL_PREFIX}${configDigest}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: BLOB_ACCEPT,
    },
    signal: AbortSignal.timeout(GHCR_TIMEOUT_MS),
  });
  if (!blobRes.ok) return null;

  const blob = (await blobRes.json()) as Record<string, any>;
  return normalizeRevision(
    blob?.config?.Labels?.["org.opencontainers.image.revision"] ??
      blob?.container_config?.Labels?.["org.opencontainers.image.revision"],
  );
}

/**
 * Fetch the `org.opencontainers.image.revision` of
 * `ghcr.io/lannguyensi/agent-relay:latest`, cached in memory for 5 minutes.
 * Returns `null` on any network, auth, status, or parse failure.
 */
export async function getLatestRelayRevision(options?: {
  forceRefresh?: boolean;
  ttlMs?: number;
}): Promise<string | null> {
  const now = Date.now();
  if (
    !options?.forceRefresh &&
    cachedLatestRevision &&
    now < cachedLatestRevision.expiresAt
  ) {
    return cachedLatestRevision.value;
  }

  try {
    const tokenRes = await fetch(GHCR_TOKEN_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(GHCR_TIMEOUT_MS),
    });
    if (!tokenRes.ok) return null;

    const tokenData = (await tokenRes.json()) as {
      token?: string;
      access_token?: string;
    };
    const token = tokenData?.token || tokenData?.access_token;
    if (typeof token !== "string" || !token) return null;

    const manifestRes = await fetch(GHCR_MANIFEST_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: MANIFEST_ACCEPT,
      },
      signal: AbortSignal.timeout(GHCR_TIMEOUT_MS),
    });
    if (!manifestRes.ok) return null;

    const manifest = (await manifestRes.json()) as Record<string, any>;
    const revision = await extractRevisionFromManifest(manifest, token);
    if (!revision) return null;

    cachedLatestRevision = {
      value: revision,
      expiresAt: Date.now() + (options?.ttlMs ?? GHCR_CACHE_TTL_MS),
    };
    return revision;
  } catch {
    return null;
  }
}

export interface RelayHealthProbe {
  online: boolean;
  status: number | null;
  version: string | null;
  revision: string | null;
  data: Record<string, unknown> | null;
}

/**
 * Probe a server's relay `GET /health` endpoint and extract its normalized
 * build revision. Never throws.
 */
export async function fetchRelayHealth(
  server: { relayUrl?: string | null; relayToken?: string | null },
  timeoutMs = 5000,
): Promise<RelayHealthProbe> {
  if (!server.relayUrl) {
    return { online: false, status: null, version: null, revision: null, data: null };
  }

  try {
    const headers: Record<string, string> = {};
    if (server.relayToken) {
      headers["Authorization"] = `Bearer ${server.relayToken}`;
    }

    const response = await fetch(`${server.relayUrl}/health`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return {
        online: false,
        status: response.status,
        version: null,
        revision: null,
        data: null,
      };
    }

    const data = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const revision = normalizeRevision(data?.revision);
    const version = typeof data?.version === "string" ? data.version : null;
    return {
      online: true,
      status: response.status,
      version,
      revision,
      data,
    };
  } catch {
    return { online: false, status: null, version: null, revision: null, data: null };
  }
}

export interface ServerRelayStatus {
  relayRevision: string | null;
  latestRevision: string | null;
  relayOutdated: boolean | null;
  state: "current" | "outdated" | "unknown";
}

/**
 * Compute `{ relayRevision, latestRevision, relayOutdated, state }` for a
 * server by reading its `/health` and the cached GHCR `:latest` revision.
 */
export async function getServerRelayStatus(server: {
  relayUrl?: string | null;
  relayToken?: string | null;
}): Promise<ServerRelayStatus> {
  if (!server.relayUrl) {
    return {
      relayRevision: null,
      latestRevision: null,
      relayOutdated: null,
      state: "unknown",
    };
  }

  const [health, latestRevision] = await Promise.all([
    fetchRelayHealth(server),
    getLatestRelayRevision(),
  ]);

  const relayRevision = health.online ? health.revision : null;
  const relayOutdated = computeRelayOutdated(relayRevision, latestRevision);
  const state =
    relayOutdated === true
      ? "outdated"
      : relayOutdated === false
        ? "current"
        : "unknown";

  return {
    relayRevision,
    latestRevision,
    relayOutdated,
    state,
  };
}
