import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { ServerContext } from "./server-context";
import { createServerTopics, TOPICS_MIGRATIONS } from "./server-topics";
import { measureText, topicStats } from "./topic-messages";

type Row = { seq: number; type: string; data: unknown };

const user = (seq: number, text: string): Row => ({
  seq,
  type: "client/turn/requested",
  data: { initiator: "user", input: [{ type: "text", text }] },
});
const agent = (seq: number, text: string): Row => ({
  seq,
  type: "item/completed",
  data: { item: { type: "agentMessage", text } },
});

function setup(rows: Row[]) {
  const db = new Database(":memory:");
  for (const sql of TOPICS_MIGRATIONS) db.exec(sql);
  const published: string[] = [];
  const calls: Array<Record<string, unknown>> = [];
  const ctx = {
    db,
    sandy: {
      realtime: { publish: (channel: string) => published.push(channel) },
      sdk: {
        threads: {
          get: async () => ({ id: "t", projectId: "p", environmentId: "e" }),
          events: {
            list: async (args: { afterSeq: string; limit: string }) => {
              calls.push(args);
              return rows.filter((row) => row.seq > Number(args.afterSeq)).slice(0, Number(args.limit));
            },
          },
        },
      },
    },
  } as unknown as ServerContext;
  const runs: Array<{ title: string; prompt: string; timeoutMs?: number }> = [];
  let answer: string | null = '{"topics":[{"from":1,"to":1,"title":"Tagging","tags":["ux"]}]}';
  const helper = {
    run: async (_target: unknown, title: string, prompt: string, timeoutMs?: number) => {
      runs.push({ title, prompt, timeoutMs });
      return answer;
    },
  };
  return {
    handlers: createServerTopics(ctx, helper).handlers,
    published,
    calls,
    rows,
    runs,
    answer: (value: string | null) => {
      answer = value;
    },
  };
}

describe("topic messages", () => {
  it("keeps user prompts and agent messages with their length", async () => {
    const { handlers } = setup([
      user(1, "hello\nworld"),
      { seq: 2, type: "item/completed", data: { item: { type: "commandExecution" } } },
      agent(3, "one two three four"),
    ]);
    const { messages } = await handlers.getThreadMessages({ threadId: "t" });
    expect(messages.map((m) => [m.seq, m.role, m.lines, m.words])).toEqual([
      [1, "user", 2, 2],
      [3, "assistant", 1, 4],
    ]);
  });

  it("never asks for more than 100 events and pages through all of them", async () => {
    const { handlers, calls } = setup(Array.from({ length: 250 }, (_, i) => user(i + 1, "x")));
    const { messages } = await handlers.getThreadMessages({ threadId: "t" });
    expect(messages).toHaveLength(250);
    expect(calls.every((c) => Number(c.limit) <= 100)).toBe(true);
  });

  it("reads only new events on the second call", async () => {
    const { handlers, rows, calls } = setup([user(1, "a")]);
    await handlers.getThreadMessages({ threadId: "t" });
    rows.push(agent(2, "b"));
    const { messages } = await handlers.getThreadMessages({ threadId: "t" });
    expect(messages).toHaveLength(2);
    expect(calls.at(-1)?.afterSeq).toBe("1");
  });

  it("sums a range", () => {
    const messages = [user(1, "a b"), agent(2, "c d e"), user(9, "x")].map((row, i) => ({
      seq: row.seq,
      role: i === 1 ? ("assistant" as const) : ("user" as const),
      preview: "",
      ...measureText(i === 1 ? "c d e" : i === 0 ? "a b" : "x"),
    }));
    expect(topicStats(messages, 1, 2)).toEqual({ user: 1, assistant: 1, lines: 2, words: 5, tokens: 3 });
  });
});

describe("topic segments and tags", () => {
  it("saves, reorders bounds, tags and deletes a segment", async () => {
    const { handlers, published } = setup([]);
    const saved = await handlers.saveTopic({ threadId: "t", fromSeq: 9, toSeq: 3, title: "Tagging" });
    expect([saved.fromSeq, saved.toSeq]).toEqual([3, 9]);
    await handlers.setTopicTags({ kind: "segment", ownerId: saved.id, tags: ["UI", "ui", " sidebar "] });
    await handlers.setTopicTags({ kind: "thread", ownerId: "t", tags: ["plugin"] });
    const listed = await handlers.listTopics({ threadId: "t" });
    expect(listed.segments[0]?.tags).toEqual(["sidebar", "ui"]);
    expect(listed.threadTags).toEqual(["plugin"]);
    const all = await handlers.listAllTags();
    expect(all.threadTags).toEqual({ t: ["plugin"] });
    await handlers.saveTopic({ threadId: "t", id: saved.id, fromSeq: 3, toSeq: 12, title: "Tagging 2" });
    expect((await handlers.listTopics({ threadId: "t" })).segments[0]).toMatchObject({ toSeq: 12, title: "Tagging 2" });
    await handlers.deleteTopic({ id: saved.id });
    expect((await handlers.listTopics({ threadId: "t" })).segments).toEqual([]);
    expect((await handlers.listAllTags()).segments).toEqual([]);
    expect(published).toContain("topics");
  });
});

describe("topic suggestions", () => {
  it("asks the helper about the turns and returns validated, unsaved suggestions", async () => {
    const { handlers, runs } = setup([user(1, "add tagging"), agent(2, "done"), user(3, "build tree")]);
    const { suggestions } = await handlers.suggestTopics({ threadId: "t" });
    expect(suggestions).toEqual([{ fromSeq: 1, toSeq: 2, title: "Tagging", tags: ["ux"] }]);
    expect(runs[0]!.prompt).toContain("1. user: add tagging");
    expect(runs[0]!.timeoutMs).toBe(120_000);
    expect((await handlers.listTopics({ threadId: "t" })).segments).toEqual([]);
  });

  it("explains an empty session and a bad answer", async () => {
    const empty = setup([]);
    await expect(empty.handlers.suggestTopics({ threadId: "t" })).rejects.toThrow("no messages");
    const bad = setup([user(1, "hi")]);
    bad.answer("not json");
    await expect(bad.handlers.suggestTopics({ threadId: "t" })).rejects.toThrow("invalid answer");
  });
});
