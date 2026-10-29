#!/usr/bin/env bash
# Guards the shape of .relay.yml the way agent-relay's loader reads it: every
# pre_update and post_update entry must be a YAML string, and no pre_update
# entry may build images. agent-relay validates the hook lists with
# z.array(z.string()).default([]): a plain scalar with a ": " inside (for
# example in an echo text) parses as a mapping and is rejected
# ("post_update.0: Expected string, received object"), and a key left present
# with no items parses as null and is rejected too, so either mistake fails
# EVERY deploy and rolls back before any step runs. agent-relay also runs
# pre_update against the pre-pull tree, so an image build there would build
# the OLD code (this repo's pre_update used to run a no-cache compose build,
# 47s of wasted time on every deploy; the deploy system builds the pulled
# commit itself after the pull, so the key is gone). This script keeps it
# gone and keeps any re-added hook list valid.
# Needs js-yaml from the root node_modules (npm ci at the repository root).
#   bash scripts/relay-config.test.sh [path to .relay.yml]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${1:-$ROOT/.relay.yml}"

cd "$ROOT"
node - "$CONFIG" <<'NODE'
const fs = require("fs");
const yaml = require("js-yaml");
const file = process.argv[2];
const doc = yaml.load(fs.readFileSync(file, "utf8"));
// The parse guard comes first, so an empty or misread file fails cleanly here
// instead of throwing in the hook loop below: the config must be a mapping with
// a health path and a compose file. A config without hook entries is valid (the
// schema step runs in the backend entrypoint, not in a hook).
let bad = 0;
let total = 0;
if (doc === null || typeof doc !== "object" || typeof doc.health !== "string" || typeof doc.compose_file !== "string") {
  console.log("FAIL: .relay.yml did not parse as a mapping with string health and compose_file");
  process.exit(1);
}
for (const key of ["pre_update", "post_update"]) {
  const list = doc[key];
  if (list === undefined) continue;
  if (!Array.isArray(list)) {
    console.log(`FAIL: ${key} is not a list`);
    bad++;
    continue;
  }
  list.forEach((entry, i) => {
    total++;
    if (typeof entry === "string") {
      console.log(`PASS: ${key}.${i} is a string`);
    } else {
      console.log(`FAIL: ${key}.${i} is ${JSON.stringify(entry)}, not a string`);
      bad++;
    }
  });
}
if (total === 0) {
  console.log("PASS: no pre_update or post_update entries declared");
}
// agent-relay runs pre_update against the pre-pull tree, so an image build
// there builds the OLD code (wasted time, and a likely containerd snapshot
// error trigger); the deploy system builds the pulled commit itself after the
// pull. The check is deliberately position-free: within one command segment
// (split at newlines, ;, &, | and their doubled forms) it flags any docker or
// docker-compose token that is followed anywhere by a build, bake or --build
// token, after stripping quotes, parentheses, backticks, `$(` and binary
// paths. Global options, wrappers like `bash -c '...'` and command
// substitution are therefore covered. It over-matches on purpose (for example
// `docker compose run web npm run build` is flagged); such an entry fails
// loudly and can be reworded. A build behind a variable or inside a called
// script is not visible here.
const BUILD_WORDS = new Set(["build", "bake", "--build"]);
function buildsImages(entry) {
  const joined = entry.replace(/\\\r?\n/g, " ");
  return joined.split(/[\n;&|]+/).some((segment) => {
    const tok = segment
      .replace(/[`'"()]|\$\(/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => t.split("/").pop());
    const start = tok.findIndex((t) => t === "docker" || t === "docker-compose");
    return start !== -1 && tok.slice(start + 1).some((t) => BUILD_WORDS.has(t) || t.startsWith("--build="));
  });
}
// Self-check of the predicate, so a weakened matcher fails this script.
const mustFlag = [
  "docker compose build --no-cache",
  "docker-compose build",
  "docker compose -f docker-compose.yml build",
  "docker compose --profile x build",
  "docker  compose\tbuild",
  "docker compose up -d --build",
  "docker compose up -d --build=true",
  "docker buildx bake",
  "docker buildx build .",
  "docker build .",
  "docker image build .",
  "cd x && docker compose build",
  "docker --context x compose build",
  "docker -H tcp://h compose build",
  "docker builder build .",
  "/usr/bin/docker compose build",
  "bash -c 'docker compose build'",
  "echo $(docker compose build)",
  "(docker compose build)",
  "docker compose build&",
  "docker compose 'build'",
  "docker \\\ncompose build",
];
const mustPass = [
  "docker compose pull",
  "docker compose -f docker-compose.yml up -d",
  "echo rebuild later",
  "cp .env.example .env",
  "docker compose pull && echo build skipped",
  "npm run build",
];
for (const s of mustFlag) {
  if (!buildsImages(s)) {
    console.log(`FAIL: predicate misses a build: ${JSON.stringify(s)}`);
    bad++;
  }
}
for (const s of mustPass) {
  if (buildsImages(s)) {
    console.log(`FAIL: predicate flags a non-build: ${JSON.stringify(s)}`);
    bad++;
  }
}
if (Array.isArray(doc.pre_update)) {
  doc.pre_update.forEach((entry, i) => {
    if (typeof entry !== "string") return;
    if (buildsImages(entry)) {
      console.log(`FAIL: pre_update.${i} builds images (pre_update runs pre-pull, the build would use the old tree)`);
      bad++;
    } else {
      console.log(`PASS: pre_update.${i} builds no images`);
    }
  });
}
console.log(`checked=${total} failed=${bad}`);
process.exit(bad === 0 ? 0 : 1);
NODE
