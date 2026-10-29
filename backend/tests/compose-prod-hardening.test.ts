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
