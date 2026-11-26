// Static guard for the `relay-tokens:decrypt` rollback command
// (backend/src/scripts/relay-tokens-decrypt.ts): the command must run inside
// the production image, which installs with `npm ci --omit=dev` (no tsx, no
// TypeScript) and ships only backend/dist. So the npm script must invoke the
// compiled build through `node`, never the TypeScript source through a
// devDependency runner. Needs neither Docker nor a database: it only parses
// backend/package.json and backend/Dockerfile, like dockerfile-healthcheck.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

const pkg = JSON.parse(readFileSync(path.join(repoRoot, "backend/package.json"), "utf8")) as {
  scripts: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function scriptTokens(): string[] {
  const script = pkg.scripts["relay-tokens:decrypt"];
  expect(typeof script, "backend/package.json must define scripts[relay-tokens:decrypt]").toBe("string");
  // The script itself takes no arguments: callers append `--`.
  return script.trim().split(/\s+/);
}

describe("npm run relay-tokens:decrypt (backend/package.json)", () => {
  it("runs the compiled build, not the TypeScript source", () => {
    const [runner, target] = scriptTokens();
    expect(runner, "the runner must be node (the runtime image has no TypeScript toolchain)").toBe("node");
    expect(
      target,
      "the target must be the compiled script under dist/ (the runtime image ships only backend/dist)",
    ).toMatch(/(^|\/)dist\/scripts\/relay-tokens-decrypt\.js$/);
  });

  it("invokes no devDependency, which the runtime image does not install", () => {
    const devDeps = Object.keys(pkg.devDependencies ?? {});
    expect(devDeps.length).toBeGreaterThan(0);
    for (const token of scriptTokens()) {
      expect(devDeps, `the command must not depend on devDependency ${token}`).not.toContain(token);
    }
  });
});

/** Join backslash continuations, then split the Dockerfile at its FROM lines. */
function dockerfileStages(text: string): string[][] {
  const lines = text.replace(/\\[ \t]*\r?\n/g, " ").split("\n");
  const stages: string[][] = [];
  for (const line of lines) {
    if (/^\s*FROM\s/i.test(line)) stages.push([line]);
    else if (stages.length > 0) stages[stages.length - 1].push(line);
  }
  return stages;
}

describe("backend/Dockerfile runtime stage (the image the rollback runs in)", () => {
  const stages = dockerfileStages(readFileSync(path.join(repoRoot, "backend/Dockerfile"), "utf8"));
  const runtime = stages.at(-1)?.join("\n") ?? "";

  it("has a builder stage and a separate runtime stage", () => {
    expect(stages.length, "the Dockerfile must keep a multi-stage build").toBeGreaterThanOrEqual(2);
  });

  it("installs without devDependencies (the reason a tsx-based command cannot run there)", () => {
    expect(runtime).toMatch(/npm\b[^\n]*ci[^\n]*--omit=dev/);
  });

  it("copies the compiled dist the command runs from", () => {
    expect(runtime).toMatch(/^\s*COPY\b.*\bdist\b/m);
  });
});
