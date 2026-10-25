import { describe, expect, it } from "vitest";
import { describeFailures, failuresFromLog, initialBulkEntries, isSettled } from "./bulk-deploy";

describe("failuresFromLog", () => {
  it("returns the failed steps of a steps array, skipping success and skipped", () => {
    const log = JSON.stringify([
      { name: "pull", status: "success", durationMs: 1 },
      { name: "disk", status: "failure", durationMs: 0, message: "disk almost full", output: "disk almost full" },
      { name: "build", status: "skipped", durationMs: 0 },
    ]);
    expect(failuresFromLog(log)).toEqual([{ check: "disk", message: "disk almost full" }]);
  });

  it("prefers a step's message over its output", () => {
    const log = JSON.stringify([{ name: "c", status: "failure", durationMs: 0, message: "m", output: "o" }]);
    expect(failuresFromLog(log)).toEqual([{ check: "c", message: "m" }]);
  });

  it("falls back to output when there is no message", () => {
    const log = JSON.stringify([{ name: "deploy", status: "failure", durationMs: 0, output: "boom" }]);
    expect(failuresFromLog(log)).toEqual([{ check: "deploy", message: "boom" }]);
  });

  it("reads an old-format preflight report log (object with checks)", () => {
    const log = JSON.stringify({ passed: false, checks: [{ name: "disk", passed: false, message: "full" }, { name: "git", passed: true, message: "ok" }] });
    expect(failuresFromLog(log)).toEqual([{ check: "disk", message: "full" }]);
  });

  it("reads an old bare-string log as a failed deploy step", () => {
    expect(failuresFromLog(JSON.stringify("blocked by preflight"))).toEqual([{ check: "deploy", message: "blocked by preflight" }]);
  });

  it("returns nothing for null, empty, unparseable or unrecognised logs", () => {
    expect(failuresFromLog(null)).toEqual([]);
    expect(failuresFromLog("")).toEqual([]);
    expect(failuresFromLog("not json")).toEqual([]);
    expect(failuresFromLog(JSON.stringify({ success: true }))).toEqual([]);
  });
});

describe("initialBulkEntries / isSettled / describeFailures", () => {
  it("running entries are unsettled with no failures; a failed-to-start entry is settled with its error", () => {
    const [running, failed] = initialBulkEntries([
      { app: "a", deployId: "d1", status: "running" },
      { app: "b", deployId: "", status: "failed", error: "bad name" },
    ]);
    expect(isSettled(running)).toBe(false);
    expect(running.failures).toEqual([]);
    expect(isSettled(failed)).toBe(true);
    expect(failed.failures).toEqual([{ check: "deploy", message: "bad name" }]);
  });

  it("a failed-to-start entry without an error text still says something", () => {
    const [failed] = initialBulkEntries([{ app: "b", deployId: "", status: "failed" }]);
    expect(failed.failures).toEqual([{ check: "deploy", message: "could not start" }]);
  });

  it("describeFailures joins checks and omits empty messages", () => {
    expect(describeFailures([{ check: "a", message: "x" }, { check: "b", message: "" }])).toBe("a (x); b");
  });
});
