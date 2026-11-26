import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static guard: the frontend image must not ship devDependencies. The final
 * stage may copy node_modules only from a stage whose `npm ci` carries
 * `--omit=dev`. Needs neither Docker nor a database: it only parses the
 * Dockerfile.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

interface Stage {
  name: string | null;
  lines: string[];
}

/** Join backslash continuations, drop comments, split into stages at FROM. */
function parseStages(text: string): Stage[] {
  const lines = text
    .replace(/\\[ \t]*\r?\n/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  const stages: Stage[] = [];
  for (const line of lines) {
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) stages.push({ name: from[1] ?? null, lines: [] });
    else if (stages.length > 0) stages[stages.length - 1].lines.push(line);
  }
  return stages;
}

/** Stage names the final stage copies node_modules from (`COPY --from=X ... node_modules`). */
function nodeModulesSources(finalStage: Stage): string[] {
  const out: string[] = [];
  for (const line of finalStage.lines) {
    const m = /^COPY\s+--from=(\S+)\s+(.*)$/i.exec(line);
    if (m && /\/node_modules\/?(\s|$)/.test(m[2])) out.push(m[1]);
  }
  return out;
}

function stageInstallsWithoutDev(stage: Stage): boolean {
  // Every `npm ci` command, also one chained with &&, ; or || on the same
  // RUN line, must carry --omit=dev in its own argument list.
  const installs = stage.lines
    .filter((l) => /^RUN\s/.test(l))
    .flatMap((l) => [...l.matchAll(/\bnpm\s+ci\b([^&;|]*)/g)].map((m) => m[1]));
  return (
    installs.length > 0 && installs.every((args) => /\s--omit=dev\b/.test(args))
  );
}

describe("frontend/Dockerfile runtime dependencies", () => {
  const stages = parseStages(
    readFileSync(path.join(repoRoot, "frontend/Dockerfile"), "utf8"),
  );
  const final = stages[stages.length - 1];

  it("copies node_modules into the final stage", () => {
    expect(nodeModulesSources(final).length).toBeGreaterThan(0);
  });

  it("copies node_modules only from stages whose npm ci omits dev dependencies", () => {
    for (const source of nodeModulesSources(final)) {
      const stage = stages.find((s) => s.name === source);
      expect(
        stage,
        `final stage copies from unknown stage ${source}`,
      ).toBeDefined();
      expect(
        stageInstallsWithoutDev(stage!),
        `stage ${source} must run npm ci with --omit=dev`,
      ).toBe(true);
    }
  });

  describe("parser", () => {
    const sample = (copyFrom: string, flag: string) =>
      [
        "FROM node:22-alpine AS deps",
        "RUN npm ci --workspace=frontend",
        "FROM node:22-alpine AS rt",
        `RUN npm ci --workspace=frontend ${flag}`,
        "FROM node:22-alpine",
        `COPY --from=${copyFrom} /app/node_modules node_modules/`,
      ].join("\n");

    const verdict = (text: string) => {
      const st = parseStages(text);
      return nodeModulesSources(st[st.length - 1]).every((s) =>
        stageInstallsWithoutDev(st.find((x) => x.name === s)!),
      );
    };

    it("accepts a copy from an omit-dev stage", () => {
      expect(verdict(sample("rt", "--omit=dev"))).toBe(true);
    });
    it("rejects a copy from the full-install stage", () => {
      expect(verdict(sample("deps", "--omit=dev"))).toBe(false);
    });
    it("rejects an omit-dev stage that lost the flag", () => {
      expect(verdict(sample("rt", ""))).toBe(false);
    });
    it("rejects a second npm ci without the flag chained on the same line", () => {
      expect(
        verdict(sample("rt", "--omit=dev && npm ci --workspace=frontend")),
      ).toBe(false);
    });
    it("ignores a commented-out copy", () => {
      const t =
        sample("rt", "--omit=dev") +
        "\n# COPY --from=deps /app/node_modules node_modules/";
      expect(verdict(t)).toBe(true);
    });
  });
});
