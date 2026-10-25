import { readFileSync } from "node:fs";
import { Hono } from "hono";

// Relative to this module file: src/routes/ and dist/routes/ both sit two
// levels below backend/, and backend/package.json is next to dist/ in the
// runtime stage of backend/Dockerfile, so one path serves tests and the image.
const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

export const healthRouter = new Hono();

healthRouter.get("/", (c) => c.json({ status: "ok", version }));
