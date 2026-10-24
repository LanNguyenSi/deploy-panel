import { zValidator } from "@hono/zod-validator";
import type { ZodType } from "zod";

/**
 * Shared zValidator wrapper for JSON bodies.
 *
 * The @hono/zod-validator default failure hook serialises the whole
 * safeParse result with `c.json(result)`. Under zod 3 that wire body was
 * `{ success: false, error: { issues: [...], name: "ZodError" } }` because
 * ZodError exposed `issues` as an enumerable property. Under zod 4 `issues`
 * is non-enumerable, so the default serialisation would silently drop it
 * (only `name` and `message` survive `JSON.stringify`).
 *
 * This hook restores the exact base wire shape: status 400, body
 * `{ success: false, error: { issues: Array<{ code, path, message }>,
 * name: "ZodError" } }`. Each issue is reduced to the `code`, `path` and
 * `message` keys (the fields the panel's clients read); zod 4 issue objects
 * may additionally carry `input`, which must never reach the wire.
 *
 * Pinned by tests/zvalidator-400-body.test.ts (encoded bodies per site).
 */
export function validatedJson<S extends ZodType>(schema: S) {
  return zValidator("json", schema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          success: false as const,
          error: {
            issues: result.error.issues.map(({ code, path, message }) => ({
              code,
              path,
              message,
            })),
            name: "ZodError" as const,
          },
        },
        400,
      );
    }
  });
}
