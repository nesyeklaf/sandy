import { describe, expect, it } from "vitest";
import { approvalMessage, jobFinished, jobLine, readApproval, readHosts, readJob, readRunbook, runbookMessage } from "./ops";

describe("readApproval", () => {
  it("orders deletes and outside writes first and counts the ones with no way back", () => {
    const read = readApproval([
      { kind: "write", target: "a.txt" },
      { kind: "remove", target: "old/" },
      { kind: "post", target: "MR !4 comment", revert: "delete the comment" },
      "plain.txt",
    ]);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.changes.map((change) => [change.kind, change.target])).toEqual([
      ["delete", "old/"],
      ["external", "MR !4 comment"],
      ["write", "a.txt"],
      ["write", "plain.txt"],
    ]);
    expect(read.value.irreversible).toBe(1);
  });

  it("rejects what isn't a list of changes", () => {
    expect(readApproval({ target: "x" }).ok).toBe(false);
    expect(readApproval([{ kind: "write" }]).ok).toBe(false);
  });

  it("says in words what was approved or declined", () => {
    const read = readApproval([{ kind: "delete", target: "tmp/" }]);
    if (!read.ok) throw new Error(read.error);
    expect(approvalMessage(read.value, true, null)).toBe("Approved: 1 change.\n- Deletes: tmp/");
    expect(approvalMessage(read.value, false, "Cleanup")).toBe("Declined: Cleanup. Don't make these changes.");
  });
});

describe("readHosts", () => {
  it("maps status words, counts them and groups the sources hosts are listed in", () => {
    const read = readHosts([
      { host: "a", status: "success", sources: ["AWX", "CMDB"] },
      { host: "b", status: "timeout", sources: "CMDB, AWX" },
      { host: "c", status: "weird", source: "CMDB" },
      { name: "d" },
    ]);
    if (!read.ok) throw new Error(read.error);
    expect(read.value.hosts.map((host) => host.status)).toEqual(["ok", "unreachable", "failed", "ok"]);
    expect(read.value.counts).toEqual({ failed: 1, unreachable: 1, changed: 0, ok: 2, skipped: 0 });
    expect(read.value.combos).toEqual([
      { sources: ["AWX", "CMDB"], count: 2 },
      { sources: ["CMDB"], count: 1 },
    ]);
  });
});

describe("readRunbook", () => {
  it("reads steps and reports every step once one is marked", () => {
    const read = readRunbook([{ title: "Restart", command: "systemctl restart app" }, "Check"]);
    if (!read.ok) throw new Error(read.error);
    expect(read.value[1]).toEqual({ title: "Check", command: null, expected: null, detail: null });
    expect(runbookMessage(read.value, {})).toBe("");
    expect(runbookMessage(read.value, { 1: "failed" })).toBe("Runbook:\n1. Restart: not marked\n2. Check: failed");
  });
});

describe("readJob", () => {
  it("reads a JSON status with counts", () => {
    const job = readJob(JSON.stringify({ status: "running", phase: "import", done: 25, total: 100, eta: "3 min" }));
    expect(job.progress).toBe(0.25);
    expect(jobFinished(job)).toBe(false);
    expect(jobLine(job)).toBe("Running · import · 25 of 100 · about 3 min left");
  });

  it("takes a percentage progress as a share", () => {
    expect(readJob('{"progress": 40}').progress).toBe(0.4);
    expect(readJob('{"progress": 0.4}').progress).toBe(0.4);
  });

  it("finishes a log on its exit line and keeps the tail", () => {
    const done = readJob("step 1\nstep 2 3/4\nexit 0\n");
    expect(done.state).toBe("done");
    expect(done.tail).toEqual(["step 1", "step 2 3/4"]);
    expect(done.progress).toBe(0.75);
    const failed = readJob("building\nexit: 2");
    expect(failed.state).toBe("failed");
    expect(jobLine(failed)).toBe("Failed (exit 2)");
  });

  it("treats a JSON file caught mid-write as a running log", () => {
    expect(readJob('{"status": "runn').state).toBe("running");
    expect(readJob("").state).toBe("unknown");
  });
});
