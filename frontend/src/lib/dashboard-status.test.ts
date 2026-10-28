import { describe, expect, it } from "vitest";
import { summarizeDashboardStatus, type StatusDeploy, type StatusServer } from "./dashboard-status";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const ago = (mins: number) => new Date(NOW - mins * 60000).toISOString();

const server = (id: string, status: string, name = `srv-${id}`): StatusServer => ({ id, name, status });

function deploy(over: Partial<StatusDeploy> & { id: string; status: string }): StatusDeploy {
  return {
    createdAt: ago(5),
    serverId: "s1",
    appId: "a1",
    app: { name: "my-app" },
    server: { name: "srv-s1" },
    ...over,
  };
}

describe("summarizeDashboardStatus", () => {
  it("is empty when there are no servers and nothing runs", () => {
    const s = summarizeDashboardStatus([], []);
    expect(s).toMatchObject({ level: "empty", issues: [], running: [], serversTotal: 0, serversOnline: 0 });
  });

  it("is ok when every server is online and the latest deploy succeeded", () => {
    const s = summarizeDashboardStatus([server("s1", "online"), server("s2", "online")], [deploy({ id: "d1", status: "success" })]);
    expect(s.level).toBe("ok");
    expect(s.serversOnline).toBe(2);
    expect(s.serversTotal).toBe(2);
  });

  it("is ok with servers but no deploys yet", () => {
    expect(summarizeDashboardStatus([server("s1", "online")], []).level).toBe("ok");
  });

  it("flags an offline server and links to it", () => {
    const s = summarizeDashboardStatus([server("s1", "offline", "vps-1"), server("s2", "online")], []);
    expect(s.level).toBe("attention");
    expect(s.issues).toEqual([
      { key: "server-s1", subject: "vps-1", detail: "offline", tone: "offline", href: "/servers/s1" },
    ]);
  });

  it("flags a server without relay as an issue with its own tone", () => {
    const s = summarizeDashboardStatus([server("s1", "no-relay")], []);
    expect(s.level).toBe("attention");
    expect(s.issues[0]).toMatchObject({ detail: "no relay installed", tone: "no-relay" });
  });

  it("does not flag servers in other states (e.g. unknown) but does not call them ok either", () => {
    const s = summarizeDashboardStatus([server("s1", "online"), server("s2", "unknown")], []);
    expect(s.level).toBe("unchecked");
    expect(s.issues).toEqual([]);
    expect(s).toMatchObject({ serversOnline: 1, serversTotal: 2, serversUnchecked: 1 });
  });

  it("an unchecked server does not hide a real issue or a running deploy", () => {
    expect(summarizeDashboardStatus([server("s1", "unknown"), server("s2", "offline")], []).level).toBe("attention");
    expect(summarizeDashboardStatus([server("s1", "unknown")], [deploy({ id: "d1", status: "running" })]).level).toBe("running");
  });

  it("flags a failed latest deploy and links to the deploy list", () => {
    const s = summarizeDashboardStatus([server("s1", "online")], [deploy({ id: "d1", status: "failed" })]);
    expect(s.level).toBe("attention");
    expect(s.issues).toEqual([
      { key: "deploy-d1", subject: "my-app on srv-s1", detail: "last deploy failed", tone: "failed", href: "/deploys" },
    ]);
  });

  it("labels a preflight-blocked failure as blocked, not failed", () => {
    const s = summarizeDashboardStatus([], [deploy({ id: "d1", status: "failed", blocked: true })]);
    expect(s.issues[0].detail).toBe("last deploy blocked (preflight)");
  });

  it("takes the issue tone from the badge mapping: failed is red, interrupted, blocked and rolled back are amber", () => {
    const s = summarizeDashboardStatus(
      [],
      [
        deploy({ id: "d1", status: "interrupted", appId: "a1", app: { name: "one" } }),
        deploy({ id: "d2", status: "rolled_back", appId: "a2", app: { name: "two" } }),
      ],
    );
    expect(s.issues.map((i) => [i.detail, i.tone])).toEqual([
      ["last deploy interrupted", "warning"],
      ["last deploy rolled back", "warning"],
    ]);
  });

  it("tone is failed (red) for a real failure and warning (amber) for a preflight-blocked one", () => {
    const real = summarizeDashboardStatus([], [deploy({ id: "d1", status: "failed" })]);
    const blocked = summarizeDashboardStatus([], [deploy({ id: "d2", status: "failed", blocked: true })]);
    expect(real.issues[0].tone).toBe("failed");
    expect(blocked.issues[0].tone).toBe("warning");
  });

  it("lists a running deploy only when it is the newest of its app on its server", () => {
    const s = summarizeDashboardStatus(
      [server("s1", "online")],
      [deploy({ id: "stale", status: "running", createdAt: ago(60) }), deploy({ id: "done", status: "success", createdAt: ago(5) })],
    );
    expect(s.running).toEqual([]);
    expect(s.level).toBe("ok");
  });

  it("ignores a failure that a later deploy of the same app on the same server superseded", () => {
    const s = summarizeDashboardStatus(
      [server("s1", "online")],
      [deploy({ id: "old", status: "failed", createdAt: ago(60) }), deploy({ id: "new", status: "success", createdAt: ago(5) })],
    );
    expect(s.level).toBe("ok");
    expect(s.issues).toEqual([]);
  });

  it("flags a failure that came after an earlier success, whatever the input order", () => {
    const failedNewest = deploy({ id: "new", status: "failed", createdAt: ago(5) });
    const successOlder = deploy({ id: "old", status: "success", createdAt: ago(60) });
    for (const input of [[failedNewest, successOlder], [successOlder, failedNewest]]) {
      const s = summarizeDashboardStatus([], input);
      expect(s.issues.map((i) => i.key)).toEqual(["deploy-new"]);
    }
  });

  it("keeps same-named apps on same-named servers apart when ids differ", () => {
    const s = summarizeDashboardStatus(
      [],
      [
        deploy({ id: "d1", status: "failed", serverId: "s1", appId: "a1", server: { name: "prod" } }),
        deploy({ id: "d2", status: "success", serverId: "s2", appId: "a2", server: { name: "prod" }, createdAt: ago(1) }),
      ],
    );
    expect(s.issues.map((i) => i.key)).toEqual(["deploy-d1"]);
  });

  it("falls back to app and server names when a deploy carries no ids", () => {
    const noIds = (id: string, status: string, mins: number): StatusDeploy => ({
      id,
      status,
      createdAt: ago(mins),
      app: { name: "my-app" },
      server: { name: "srv-a" },
    });
    const s = summarizeDashboardStatus([], [noIds("old", "failed", 60), noIds("new", "success", 5)]);
    expect(s.issues).toEqual([]);
  });

  it("reports running deploys; level running when nothing else is wrong", () => {
    const s = summarizeDashboardStatus(
      [server("s1", "online")],
      [deploy({ id: "d1", status: "running" }), deploy({ id: "d2", status: "running", appId: "a2", app: { name: "other" } })],
    );
    expect(s.level).toBe("running");
    expect(s.running.map((r) => r.subject).sort()).toEqual(["my-app on srv-s1", "other on srv-s1"]);
  });

  it("attention wins over running, and both lists are kept", () => {
    const s = summarizeDashboardStatus(
      [server("s1", "offline")],
      [deploy({ id: "d1", status: "running" })],
    );
    expect(s.level).toBe("attention");
    expect(s.issues).toHaveLength(1);
    expect(s.running).toHaveLength(1);
  });

  it("running wins over empty when there are no servers", () => {
    expect(summarizeDashboardStatus([], [deploy({ id: "d1", status: "running" })]).level).toBe("running");
  });

  it("a running deploy does not count as a problem and hides an older failure of the same app", () => {
    const s = summarizeDashboardStatus(
      [server("s1", "online")],
      [deploy({ id: "old", status: "failed", createdAt: ago(30) }), deploy({ id: "now", status: "running", createdAt: ago(1) })],
    );
    expect(s.level).toBe("running");
    expect(s.issues).toEqual([]);
  });
});
