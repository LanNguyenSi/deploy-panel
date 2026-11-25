/**
 * The one way the panel reads the body of a relay answer.
 *
 * A relay is a remote host the panel does not control: a compromised or buggy
 * one (or anything standing in for it) could stream an endless body, and
 * `response.json()` / `response.text()` buffer it all before the caller sees a
 * byte, so one answer could exhaust the panel's memory. Every relay body
 * therefore goes through a reader that counts the decoded bytes (the unguarded
 * `fetch` path decompresses gzip, so the wire size says nothing) and, past the
 * cap, cancels the stream (which releases the socket) and fails the read.
 *
 * Caps:
 *  - `RELAY_RESPONSE_MAX_BYTES` for every relay answer. The largest legitimate
 *    answer that is neither logs nor env is the deploy JSON fallback (a handful
 *    of steps of at most 200,000 characters each, JSON escaping up to about
 *    twice that, so about 4 MB); health, system, app list and detail and
 *    self-update answers are kilobytes. 8 MiB leaves a factor of two. A
 *    non-2xx body is read up to this cap too (cut there, never an error) and
 *    kept as `RelayError.body`, which callers parse (the rollback phase); only
 *    the human-facing message is cut shorter, at `RELAY_ERROR_BODY_MAX_BYTES`.
 *  - `RELAY_LOGS_MAX_BYTES` for the two logs routes: the relay sends up to
 *    16 MiB of stdout, JSON escaping of log text can double it, plus headroom.
 *  - `RELAY_ENV_MAX_BYTES` for every app env read: the relay accepts an env
 *    PUT of up to 500 entries of a key of up to 128 characters and a value of
 *    up to 32,768 characters, about 16.46 MB raw, and answers a read with the
 *    same entries; JSON escaping of the values can double that, so 40 MiB.
 *  - `RELAY_ERROR_BODY_MAX_BYTES` for the human-facing message built from a
 *    non-2xx answer (and the 4xx reason of a deploy, which is only displayed).
 *
 * `content-length` is only an early refusal: a header above the cap refuses
 * before any byte is read, a smaller (lying) one never raises the limit.
 */
import { RelayError } from "./relay.js";

export const RELAY_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export const RELAY_LOGS_MAX_BYTES = 40 * 1024 * 1024;
export const RELAY_ENV_MAX_BYTES = 40 * 1024 * 1024;
export const RELAY_ERROR_BODY_MAX_BYTES = 64 * 1024;

export interface RelayReadOptions {
  /** Hard cap on decoded body bytes; defaults to `RELAY_RESPONSE_MAX_BYTES`. */
  maxBytes?: number;
}

export interface RelayTextReadOptions extends RelayReadOptions {
  /** Cut the body at the cap instead of failing the read. */
  truncate?: boolean;
}

/** Default and bounds of the `lines` query of the logs routes. */
const LOG_LINES_DEFAULT = 50;
const LOG_LINES_MAX = 1000;

/**
 * The `lines` query of a logs route as a line count, shared by the panel and
 * the v1 API: absent, empty, `0` and anything that is not a number give 50,
 * a negative or fractional value below 1 gives 1, above 1000 gives 1000.
 */
export function clampLogLines(raw: string | undefined): number {
  return Math.min(Math.max(1, Number(raw) || LOG_LINES_DEFAULT), LOG_LINES_MAX);
}

/** The error of an over-cap body: a 502 naming the cap, never any body content. */
export function relayBodyTooLarge(maxBytes: number): RelayError {
  return new RelayError(`Relay response exceeded the ${maxBytes} byte limit`, 502);
}

function declaredLength(res: Response): number | null {
  const raw = res.headers?.get("content-length");
  if (raw === null || raw === undefined || !/^\d+$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

/** UTF-8 decode that drops a leading BOM, as `response.text()` and `.json()` do. */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function readBounded(res: Response, maxBytes: number, truncate: boolean): Promise<Buffer> {
  if (!truncate) {
    const declared = declaredLength(res);
    if (declared !== null && declared > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw relayBodyTooLarge(maxBytes);
    }
  }
  if (!res.body) return Buffer.alloc(0);

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        // Stop reading and release the socket; a truncating reader keeps
        // what fits under the cap, the others fail.
        await reader.cancel().catch(() => undefined);
        if (!truncate) throw relayBodyTooLarge(maxBytes);
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/**
 * The body as UTF-8 text. Over the cap it throws a `RelayError` (502), unless
 * `truncate` is set: then the text is cut at the cap (a multi-byte character
 * cut in half becomes U+FFFD) and nothing throws for size.
 */
export async function readRelayText(res: Response, options: RelayTextReadOptions = {}): Promise<string> {
  const { maxBytes = RELAY_RESPONSE_MAX_BYTES, truncate = false } = options;
  return decodeUtf8(await readBounded(res, maxBytes, truncate));
}

/**
 * The body parsed as JSON. Over the cap it throws a `RelayError` (502). An
 * empty or unparseable body throws a `SyntaxError`, as `response.json()` did.
 */
export async function readRelayJson<T = unknown>(res: Response, options: RelayReadOptions = {}): Promise<T> {
  const { maxBytes = RELAY_RESPONSE_MAX_BYTES } = options;
  return JSON.parse(decodeUtf8(await readBounded(res, maxBytes, false))) as T;
}
