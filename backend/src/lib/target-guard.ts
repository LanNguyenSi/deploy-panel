import type { Context } from "hono";
import type { ActorContext } from "./ownership.js";
import { assertServerTargetsAllowed } from "../services/probe-guard.js";

/**
 * Non-admin target guard for the routes that store or use a server's SSH
 * host or relay URL. Returns the 400 `private_host` response when the actor
 * is a non-admin and a passed target is private/loopback (literal or
 * resolved); returns null when the route may continue. Admins always pass.
 * Pass only the targets the route actually connects to.
 */
export async function denyPrivateServerTargets(
  c: Context,
  actor: ActorContext,
  targets: { host?: string | null; relayUrl?: string | null },
): Promise<Response | null> {
  const check = await assertServerTargetsAllowed(actor, targets);
  if (check.ok) return null;
  if (check.reason === "unparsable") {
    return c.json(
      {
        error: "invalid_relay_url",
        field: check.field,
        message: "the stored relayUrl is not a valid URL; set a public relay URL",
      },
      400,
    );
  }
  const subject = check.field === "host" ? "host" : "relayUrl host";
  return c.json(
    {
      error: "private_host",
      field: check.field,
      message:
        check.reason === "literal"
          ? `non-admin actors cannot use a private/loopback ${subject}`
          : `${subject} resolves to a private/loopback address`,
    },
    400,
  );
}
