import { describe, expect, it } from "vitest";
import { spaceChannel } from "./realtime-channels";
import { IDEAS_PER_SPACE_MAX, SCRATCHPAD_BYTES_MAX } from "./space-coordination-contract";
import { loadSpacePlugin, spaceThread, type SpaceWorld } from "./test-space-server";

function world(): SpaceWorld {
  return {
    sections: [
      { id: "space_a", name: "Alpha" },
      { id: "space_b", name: "Beta" },
    ],
    threads: [
      spaceThread("thr_o1", "space_a"),
      spaceThread("thr_o2", "space_a"),
      spaceThread("thr_m1", "space_a"),
      spaceThread("thr_b1", "space_b"),
      spaceThread("thr_free", null),
    ],
  };
}

type Harness = Awaited<ReturnType<typeof loadSpacePlugin>>;
const call = (harness: Harness, method: string, input: unknown) => harness.behavior.callRpc(method, input as never);

describe("orchestrators", () => {
  it("lets several members of a Space be orchestrators", async () => {
    const harness = await loadSpacePlugin(world());
    await call(harness, "setOrchestrator", { threadId: "thr_o1", orchestrator: true });
    await call(harness, "setOrchestrator", { threadId: "thr_o2", orchestrator: true });
    const context = (await call(harness, "getSpaceCoordination", { spaceId: "space_a" })) as {
      orchestratorThreadIds: string[];
    };
    expect(context.orchestratorThreadIds).toEqual(["thr_o1", "thr_o2"]);
  });

  it("refuses a session without a Space and names the missing Space", async () => {
    const harness = await loadSpacePlugin(world());
    await expect(call(harness, "setOrchestrator", { threadId: "thr_free", orchestrator: true })).rejects.toThrow(
      /not in a Space/,
    );
  });

  it("clears the role on the next read once the session left the Space", async () => {
    const state = world();
    const harness = await loadSpacePlugin(state);
    await call(harness, "setOrchestrator", { threadId: "thr_o1", orchestrator: true });
    state.threads = state.threads.map((thread) =>
      thread.id === "thr_o1" ? { ...thread, sectionId: "space_b" } : thread,
    );
    const context = (await call(harness, "getSpaceCoordination", { spaceId: "space_a" })) as {
      orchestratorThreadIds: string[];
    };
    expect(context.orchestratorThreadIds).toEqual([]);
    expect(((await call(harness, "listOrchestrators", {})) as { threadIds: string[] }).threadIds).toEqual([]);
  });

  it("drops the role and the mode of a deleted session", async () => {
    const harness = await loadSpacePlugin(world());
    await call(harness, "setOrchestrator", { threadId: "thr_o1", orchestrator: true });
    await call(harness, "setMemberMode", { threadId: "thr_o1", mode: "managed" });
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: spaceThread("thr_o1", "space_a") });
    expect(((await call(harness, "listOrchestrators", {})) as { threadIds: string[] }).threadIds).toEqual([]);
    const count = (table: string) =>
      (harness.sidebarDb.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total;
    expect(count("space_orchestrators")).toBe(0);
    expect(count("space_member_modes")).toBe(0);
  });

  it("reports unchanged assignment and signals the Space channel only on change", async () => {
    const harness = await loadSpacePlugin(world());
    const signals = () =>
      harness.inspection.realtimeSignals.filter((signal) => signal.channel === spaceChannel("space_a")).length;
    expect(await call(harness, "setOrchestrator", { threadId: "thr_o1", orchestrator: true })).toEqual({
      changed: true,
      spaceId: "space_a",
    });
    expect(signals()).toBe(1);
    expect(await call(harness, "setOrchestrator", { threadId: "thr_o1", orchestrator: true })).toEqual({
      changed: false,
      spaceId: "space_a",
    });
    expect(signals()).toBe(1);
  });
});

describe("coordination mode", () => {
  it("defaults to independent and switches to managed and back", async () => {
    const harness = await loadSpacePlugin(world());
    const modeOf = async () =>
      (
        (await call(harness, "getSpaceCoordination", { spaceId: "space_a" })) as {
          members: Array<{ threadId: string; mode: string }>;
        }
      ).members.find((member) => member.threadId === "thr_m1")?.mode;
    expect(await modeOf()).toBe("independent");
    await call(harness, "setMemberMode", { threadId: "thr_m1", mode: "managed" });
    expect(await modeOf()).toBe("managed");
    await call(harness, "setMemberMode", { threadId: "thr_m1", mode: "independent" });
    expect(await modeOf()).toBe("independent");
  });

  it("refuses a mode for a session without a Space", async () => {
    const harness = await loadSpacePlugin(world());
    await expect(call(harness, "setMemberMode", { threadId: "thr_free", mode: "managed" })).rejects.toThrow(
      /not in a Space/,
    );
  });
});

describe("ideas", () => {
  it("creates, lists, updates with links and deletes", async () => {
    const harness = await loadSpacePlugin(world());
    const created = (await call(harness, "createIdea", {
      spaceId: "space_a",
      title: "Cache",
      body: "Add a cache",
      threadIds: ["thr_m1"],
    })) as { id: string; status: string; threadIds: string[] };
    expect(created.status).toBe("open");
    expect(created.threadIds).toEqual(["thr_m1"]);
    const updated = (await call(harness, "updateIdea", { ideaId: created.id, status: "planned" })) as {
      status: string;
    };
    expect(updated.status).toBe("planned");
    expect(((await call(harness, "listIdeas", { spaceId: "space_a" })) as { ideas: unknown[] }).ideas).toHaveLength(1);
    expect(await call(harness, "deleteIdea", { ideaId: created.id })).toEqual({ deleted: true });
    expect(((await call(harness, "listIdeas", { spaceId: "space_a" })) as { ideas: unknown[] }).ideas).toHaveLength(0);
  });

  it("refuses to link a session of another Space", async () => {
    const harness = await loadSpacePlugin(world());
    await expect(
      call(harness, "createIdea", { spaceId: "space_a", title: "X", threadIds: ["thr_b1"] }),
    ).rejects.toThrow(/not a member/);
  });

  it("rejects over-long titles and bodies at the boundary", async () => {
    const harness = await loadSpacePlugin(world());
    await expect(call(harness, "createIdea", { spaceId: "space_a", title: "x".repeat(201) })).rejects.toThrow();
    await expect(
      call(harness, "createIdea", { spaceId: "space_a", title: "ok", body: "x".repeat(16385) }),
    ).rejects.toThrow();
  });

  it("fails with the limit once the Space holds the maximum", async () => {
    const harness = await loadSpacePlugin(world());
    for (let index = 0; index < IDEAS_PER_SPACE_MAX; index += 1) {
      await call(harness, "createIdea", { spaceId: "space_a", title: `Idea ${index}` });
    }
    await expect(call(harness, "createIdea", { spaceId: "space_a", title: "One more" })).rejects.toThrow(
      new RegExp(String(IDEAS_PER_SPACE_MAX)),
    );
  });

  it("drops the link of a deleted session", async () => {
    const harness = await loadSpacePlugin(world());
    const created = (await call(harness, "createIdea", { spaceId: "space_a", title: "T", threadIds: ["thr_m1"] })) as {
      id: string;
    };
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: spaceThread("thr_m1", "space_a") });
    const listed = (await call(harness, "listIdeas", { spaceId: "space_a" })) as {
      ideas: Array<{ id: string; threadIds: string[] }>;
    };
    expect(listed.ideas.find((idea) => idea.id === created.id)?.threadIds).toEqual([]);
  });
});

describe("scratchpad", () => {
  it("accepts the first write at revision 0 and refuses a stale second write with the current text", async () => {
    const harness = await loadSpacePlugin(world());
    const first = (await call(harness, "writeScratchpad", { spaceId: "space_a", body: "one", baseRevision: 0 })) as {
      status: string;
      scratchpad: { revision: number };
    };
    expect(first.status).toBe("written");
    expect(first.scratchpad.revision).toBe(1);
    const stale = (await call(harness, "writeScratchpad", { spaceId: "space_a", body: "two", baseRevision: 0 })) as {
      status: string;
      scratchpad: { revision: number; body: string };
    };
    expect(stale.status).toBe("conflict");
    expect(stale.scratchpad).toMatchObject({ revision: 1, body: "one" });
  });

  it("refuses a body over the byte limit", async () => {
    const harness = await loadSpacePlugin(world());
    await expect(
      call(harness, "writeScratchpad", {
        spaceId: "space_a",
        body: "x".repeat(SCRATCHPAD_BYTES_MAX + 1),
        baseRevision: 0,
      }),
    ).rejects.toThrow();
  });

  it("refuses a write to a Space that does not exist", async () => {
    const harness = await loadSpacePlugin(world());
    await expect(call(harness, "writeScratchpad", { spaceId: "gone", body: "x", baseRevision: 0 })).rejects.toThrow(
      /does not exist/,
    );
  });
});

describe("orphans", () => {
  it("keeps ideas and scratchpad of a deleted Space and adopts them into a live one", async () => {
    const state = world();
    const harness = await loadSpacePlugin(state);
    await call(harness, "createIdea", { spaceId: "space_b", title: "Keep me" });
    await call(harness, "writeScratchpad", { spaceId: "space_b", body: "old notes", baseRevision: 0 });
    await call(harness, "writeScratchpad", { spaceId: "space_a", body: "live notes", baseRevision: 0 });
    state.sections = state.sections.filter((section) => section.id !== "space_b");
    expect(await call(harness, "listOrphanSpaces", {})).toEqual({
      orphans: [{ spaceId: "space_b", ideaCount: 1, hasScratchpad: true }],
    });
    expect(await call(harness, "adoptOrphanSpace", { oldSpaceId: "space_b", spaceId: "space_a" })).toEqual({
      ideasMoved: 1,
      scratchpadAppended: true,
    });
    const scratchpad = (await call(harness, "getScratchpad", { spaceId: "space_a" })) as {
      body: string;
      revision: number;
    };
    expect(scratchpad.body).toContain("live notes");
    expect(scratchpad.body).toContain("## Adopted from deleted Space space_b");
    expect(scratchpad.body).toContain("old notes");
    expect(scratchpad.revision).toBe(2);
    expect(((await call(harness, "listIdeas", { spaceId: "space_a" })) as { ideas: unknown[] }).ideas).toHaveLength(1);
    expect(await call(harness, "listOrphanSpaces", {})).toEqual({ orphans: [] });
  });

  it("refuses to adopt a Space that still exists", async () => {
    const harness = await loadSpacePlugin(world());
    await expect(call(harness, "adoptOrphanSpace", { oldSpaceId: "space_b", spaceId: "space_a" })).rejects.toThrow(
      /still exists/,
    );
  });
});

describe("legacy role tables", () => {
  it("drops thread_orchestrators and thread_ideas", async () => {
    const harness = await loadSpacePlugin(world());
    const tables = (
      harness.sidebarDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).not.toContain("thread_orchestrators");
    expect(tables).not.toContain("thread_ideas");
    expect(tables).toEqual(expect.arrayContaining(["space_orchestrators", "space_ideas", "space_scratchpads"]));
  });
});
