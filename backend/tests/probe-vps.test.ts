import { describe, expect, it } from "vitest";
import { parseProbeOutput } from "../src/services/probe-vps.js";

describe("parseProbeOutput", () => {
  it("suggests greenfield when port 80 is free and docker has nothing there", () => {
    const stdout =
      "===SS80===\n" +
      "===SS443===\n" +
      "===DOCKER===\n" +
      "===NETWORKS===\n" +
      "===ALLNETS===\n" +
      "bridge\nhost\nnone\n" +
      "===END===\n";
    const r = parseProbeOutput(stdout);
    expect(r.suggestedMode).toBe("greenfield");
    expect(r.port80).toEqual({ kind: "free" });
    expect(r.port443).toEqual({ kind: "free" });
    expect(r.containers).toEqual([]);
  });

  it("suggests existing-traefik and pre-fills the detected network", () => {
    const stdout =
      "===SS80===\n" +
      "LISTEN 0 511  0.0.0.0:80  0.0.0.0:*  users:((\"docker-proxy\",pid=1,fd=4))\n" +
      "===SS443===\n" +
      "===DOCKER===\n" +
      "traefik-proxy|traefik:v3|0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp\n" +
      "backend|ghcr.io/example/backend:latest|\n" +
      "===NETWORKS===\n" +
      "traefik-proxy|my-edge bridge \n" +
      "backend|my-edge \n" +
      "===ALLNETS===\n" +
      "bridge\nhost\nnone\nmy-edge\n" +
      "===END===\n";
    const r = parseProbeOutput(stdout);
    expect(r.suggestedMode).toBe("existing-traefik");
    expect(r.port80.kind).toBe("traefik");
    if (r.port80.kind === "traefik") {
      expect(r.port80.name).toBe("traefik-proxy");
      expect(r.port80.image).toBe("traefik:v3");
    }
    expect(r.suggestedTraefikNetwork).toBe("my-edge");
    expect(r.containers).toHaveLength(2);
    expect(r.networks).toContain("my-edge");
  });

  it("suggests port-only when a non-Traefik docker container owns :80", () => {
    const stdout =
      "===SS80===\n" +
      "===SS443===\n" +
      "===DOCKER===\n" +
      "memory-weaver-nginx|nginx:1.25|0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp\n" +
      "===NETWORKS===\n" +
      "memory-weaver-nginx|bridge \n" +
      "===ALLNETS===\n" +
      "bridge\nhost\nnone\n" +
      "===END===\n";
    const r = parseProbeOutput(stdout);
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
      "===SS80===\n" +
      'LISTEN 0 511  *:80 *:* users:(("nginx",pid=12345,fd=6))\n' +
      "===SS443===\n" +
      "===DOCKER===\n" +
      "===NETWORKS===\n" +
      "===ALLNETS===\n" +
      "bridge\n" +
      "===END===\n";
    const r = parseProbeOutput(stdout);
    expect(r.suggestedMode).toBe("port-only");
    expect(r.port80.kind).toBe("proc");
    if (r.port80.kind === "proc") {
      expect(r.port80.process).toBe("nginx");
    }
  });

  it("recognizes traefik under a registry prefix", () => {
    // Matches install.sh's is_traefik_image: `*/traefik:*`, `*/traefik`.
    const stdout =
      "===SS80===\n" +
      "===SS443===\n" +
      "===DOCKER===\n" +
      "edge|registry.example.com/traefik:v3|0.0.0.0:80->80/tcp\n" +
      "===NETWORKS===\n" +
      "edge|proxy \n" +
      "===ALLNETS===\n" +
      "bridge\nproxy\n" +
      "===END===\n";
    const r = parseProbeOutput(stdout);
    expect(r.suggestedMode).toBe("existing-traefik");
    expect(r.suggestedTraefikNetwork).toBe("proxy");
  });

  it("returns unknown when ss shows something but no parseable process", () => {
    const stdout =
      "===SS80===\n" +
      "LISTEN 0 511  *:80 *:*\n" + // no users:(…) suffix (e.g. non-root probe)
      "===SS443===\n" +
      "===DOCKER===\n" +
      "===NETWORKS===\n" +
      "===ALLNETS===\n" +
      "===END===\n";
    const r = parseProbeOutput(stdout);
    // Wizard still needs a concrete suggestion even for unknown — picks
    // port-only so install.sh's refuse branch doesn't fire on the VPS.
    expect(r.suggestedMode).toBe("port-only");
    expect(r.port80.kind).toBe("unknown");
  });

  it("does not mismatch :80 against a container publishing :8080", () => {
    // 0.0.0.0:8080->80/tcp means host port 8080 forwards to container
    // port 80 — that does NOT conflict with us wanting host :80.
    const stdout =
      "===SS80===\n" +
      "===SS443===\n" +
      "===DOCKER===\n" +
      "webapp|nginx:1.25|0.0.0.0:8080->80/tcp\n" +
      "===NETWORKS===\n" +
      "webapp|bridge \n" +
      "===ALLNETS===\n" +
      "bridge\n" +
      "===END===\n";
    const r = parseProbeOutput(stdout);
    expect(r.suggestedMode).toBe("greenfield");
    expect(r.port80.kind).toBe("free");
  });

  it("skips malformed docker rows instead of crashing", () => {
    const stdout =
      "===SS80===\n" +
      "===SS443===\n" +
      "===DOCKER===\n" +
      "this-row-has-no-pipes\n" +
      "valid|img|ports-field\n" +
      "===NETWORKS===\n" +
      "===ALLNETS===\n" +
      "===END===\n";
    const r = parseProbeOutput(stdout);
    expect(r.containers).toHaveLength(1);
    expect(r.containers[0].name).toBe("valid");
  });

  it("suggests port-only even if port 443 is free when port 80 is taken", () => {
    // Only port 80 drives the decision matrix today; 443 is reported
    // for UI context. If the host has nothing on :443 but nginx on :80,
    // still suggest port-only.
    const stdout =
      "===SS80===\n" +
      'LISTEN 0 511  *:80 *:* users:(("nginx",pid=1,fd=6))\n' +
      "===SS443===\n" +
      "===DOCKER===\n" +
      "===NETWORKS===\n" +
      "===ALLNETS===\n" +
      "===END===\n";
    const r = parseProbeOutput(stdout);
    expect(r.suggestedMode).toBe("port-only");
    expect(r.port80.kind).toBe("proc");
    expect(r.port443).toEqual({ kind: "free" });
  });
});
