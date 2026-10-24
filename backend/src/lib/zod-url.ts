import { z } from "zod";

/**
 * A string schema that accepts exactly what the zod 3 `.url()` check accepted
 * and returns the input unchanged.
 *
 * zod 3 validated URLs with `new URL(value)` (a value is a URL exactly when the
 * WHATWG parser does not throw) and passed the original string through, so a
 * stored URL was byte-for-byte what the caller sent. zod 4's `z.url()` keeps the
 * same accept set (the same `new URL()` success) but returns a cleaned value:
 * leading/trailing whitespace is trimmed and every ASCII tab/newline is removed
 * (" http://x" parses to "http://x", "http://x\t/y" to "http://x/y"). The panel
 * stores these values verbatim (relay URLs, the OAuth callback base), so it must
 * keep the zod 3 output.
 *
 * This reuses the zod 3 rule (`new URL()` throwing or not) for the accept set
 * and adds the same `invalid_format` / "Invalid URL" issue zod 4 emits on
 * failure, so rejecting inputs keeps the current shape while accepted inputs
 * keep the raw bytes.
 */
export function urlV3() {
  return z.string().superRefine((value, ctx) => {
    try {
      new URL(value);
    } catch {
      ctx.addIssue({ code: "invalid_format", format: "url", message: "Invalid URL" });
    }
  });
}
