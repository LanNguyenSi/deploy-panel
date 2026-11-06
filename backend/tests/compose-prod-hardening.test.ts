import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

/**
 * Static guards for the prod compose hardening (docs/configuration.md,
 * "Docker deployment" / "Production checklist"):
 *   1. docker-compose.prod.yml fails closed on POSTGRES_PASSWORD (both the
 *      db service and the backend DATABASE_URL) and on ALLOWED_GITHUB_LOGINS
 *      (empty = "any verified GitHub user", never a prod default). The
 *      dev file keeps its fallbacks so local dev keeps working.
 *   2. Every prod service rotates its logs (json-file 10m x 5) and has a
 *      mem_limit.
 *   3. Only the dev file pins a top-level project `name:`; the prod file
 *      must not have one (its project name comes from the app directory on
 *      the server; a name there would orphan the live pgdata volume).
 *   4. The prod file has ONE public-origin variable, PANEL_PUBLIC_ORIGIN:
 *      BACKEND_URL, CORS_ORIGINS, FRONTEND_URL and the NEXT_PUBLIC_API_URL
 *      build arg all take it with the panel's own domain as the `:-` default
 *      (no `:?`: an existing deployment whose .env predates these variables
 *      keeps booting; a required variable would fail its next deploy at
 *      `compose`). It is deliberately absent from .env.example, so an .env
 *      made from the template cannot override the prod origins, and entries
 *      for the four reused names in such an .env stay ignored by the prod
 *      file. The localhost default for BACKEND_URL is what sent OAuth logins
 *      to GitHub's redirect_uri_mismatch page.
 *   5. The frontend waits for the backend's health check (the same
 *      `condition: service_healthy` gate as the dev file), which needs the
 *      backend healthcheck block the prod file was missing.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

const prodText = readFileSync(path.join(repoRoot, "docker-compose.prod.yml"), "utf8");
const devText = readFileSync(path.join(repoRoot, "docker-compose.yml"), "utf8");

// js-yaml expands YAML anchors/aliases on load, so `logging: *default-logging`
// reads back as the resolved object.
interface ComposeService {
  logging?: { driver?: string; options?: Record<string, string> };
  mem_limit?: string;
  [key: string]: unknown;
}
interface ComposeFile {
  name?: string;
  services: Record<string, ComposeService>;
}

function load(text: string): ComposeFile {
  return yaml.load(text) as ComposeFile;
}

const prod = load(prodText);
const dev = load(devText);
const prodServices = Object.keys(prod.services).sort();

const envExampleText = readFileSync(path.join(repoRoot, ".env.example"), "utf8");

// Keys of .env.example: key=value lines, comments and blank lines ignored.
function envExampleKeys(): string[] {
  const keys: string[] = [];
  for (const line of envExampleText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match) keys.push(match[1]);
  }
  return keys;
}

describe("docker-compose.prod.yml: fail-closed env wiring", () => {
  it("requires POSTGRES_PASSWORD with :? in both the db service and DATABASE_URL", () => {
    const matches = prodText.match(/\$\{POSTGRES_PASSWORD:\?[^}]*\}/g) ?? [];
    expect(matches, "db POSTGRES_PASSWORD and backend DATABASE_URL both use :?").toHaveLength(2);
    expect(prodText).not.toMatch(/POSTGRES_PASSWORD:-/);
    expect(prodText).not.toContain("deploy_panel_prod");
  });

  it("requires ALLOWED_GITHUB_LOGINS with :? (no empty-value fallback)", () => {
    expect(prodText).toMatch(/\$\{ALLOWED_GITHUB_LOGINS:\?[^}]*\}/);
    expect(prodText).not.toMatch(/ALLOWED_GITHUB_LOGINS:-/);
  });

  it("dev keeps its fallbacks: POSTGRES_PASSWORD deploy_panel and empty ALLOWED_GITHUB_LOGINS", () => {
    expect(devText).toContain("${POSTGRES_PASSWORD:-deploy_panel}");
    expect(devText).toMatch(/ALLOWED_GITHUB_LOGINS:-\}/);
  });
});

describe("docker-compose.prod.yml: logging and memory limits", () => {
  it("prod defines exactly the db, backend and frontend services", () => {
    expect(prodServices).toEqual(["backend", "db", "frontend"]);
  });

  it.each(["db", "backend", "frontend"])("%s rotates logs (json-file, 10m x 5)", (name) => {
    expect(prod.services[name].logging).toEqual({
      driver: "json-file",
      options: { "max-size": "10m", "max-file": "5" },
    });
  });

  it.each([
    ["db", "1g"],
    ["backend", "512m"],
    ["frontend", "512m"],
  ])("%s caps memory at %s", (name, limit) => {
    expect(prod.services[name].mem_limit).toBe(limit);
  });
});

describe("compose project names", () => {
  it("prod has NO top-level name (its project name must stay directory-derived)", () => {
    expect(prod.name).toBeUndefined();
  });

  it("dev pins name: deploy-panel-dev so it can never join the prod project", () => {
    expect(dev.name).toBe("deploy-panel-dev");
  });
});

describe("docker-compose.prod.yml: one prod-only public origin variable", () => {
  const DOMAIN = "https://deploy-panel.opentriologue.ai";
  const ORIGIN_REF = `\${PANEL_PUBLIC_ORIGIN:-${DOMAIN}}`;
  const NAMES = ["BACKEND_URL", "CORS_ORIGINS", "FRONTEND_URL", "NEXT_PUBLIC_API_URL"];

  it("the panel-domain default is referenced exactly four times, all via PANEL_PUBLIC_ORIGIN", () => {
    const matches = prodText.match(/\$\{PANEL_PUBLIC_ORIGIN:-https:\/\/deploy-panel\.opentriologue\.ai\}/g);
    expect(matches, "BACKEND_URL, CORS_ORIGINS, FRONTEND_URL and NEXT_PUBLIC_API_URL").toHaveLength(4);
  });

  it.each(NAMES)(
    "%s is filled from PANEL_PUBLIC_ORIGIN, never interpolated with its own default",
    (name) => {
      expect(prodText).not.toMatch(new RegExp(`${name}:-`));
      if (name === "NEXT_PUBLIC_API_URL") {
        const build = prod.services.frontend.build as { args?: Record<string, string> };
        expect(build.args?.NEXT_PUBLIC_API_URL).toBe(ORIGIN_REF);
      } else {
        expect((prod.services.backend.environment as Record<string, string>)[name]).toBe(ORIGIN_REF);
      }
    },
  );

  it("the four assignment lines interpolate only PANEL_PUBLIC_ORIGIN, no .env.example key", () => {
    const originLines = prodText
      .split(/\r?\n/)
      .filter((line) => /^\s*(BACKEND_URL|CORS_ORIGINS|FRONTEND_URL|NEXT_PUBLIC_API_URL):/.test(line));
    expect(originLines.map((line) => line.trim().split(":")[0]).sort()).toEqual([...NAMES].sort());
    // Keys the template defines (comments ignored): none of them may appear
    // as an interpolation on the origin lines, or an .env made from
    // .env.example could override a prod origin.
    const templateKeys = envExampleKeys();
    expect(templateKeys.length).toBeGreaterThan(0);
    for (const line of originLines) {
      const interpolated = [...line.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
      expect([...new Set(interpolated)].sort()).toEqual(["PANEL_PUBLIC_ORIGIN"]);
      for (const name of interpolated) {
        expect(templateKeys, `${name} is a .env.example key`).not.toContain(name);
      }
    }
  });

  it(".env.example defines no PANEL_PUBLIC_ORIGIN (a template .env cannot set it)", () => {
    expect(envExampleKeys()).not.toContain("PANEL_PUBLIC_ORIGIN");
    expect(envExampleText).not.toMatch(/^\s*PANEL_PUBLIC_ORIGIN\s*=/m);
  });
});

describe("docker-compose.prod.yml: frontend start order and backend healthcheck", () => {
  it("frontend waits for the backend to become healthy (not just to start)", () => {
    expect(prod.services.frontend.depends_on).toEqual({ backend: { condition: "service_healthy" } });
  });

  it("backend declares the same healthcheck block as the dev file", () => {
    expect(prod.services.backend.healthcheck).toEqual(dev.services.backend.healthcheck);
    expect(prod.services.backend.healthcheck).toBeDefined();
  });
});
