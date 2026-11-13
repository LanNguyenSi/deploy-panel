/**
 * A fetch-shaped request over `node:http(s)` whose connection resolves its
 * host through `guardedLookup` (lib/connect-guard.ts), so the socket can only
 * go to an address that was classified at connect time.
 *
 * Why not the global `fetch`: it is undici, and a custom `lookup` can only be
 * injected through an undici `Agent`, which Node does not export without the
 * `undici` package. `node:http(s)` accepts a `lookup` request option, needs no
 * dependency, and the relay calls use nothing beyond method, headers, a string
 * body, an abort signal and a streamed response body.
 *
 * Differences from fetch that matter here: redirects are never followed (the
 * 3xx answer is returned as is; `relayFetch` turns it into a 502), request
 * bodies must be a string or bytes, and response bodies are not decompressed
 * (the request sends no `Accept-Encoding`). An IP-literal host never reaches a
 * lookup function (Node skips it), so it is classified here before connecting.
 *
 * Errors follow undici so the shared probe classifier keeps working: a
 * transport failure (refused, denied, DNS, TLS, parse, connect timeout) is a
 * `TypeError("fetch failed")` with the real error as `cause`; the reason of an
 * aborted signal is passed through unchanged. Like undici, the connection
 * attempt gives up after 10 seconds (cause code `ETIMEDOUT`).
 */
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { assertLiteralAllowed, guardedLookup } from "./connect-guard.js";

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** How long the TCP (and TLS) handshake may take; undici's default is the same. */
export const CONNECT_TIMEOUT_MS = 10_000;

export interface GuardedFetchOptions {
  /** Test hook; defaults to `CONNECT_TIMEOUT_MS`. */
  connectTimeoutMs?: number;
}

function fetchFailed(cause: unknown): TypeError {
  return new TypeError("fetch failed", { cause });
}

export async function guardedFetch(
  url: string,
  init: RequestInit = {},
  options: GuardedFetchOptions = {},
): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new TypeError(`unsupported protocol ${target.protocol}`);
  }
  const host = target.hostname.replace(/^\[|\]$/g, "");
  // Node does not call `lookup` for an IP literal, so classify it here.
  if (isIP(host)) {
    try {
      assertLiteralAllowed(host);
    } catch (err) {
      throw fetchFailed(err);
    }
  }

  const body = init.body;
  let payload: string | Uint8Array | undefined;
  if (body === undefined || body === null) payload = undefined;
  else if (typeof body === "string" || body instanceof Uint8Array) payload = body;
  else throw new TypeError("guardedFetch supports only string or byte request bodies");

  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });
  if (payload !== undefined && headers["content-length"] === undefined) {
    headers["content-length"] = String(Buffer.byteLength(payload));
  }

  const signal = init.signal ?? undefined;
  if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");

  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;

  return new Promise<Response>((resolve, reject) => {
    const secure = target.protocol === "https:";
    const transport = secure ? https : http;
    let incoming: http.IncomingMessage | undefined;
    let done = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;

    const clearConnectTimer = () => {
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = undefined;
    };
    const onAbort = () => {
      const reason = signal?.reason ?? new DOMException("aborted", "AbortError");
      clearConnectTimer();
      req.destroy(reason instanceof Error ? reason : new Error(String(reason)));
      incoming?.destroy(reason instanceof Error ? reason : new Error(String(reason)));
      if (!done) {
        done = true;
        reject(reason);
      }
    };
    const cleanup = () => {
      clearConnectTimer();
      signal?.removeEventListener("abort", onAbort);
    };

    const req = transport.request(
      target,
      {
        method: init.method ?? "GET",
        headers,
        // Fresh connection per request: no pooled socket from an earlier
        // lookup is reused for a name that may resolve differently now.
        agent: false,
        lookup: guardedLookup,
      },
      (res) => {
        clearConnectTimer();
        incoming = res;
        const status = res.statusCode ?? 0;
        const responseHeaders = new Headers();
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
          try {
            responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
          } catch {
            // a header name or value fetch would reject: drop it
          }
        }
        res.once("close", cleanup);
        let response: Response;
        try {
          if (NULL_BODY_STATUSES.has(status)) res.resume();
          response = new Response(
            NULL_BODY_STATUSES.has(status) ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>),
            { status, statusText: res.statusMessage ?? "", headers: responseHeaders },
          );
        } catch (err) {
          res.destroy();
          cleanup();
          done = true;
          reject(fetchFailed(err));
          return;
        }
        done = true;
        resolve(response);
      },
    );

    // The connect timer runs from the start of the request until the socket is
    // connected (and, for https, the handshake finished), so a name that
    // resolves but a host that never answers cannot hang the request.
    req.once("socket", (socket) => {
      if (socket.connecting || secure) socket.once(secure ? "secureConnect" : "connect", clearConnectTimer);
      else clearConnectTimer();
    });
    connectTimer = setTimeout(() => {
      connectTimer = undefined;
      req.destroy(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" }));
    }, connectTimeoutMs);
    connectTimer.unref();

    req.once("error", (err) => {
      cleanup();
      if (!done) {
        done = true;
        // An abort already rejected with the signal's reason; anything else is
        // a transport failure.
        reject(signal?.aborted ? (signal.reason ?? err) : fetchFailed(err));
      }
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    req.end(payload);
  });
}
