import { auditExtras } from "../src/ui/core-tool-render.js";
import { describe, expect, it } from "vitest";
import {
  createFabricRenderEntry,
  FABRIC_RENDER_ENTRY_MAX_BYTES,
} from "../src/audit/render-entry.js";

const audit = (i: number, size = 10) => ({
  ref: `pi.bash#${i}`,
  tool: "bash",
  provider: "pi",
  success: true,
  args: { cmd: "x".repeat(size), nested: { a: 1 } as unknown as string },
  result: { output: "y".repeat(size) },
  startedAt: i,
  endedAt: i + 1,
});

describe("createFabricRenderEntry", () => {
  it("keeps call identity, shortens strings and flattens nested values", () => {
    const entry = createFabricRenderEntry({
      toolCallId: "call_1",
      display: { name: "Build" },
      details: { success: true, phases: ["run"], audits: [audit(1, 5000)] },
    });
    expect(entry).toMatchObject({ schemaVersion: 1, toolCallId: "call_1", display: { name: "Build" }, success: true, auditCount: 1, truncated: false });
    expect(entry.audits[0]!.args!.cmd!.length).toBe(200);
    expect(entry.audits[0]!.args!.nested).toBe('{"a":1}');
    expect(entry.audits[0]!.result!.length).toBe(600);
  });

  it("stays under the size limit by dropping results, then the oldest audits", () => {
    const audits = Array.from({ length: 3000 }, (_, i) => audit(i));
    const entry = createFabricRenderEntry({ toolCallId: "call_2", details: { success: false, error: "boom", phases: [], audits } });
    expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThanOrEqual(FABRIC_RENDER_ENTRY_MAX_BYTES);
    expect(entry.truncated).toBe(true);
    expect(entry.auditCount).toBe(3000);
    expect(entry.audits.at(-1)!.ref).toBe("pi.bash#2999");
    expect(entry.audits[0]!.result).toBeUndefined();
  });

  it("carries a bounded diff for edits and drops diffs before results when too large", () => {
    const extrasFor = (a: { ref: string }) => (a.ref === "pi.edit#1" ? { diff: "@@ 1 @@\n-1 old\n+1 new" } : {});
    const edit = { ...audit(1, 10), ref: "pi.edit#1", tool: "edit" };
    const entry = createFabricRenderEntry({ toolCallId: "c", details: { success: true, phases: [], audits: [edit, audit(2, 10)] }, extrasFor });
    expect(entry.audits[0]!.diff).toBe("@@ 1 @@\n-1 old\n+1 new");
    expect(entry.audits[1]!.diff).toBeUndefined();
    const big = createFabricRenderEntry({ toolCallId: "c", details: { success: true, phases: [], audits: [edit] }, extrasFor: () => ({ diff: "x".repeat(50_000) }) });
    expect(big.audits[0]!.diff!.length).toBe(8000);
    const tight = createFabricRenderEntry({ toolCallId: "c", details: { success: true, phases: [], audits: [edit] }, extrasFor: () => ({ diff: "x".repeat(50_000) }), maxBytes: 3000 });
    expect(tight.audits[0]!.diff).toBeUndefined();
    expect(tight.audits[0]!.result).toBeDefined();
  });

  it("carries bash command, output tail and exit code, and new-file content", () => {
    const extrasFor = (a: { ref: string }) =>
      a.ref === "pi.bash#1"
        ? { command: "ls\nfoo", output: "a\nb", exitCode: 2 }
        : a.ref === "pi.write#2" ? { content: "x".repeat(20_000) } : {};
    const audits = [{ ...audit(1, 10), tool: "bash" }, { ...audit(2, 10), ref: "pi.write#2", tool: "write" }];
    const entry = createFabricRenderEntry({ toolCallId: "c", details: { success: true, phases: [], audits }, extrasFor });
    expect(entry.audits[0]).toMatchObject({ command: "ls\nfoo", output: "a\nb", exitCode: 2 });
    expect(entry.audits[1]!.content!.length).toBe(8000);
  });

  it("strips the bash footer lines from the output tail", () => {
    const extras = auditExtras({ ref: "pi.bash", tool: "bash", success: true, args: { command: "ls" }, result: { output: "a\nb\n\n[exit code: 2]\n[task bash-1]", details: { exit_code: 2 } } } as never);
    expect(extras).toMatchObject({ output: "a\nb", exitCode: 2 });
  });

  it("carries read content with its full line count", () => {
    const read = { ...audit(1, 10), ref: "pi.read#1", tool: "read" };
    const entry = createFabricRenderEntry({ toolCallId: "c", details: { success: true, phases: [], audits: [read] }, extrasFor: () => ({ content: "x\n".repeat(20_000), lines: 20_000 }) });
    expect(entry.audits[0]!.content!.length).toBe(8000);
    expect(entry.audits[0]!.lines).toBe(20_000);
  });

  it("extracts read content without the continuation notice and skips images", () => {
    const read = (output: string) => auditExtras({ ref: "pi.read", tool: "read", success: true, args: { path: "a.ts" }, result: { output } } as never);
    expect(read("a\nb\n")).toEqual({ content: "a\nb\n", lines: 2 });
    expect(read("Read image file [image/png]")).toEqual({});
  });
});
