import { describe, expect, it } from "vitest";
import { loadSpacePlugin, spaceThread, type SpaceWorld } from "./test-space-server";

function world(): SpaceWorld {
  return {
    sections: [
      { id: "space_a", name: "Alpha" },
      { id: "space_b", name: "Beta" },
    ],
    threads: [spaceThread("thr_o", "space_a"), spaceThread("thr_m", "space_a"), spaceThread("thr_free", null)],
  };
}

type Harness = Awaited<ReturnType<typeof loadSpacePlugin>>;
const run = (harness: Harness, ...argv: string[]) => harness.behavior.runCli(argv);
const parse = <T>(stdout: string | undefined) => JSON.parse(stdout ?? "null") as T;

describe("sandy spaces", () => {
  it("sets a member mode with JSON output and shows it in the Space", async () => {
    const harness = await loadSpacePlugin(world());
    const result = await run(harness, "member", "mode", "thr_m", "managed", "--json");
    expect(result.exitCode).toBe(0);
    expect(parse(result.stdout)).toEqual({ changed: true, mode: "managed" });
    const shown = parse<{ members: Array<{ threadId: string; mode: string }> }>(
      (await run(harness, "show", "Alpha", "--json")).stdout,
    );
    expect(shown.members.find((member) => member.threadId === "thr_m")?.mode).toBe("managed");
  });

  it("rejects an unknown mode and an unknown Space", async () => {
    const harness = await loadSpacePlugin(world());
    expect((await run(harness, "member", "mode", "thr_m", "wild")).exitCode).not.toBe(0);
    const missing = await run(harness, "show", "Nowhere");
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toMatch(/does not exist/);
  });

  it("adds and removes orchestrators and names the missing Space", async () => {
    const harness = await loadSpacePlugin(world());
    expect(parse((await run(harness, "orchestrator", "add", "thr_o", "--json")).stdout)).toEqual({
      changed: true,
      spaceId: "space_a",
    });
    const refused = await run(harness, "orchestrator", "add", "thr_free");
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toMatch(/not in a Space/);
    expect(parse((await run(harness, "orchestrator", "remove", "thr_o", "--json")).stdout)).toEqual({
      changed: true,
      spaceId: "space_a",
    });
  });

  it("adds, updates, lists and removes ideas", async () => {
    const harness = await loadSpacePlugin(world());
    const added = parse<{ id: string }>(
      (
        await run(
          harness,
          "ideas",
          "add",
          "Alpha",
          "--title",
          "Cache",
          "--body",
          "Add it",
          "--thread",
          "thr_m",
          "--json",
        )
      ).stdout,
    );
    const updated = parse<{ status: string }>(
      (await run(harness, "ideas", "update", added.id, "--status", "planned", "--json")).stdout,
    );
    expect(updated.status).toBe("planned");
    const listed = parse<{ ideas: Array<{ threadIds: string[] }> }>(
      (await run(harness, "ideas", "list", "space_a", "--json")).stdout,
    );
    expect(listed.ideas[0]?.threadIds).toEqual(["thr_m"]);
    const unlinked = parse<{ threadIds: string[] }>(
      (await run(harness, "ideas", "update", added.id, "--unlink", "--json")).stdout,
    );
    expect(unlinked.threadIds).toEqual([]);
    expect(parse((await run(harness, "ideas", "remove", added.id, "--json")).stdout)).toEqual({ deleted: true });
    const invalid = await run(harness, "ideas", "update", "idea_none", "--status", "bogus");
    expect(invalid.exitCode).not.toBe(0);
  });

  it("writes the scratchpad once and reports a stale write as a conflict", async () => {
    const harness = await loadSpacePlugin(world());
    const first = await run(
      harness,
      "scratchpad",
      "write",
      "Alpha",
      "--body",
      "plan",
      "--base-revision",
      "0",
      "--json",
    );
    expect(first.exitCode).toBe(0);
    const stale = await run(
      harness,
      "scratchpad",
      "write",
      "Alpha",
      "--body",
      "other",
      "--base-revision",
      "0",
      "--json",
    );
    expect(stale.exitCode).toBe(1);
    expect(parse<{ status: string; scratchpad: { revision: number } }>(stale.stdout)).toMatchObject({
      status: "conflict",
      scratchpad: { revision: 1 },
    });
    const shown = await run(harness, "scratchpad", "show", "Alpha");
    expect(shown.stdout).toContain("plan");
  });

  it("lists and adopts orphaned Space data", async () => {
    const state = world();
    const harness = await loadSpacePlugin(state);
    await run(harness, "ideas", "add", "Beta", "--title", "Keep");
    state.sections = state.sections.filter((section) => section.id !== "space_b");
    expect(parse<{ orphans: unknown[] }>((await run(harness, "orphans", "--json")).stdout).orphans).toHaveLength(1);
    const adopted = await run(harness, "adopt", "space_b", "Alpha", "--json");
    expect(parse(adopted.stdout)).toEqual({ ideasMoved: 1, scratchpadAppended: false });
    expect((await run(harness, "adopt", "space_a", "Alpha")).exitCode).not.toBe(0);
  });

  it("switches the wake digest", async () => {
    const harness = await loadSpacePlugin(world());
    expect(parse((await run(harness, "wake", "Alpha", "off", "--json")).stdout)).toEqual({ wakeEnabled: false });
    expect((await run(harness, "wake", "Alpha", "maybe")).exitCode).not.toBe(0);
  });

  describe("session callers", () => {
    const asSession = (harness: Harness, threadId: string, ...argv: string[]) =>
      harness.behavior.runCli(argv, { threadId });

    it("refuses owner-only commands and changes nothing", async () => {
      const harness = await loadSpacePlugin(world());
      await run(harness, "orchestrator", "add", "thr_o");
      const attempts = [
        ["member", "mode", "thr_m", "managed"],
        ["orchestrator", "add", "thr_m"],
        ["orchestrator", "remove", "thr_o"],
        ["wake", "Alpha", "off"],
        ["orphans"],
        ["adopt", "gone", "Alpha"],
      ];
      for (const argv of attempts) {
        const result = await asSession(harness, "thr_o", ...argv);
        expect(result.exitCode, argv.join(" ")).not.toBe(0);
        expect(result.stderr).toMatch(/owner/);
      }
      const shown = parse<{
        members: Array<{ threadId: string; mode: string }>;
        orchestratorThreadIds: string[];
        wakeEnabled: boolean;
      }>((await run(harness, "show", "Alpha", "--json")).stdout);
      expect(shown.members.find((member) => member.threadId === "thr_m")?.mode).toBe("independent");
      expect(shown.orchestratorThreadIds).toEqual(["thr_o"]);
      expect(shown.wakeEnabled).toBe(true);
    });

    it("lets a member read and write its own Space but not another", async () => {
      const harness = await loadSpacePlugin(world());
      expect((await asSession(harness, "thr_m", "show", "Alpha")).exitCode).toBe(0);
      expect((await asSession(harness, "thr_m", "ideas", "add", "Alpha", "--title", "x")).exitCode).toBe(0);
      expect((await asSession(harness, "thr_m", "scratchpad", "show", "Alpha")).exitCode).toBe(0);
      for (const argv of [
        ["show", "Beta"],
        ["ideas", "list", "Beta"],
        ["ideas", "add", "Beta", "--title", "x"],
        ["scratchpad", "show", "Beta"],
      ]) {
        const result = await asSession(harness, "thr_m", ...argv);
        expect(result.exitCode, argv.join(" ")).not.toBe(0);
      }
    });

    it("refuses a session outside every Space", async () => {
      const harness = await loadSpacePlugin(world());
      expect((await asSession(harness, "thr_free", "ideas", "list", "Alpha")).exitCode).not.toBe(0);
    });

    it("only an orchestrator of the Space may delete an idea", async () => {
      const harness = await loadSpacePlugin(world());
      await run(harness, "orchestrator", "add", "thr_o");
      const idea = parse<{ id: string }>(
        (await run(harness, "ideas", "add", "Alpha", "--title", "x", "--json")).stdout,
      );
      expect((await asSession(harness, "thr_m", "ideas", "remove", idea.id)).exitCode).not.toBe(0);
      expect((await asSession(harness, "thr_o", "ideas", "remove", idea.id)).exitCode).toBe(0);
    });
  });
});
