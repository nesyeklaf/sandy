import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { piCallsOf } from "../usage/pi-calls.js";
import { callLine, createReporter } from "./value-calls.js";

const message = { role: "assistant", model: "claude-opus-5-5", responseId: "r1", timestamp: 1000, content: [{ type: "text", text: "x".repeat(5000) }], usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20, cost: { total: 0.5 } } };

describe("callLine", () => {
  it("drops the content and parses back to the same call as a session file line", () => {
    const line = callLine(message)!;
    expect(line.length).toBeLessThan(400);
    expect(piCallsOf(line, "f")).toEqual([{ key: "r1", createdAt: 1000, model: "claude-opus-5-5", input: 30, cacheRead: 100, output: 5, costUsd: 0.5 }]);
  });
  it("ignores messages without usage and other roles", () => {
    expect(callLine({ role: "user", usage: {} })).toBeNull();
    expect(callLine({ role: "assistant" })).toBeNull();
    expect(callLine(null)).toBeNull();
  });
});

describe("createReporter", () => {
  async function setup(results: Array<{ code: number; stdout: string }>) {
    const dir = await mkdtemp(join(tmpdir(), "vc-"));
    const sent: Array<{ threadId: string; file: string; lines: string[] }> = [];
    const exec = async (_c: string, args: string[]) => {
      sent.push(JSON.parse(await readFile(args[args.indexOf("--input-file") + 1], "utf8")));
      return { stderr: "", ...(results.shift() ?? { code: 0, stdout: '{"known":true,"added":1}' }) };
    };
    return { sent, spoolPath: join(dir, "state", "spool.jsonl"), exec };
  }

  it("sends queued calls of a thread in one batch", async () => {
    const { sent, spoolPath, exec } = await setup([]);
    const r = createReporter({ exec, sandy: "sandy", spoolPath });
    r.add({ threadId: "t", file: "f", line: "a", at: Date.now() });
    r.add({ threadId: "t", file: "f", line: "b", at: Date.now() });
    await r.flush();
    expect(sent).toEqual([{ threadId: "t", file: "f", lines: ["a", "b"] }]);
  });

  it("spools calls sandy did not take, and resends them on the next flush", async () => {
    const { sent, spoolPath, exec } = await setup([{ code: 1, stdout: "" }]);
    const r = createReporter({ exec, sandy: "sandy", spoolPath });
    r.add({ threadId: "t", file: "f", line: "a", at: Date.now() });
    await r.flush();
    expect((await readFile(spoolPath, "utf8")).trim().split("\n")).toHaveLength(1);
    await r.flush();
    expect(sent.map((s) => s.lines)).toEqual([["a"], ["a"]]);
    await expect(readFile(spoolPath, "utf8")).rejects.toThrow();
  });

  it("spools calls of a thread sandy does not know yet", async () => {
    const { spoolPath, exec } = await setup([{ code: 0, stdout: '{"known":false,"added":0}' }]);
    const r = createReporter({ exec, sandy: "sandy", spoolPath });
    r.add({ threadId: "t", file: "f", line: "a", at: Date.now() });
    await r.flush();
    expect(await readFile(spoolPath, "utf8")).toContain('"line":"a"');
  });

  it("drops spooled calls older than a day", async () => {
    const { sent, spoolPath, exec } = await setup([]);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(spoolPath, ".."), { recursive: true });
    await writeFile(spoolPath, JSON.stringify({ threadId: "t", file: "f", line: "old", at: 0 }) + "\n");
    await createReporter({ exec, sandy: "sandy", spoolPath, now: () => 90_000_000 }).flush();
    expect(sent).toEqual([]);
  });
});
