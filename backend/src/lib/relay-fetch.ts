/**
 * The one way the panel fetches a server's `relayUrl`.
 *
 * Redirects are never followed. The non-admin target guard checks the host
 * of the stored `relayUrl`; a relay that answers `302 Location:
 * http://169.254.169.254/...` would otherwise make the panel fetch an address
 * the guard never saw and hand its body back to the caller. A relay has no
 * reason to redirect (post-deploy-gate.ts uses `redirect: "manual"` for the
 * same reason), so any 3xx is turned into a generic 502 with a fixed body:
 * every caller already treats a non-2xx answer as a relay error, and nothing
 * the redirecting host sent is passed on.
 */
export const RELAY_REDIRECT_MESSAGE =
  "the relay answered with a redirect, which the panel does not follow";

export async function relayFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, redirect: "manual" });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    return new Response(RELAY_REDIRECT_MESSAGE, {
      status: 502,
      headers: { "content-type": "text/plain" },
    });
  }
  return res;
}
