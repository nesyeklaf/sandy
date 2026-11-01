import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { ServerContext } from "./server-context";
import { ANCHORS_MIGRATIONS, createServerAnchors } from "./server-anchors";

function setup() {
  const db = new Database(":memory:");
  for (const sql of ANCHORS_MIGRATIONS) db.exec(sql);
  const published: Array<[string, unknown]> = [];
  const ctx = {
    db,
    sandy: {
      realtime: { publish: (channel: string, payload: unknown) => published.push([channel, payload]) },
      sdk: { threads: { get: async () => ({ id: "thr_1", title: "Fix login", projectId: "p", environmentId: "e" }) } },
    },
  } as unknown as ServerContext;
  const run = vi.fn(async (_target: unknown, _title: string, _prompt: string, _timeout?: number) => "  It means X.\n");
  return { handlers: createServerAnchors(ctx, { run }).handlers, published, run };
}

const base = { threadId: "thr_1", messageId: "msg_1", seq: 4 };

describe("anchors storage", () => {
  it("saves a note with a quote and lists it back in message order, then announces the change", async () => {
    const { handlers, published } = setup();
    await handlers.saveAnchor({ ...base, seq: 9, kind: "note", body: "later", quote: "second" });
    const first = await handlers.saveAnchor({
      ...base,
      kind: "note",
      body: "Why this?",
      quote: "the quote",
      offset: 12,
    });
    const { anchors } = await handlers.listAnchors({ threadId: "thr_1" });
    expect(anchors.map((a) => a.body)).toEqual(["Why this?", "later"]);
    expect(first).toMatchObject({ kind: "note", quote: "the quote", offset: 12, author: "user", tags: [] });
    expect(published.at(-1)).toEqual(["anchors", { threadId: "thr_1" }]);
  });

  it("updates in place, keeping the author and creation time", async () => {
    const { handlers } = setup();
    const saved = await handlers.saveAnchor({ ...base, kind: "comment", author: "agent", body: "check" });
    const updated = await handlers.saveAnchor({
      ...base,
      id: saved.id,
      kind: "comment",
      body: "checked",
      author: "user",
    });
    expect(updated).toMatchObject({ id: saved.id, body: "checked", author: "agent", createdAt: saved.createdAt });
  });

  it("normalises tags and refuses a link without a target", async () => {
    const { handlers } = setup();
    const tagged = await handlers.saveAnchor({ ...base, kind: "tag", tags: [" UX ", "ux", "Bug"] });
    expect(tagged.tags).toEqual(["ux", "bug"]);
    await expect(handlers.saveAnchor({ ...base, kind: "link" })).rejects.toThrow("target");
  });

  it("removes links that pointed at a deleted anchor", async () => {
    const { handlers } = setup();
    const target = await handlers.saveAnchor({ ...base, kind: "note", body: "target" });
    await handlers.saveAnchor({ ...base, messageId: "msg_2", kind: "link", targetId: target.id });
    await handlers.deleteAnchor({ id: target.id });
    expect((await handlers.listAnchors({ threadId: "thr_1" })).anchors).toEqual([]);
  });

  it("searches body, quote and tags across sessions, every word must match, wildcards are literal", async () => {
    const { handlers } = setup();
    await handlers.saveAnchor({ ...base, kind: "note", body: "Cache invalidation is hard", quote: "TTL" });
    await handlers.saveAnchor({ ...base, threadId: "thr_2", kind: "tag", tags: ["cache"], body: "" });
    await handlers.saveAnchor({ ...base, kind: "note", body: "100% sure" });
    const search = async (args: Parameters<typeof handlers.searchAnchors>[0]) =>
      (await handlers.searchAnchors(args)).anchors.length;
    expect(await search({ query: "cache" })).toBe(2);
    expect(await search({ query: "cache hard" })).toBe(1);
    expect(await search({ query: "cache", threadId: "thr_2" })).toBe(1);
    expect(await search({ query: "ttl", kind: "note" })).toBe(1);
    expect(await search({ query: "%" })).toBe(1);
    expect(await search({ query: "_" })).toBe(0);
  });

  it("explains a selection through the helper with the session title", async () => {
    const { handlers, run } = setup();
    const answer = await handlers.explainSelection({ threadId: "thr_1", quote: "idempotent retry" });
    expect(answer).toEqual({ text: "It means X." });
    expect(run.mock.calls[0]?.[2]).toContain("idempotent retry");
    expect(run.mock.calls[0]?.[2]).toContain("Session: Fix login");
  });
});
