import { describe, expect, it } from "vitest";
import { parseProbeOutput } from "../src/services/probe-vps.js";

// Fixed token for fixture clarity — production code uses a per-call
// random token. The parser requires the token on input; mismatched
// tokens yield an all-empty/free result (the tolerant fallback).
const TOK = "testtok";
const M = (name: string) => `===${name}-${TOK}===`;

describe("parseProbeOutput", () => {
  it("suggests greenfield when port 80 is free and docker has nothing there", () => {
    const stdout =
      M("SS80") + "\n" +
      M("SS443") + "\n" +
      M("DOCKER") + "\n" +
      M("NETWORKS") + "\n" +
      M("ALLNETS") + "\n" +
      "bridge\nhost\nnone\n" +
      M("END") + "\n";
    const r = parseProbeOutput(stdout, TOK);
    expect(r.suggestedMode).toBe("greenfield");
    expect(r.port80).toEqual({ kind: "free" });
    expect(r.port443).toEqual({ kind: "free" });
    expect(r.containers).toEqual([]);
  });

  it("suggests existing-traefik and pre-fills the detected network", () => {
    const stdout =
      M("SS80") + "\n" +
      "LISTEN 0 511  0.0.0.0:80  0.0.0.0:*  users:((\"docker-proxy\",pid=1,fd=4))\n" +
      M("SS443") + "\n" +
      M("DOCKER") + "\n" +
      "traefik-proxy\ttraefik:v3\t0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp\n" +
      "backend\tghcr.io/example/backend:latest\t\n" +
      M("NETWORKS") + "\n" +
      "traefik-proxy\tmy-edge bridge \n" +
      "backend\tmy-edge \n" +
      M("ALLNETS") + "\n" +
      "bridge\nhost\nnone\nmy-edge\n" +
      M("END") + "\n";
    const r = parseProbeOutput(stdout, TOK);
    expect(r.suggestedMode).toBe("existing-traefik");
    expect(r.port80.kind).toBe("traefik");
    if (r.port80.kind === "traefik") {
      expect(r.port80.name).toBe("traefik-proxy");
      expect(r.port80.image).toBe("traefik:v3");
    }
    expect(r.suggestedTraefikNetwork).toBe("my-edge"); // bridge is filtered out as a default network
    expect(r.containers).toHaveLength(2);
    expect(r.networks).toContain("my-edge");
  });

  it("picks the first non-default network alphabetically (deterministic across runs)", () => {
    // Go template map iteration is randomized — the probe parser MUST
    // sort to produce stable suggestions. Order in the probe script's
    // printf output should not affect the chosen network.
    const stdoutReverse =
      M("SS80") + "\n" +
      M("SS443") + "\n" +
      M("DOCKER") + "\n" +
      "traefik\ttraefik:v3\t0.0.0.0:80->80/tcp\n" +
      M("NETWORKS") + "\n" +
      "traefik\tzulu-net alpha-net \n" +
      M("ALLNETS") + "\n" +
      "bridge\nalpha-net\nzulu-net\n" +
      M("END") + "\n";
    const r1 = parseProbeOutput(stdoutReverse, TOK);
    expect(r1.suggestedTraefikNetwork).toBe("alpha-net");

    const stdoutForward =
      M("SS80") + "\n" +
      M("SS443") + "\n" +
      M("DOCKER") + "\n" +
      "traefik\ttraefik:v3\t0.0.0.0:80->80/tcp\n" +
      M("NETWORKS") + "\n" +
      "traefik\talpha-net zulu-net \n" +
      M("ALLNETS") + "\n" +
      M("END") + "\n";
    const r2 = parseProbeOutput(stdoutForward, TOK);
    expect(r2.suggestedTraefikNetwork).toBe("alpha-net");
  });

  it("suggests port-only when a non-Traefik docker container owns :80", () => {
    const stdout =
      M("SS80") + "\n" +
      M("SS443") + "\n" +
      M("DOCKER") + "\n" +
      "memory-weaver-nginx\tnginx:1.25\t0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp\n" +
      M("NETWORKS") + "\n" +
      "memory-weaver-nginx\tbridge \n" +
      M("ALLNETS") + "\n" +
      "bridge\nhost\nnone\n" +
      M("END") + "\n";
    const r = parseProbeOutput(stdout, TOK);
    expect(r.suggestedMode).toBe("port-only");
    expect(r.port80.kind).toBe("docker");
    if (r.port80.kind === "docker") {
      expect(r.port80.name).toBe("memory-weaver-nginx");
      expect(r.port80.image).toBe("nginx:1.25");
    }
    expect(r.suggestedTraefikNetwork).toBeUndefined();
  });

  it("identifies a non-docker process owning :80", () => {
    const stdout =
      M("SS80") + "\n" +
      'LISTEN 0 511  *:80 *:* users:(("nginx",pid=12345,fd=6))\n' +
      M("SS443") + "\n" +
      M("DOCKER") + "\n" +
      M("NETWORKS") + "\n" +
      M("ALLNETS") + "\n" +
      "bridge\n" +
      M("END") + "\n";
    const r = parseProbeOutput(stdout, TOK);
    expect(r.suggestedMode).toBe("port-only");
    expect(r.port80.kind).toBe("proc");
    if (r.port80.kind === "proc") {
      expect(r.port80.process).toBe("nginx");
    }
  });

  it("recognizes traefik under a registry prefix", () => {
    const stdout =
      M("SS80") + "\n" +
      M("SS443") + "\n" +
      M("DOCKER") + "\n" +
      "edge\tregistry.example.com/traefik:v3\t0.0.0.0:80->80/tcp\n" +
      M("NETWORKS") + "\n" +
      "edge\tproxy \n" +
      M("ALLNETS") + "\n" +
      "bridge\nproxy\n" +
      M("END") + "\n";
    const r = parseProbeOutput(stdout, TOK);
    expect(r.suggestedMode).toBe("existing-traefik");
    expect(r.suggestedTraefikNetwork).toBe("proxy");
  });

  it("returns unknown when ss shows something but no parseable process", () => {
    const stdout =
      M("SS80") + "\n" +
      "LISTEN 0 511  *:80 *:*\n" +
      M("SS443") + "\n" +
      M("DOCKER") + "\n" +
      M("NETWORKS") + "\n" +
      M("ALLNETS") + "\n" +
      M("END") + "\n";
    const r = parseProbeOutput(stdout, TOK);
    expect(r.suggestedMode).toBe("port-only");
    expect(r.port80.kind).toBe("unknown");
  });

  it("does not mismatch :80 against a container publishing :8080", () => {
    const stdout =
      M("SS80") + "\n" +
      M("SS443") + "\n" +
      M("DOCKER") + "\n" +
      "webapp\tnginx:1.25\t0.0.0.0:8080->80/tcp\n" +
      M("NETWORKS") + "\n" +
      "webapp\tbridge \n" +
      M("ALLNETS") + "\n" +
      "bridge\n" +
      M("END") + "\n";
    const r = parseProbeOutput(stdout, TOK);
    expect(r.suggestedMode).toBe("greenfield");
    expect(r.port80.kind).toBe("free");
  });

  it("skips malformed docker rows instead of crashing", () => {
    const stdout =
      M("SS80") + "\n" +
      M("SS443") + "\n" +
      M("DOCKER") + "\n" +
      "this-row-has-no-tabs\n" +
      "valid\timg\tports-field\n" +
      M("NETWORKS") + "\n" +
      M("ALLNETS") + "\n" +
      M("END") + "\n";
    const r = parseProbeOutput(stdout, TOK);
    expect(r.containers).toHaveLength(1);
    expect(r.containers[0].name).toBe("valid");
  });

  it("suggests port-only even if port 443 is free when port 80 is taken", () => {
    const stdout =
      M("SS80") + "\n" +
      'LISTEN 0 511  *:80 *:* users:(("nginx",pid=1,fd=6))\n' +
      M("SS443") + "\n" +
      M("DOCKER") + "\n" +
      M("NETWORKS") + "\n" +
      M("ALLNETS") + "\n" +
      M("END") + "\n";
    const r = parseProbeOutput(stdout, TOK);
    expect(r.suggestedMode).toBe("port-only");
    expect(r.port80.kind).toBe("proc");
    expect(r.port443).toEqual({ kind: "free" });
  });

  it("ignores markers tagged with a different token (spoof-resistance)", () => {
    // A hostile/noisy VPS could emit `===SS80-othertok===` lines in a
    // login banner or dotfile. Those must not be interpreted as real
    // markers — the parser only respects markers tagged with OUR
    // per-invocation token.
    const stdout =
      "===SS80-othertok===\n" + // fake marker, ignored
      "something that looks like a listener\n" +
      M("SS80") + "\n" +
      M("SS443") + "\n" +
      M("DOCKER") + "\n" +
      M("NETWORKS") + "\n" +
      M("ALLNETS") + "\n" +
      M("END") + "\n";
    const r = parseProbeOutput(stdout, TOK);
    expect(r.suggestedMode).toBe("greenfield");
    expect(r.port80).toEqual({ kind: "free" });
  });
});
