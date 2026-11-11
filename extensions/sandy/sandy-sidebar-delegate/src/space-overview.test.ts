import { describe, expect, it } from "vitest";
import { loadPlugin } from "./test-server";
import { DAY, listed, overview } from "./test-space-overview";
import { buildSpaces, spacePrOfRow } from "./spaces-model";

const openPr = { outcome: "available", pullRequest: { state: "open", updatedAt: "2026-10-31T00:00:00Z" } };

describe("getSpaceOverview", () => {
  it("[core-mutation-parity] counts needs-you roots per Space and keeps unassigned roots last", async () => {
    const result = await overview([
      listed("a", { sectionId: "sec_a", hasPendingInteraction: true }),
      listed("b", { sectionId: null }),
    ]);
    expect(result.spaces.map((space) => [space.id, space.name, space.total])).toEqual([
      ["sec_a", "Launch", 1],
      [null, "No Space", 1],
    ]);
    expect(result.spaces[0]!.counts.needs).toBe(1);
    expect(result.spaces[0]!.roots[0]).toMatchObject({ rootId: "a", shelf: "needs" });
  });

  it("reads open PRs through the PR Status plugin and treats absent as none and failures as unknown", async () => {
    const old = Date.now() - 10 * DAY;
    const aged = { updatedAt: old, latestAttentionAt: old, sectionId: "sec_a" };
    const result = await overview(
      [
        listed("pr", { ...aged, environmentId: "env_pr" }),
        listed("none", { ...aged, environmentId: "env_none" }),
        listed("lost", { ...aged, environmentId: "env_lost" }),
        listed("bare", aged),
      ],
      {},
      { env_pr: openPr, env_none: { outcome: "absent" }, env_lost: { outcome: "unavailable" } },
    );
    expect(result.pullRequests).toBe("unavailable");
    const shelves = Object.fromEntries(result.spaces[0]!.roots.map((root) => [root.rootId, root.shelf]));
    expect(shelves).toEqual({ pr: "review", none: "dormant", lost: "ready", bare: "dormant" });
    expect(result.spaces[0]!.counts.openPr).toBe(1);
  });

  it("reports pull requests available when every lookup answers and unavailable when the plugin fails", async () => {
    const env = listed("env", { sectionId: "sec_a", environmentId: "env_1" });
    expect((await overview([env], {}, { env_1: { outcome: "absent" } })).pullRequests).toBe("available");
    const failed = await overview([{ ...env, updatedAt: 0, latestAttentionAt: 0 }], {}, new Error("plugin disabled"));
    expect(failed.pullRequests).toBe("unavailable");
    expect(failed.spaces[0]!.roots[0]!.shelf).toBe("ready");
  });

  it("scopes to one project and rejects unknown input", async () => {
    const threads = [listed("a", { sectionId: "sec_a" }), listed("b", { sectionId: "sec_a", projectId: "p2" })];
    expect((await overview(threads, { projectId: "p2" })).spaces[0]!.total).toBe(1);
    const harness = await loadPlugin();
    await expect(
      harness.behavior.callRpc("getSpaceOverview", { projectId: "p1", extra: 1 } as never),
    ).rejects.toThrow();
  });

  it("[rpc-ui-parity] returns exactly what the shared model builds from the same roots", async () => {
    const now = Date.now();
    const threads = [
      listed("a", { sectionId: "sec_a", hasPendingInteraction: true }),
      listed("b", { sectionId: "sec_a", projectId: "p2" }),
      listed("c"),
    ];
    const result = await overview(threads);
    const expected = buildSpaces({
      threads: threads.map((thread) => ({
        id: thread.id,
        parentThreadId: thread.parentThreadId,
        projectId: thread.projectId,
        sectionId: thread.sectionId,
        isArchived: false,
        isHidden: false,
      })),
      sections: [{ id: "sec_a", name: "Launch" }],
      facts: (thread) => ({
        lifecycle: "active",
        asks: thread.id === "a",
        failed: false,
        working: false,
        pr: "none",
        idea: false,
        orchestrator: false,
        activityAt: now,
      }),
      now,
      unassignedName: "No Space",
    });
    expect(result.spaces).toEqual(expected);
  });

  it("[rpc-ui-parity] classifies every PR row kind exactly as the shared sidebar normalization does", async () => {
    const old = Date.now() - 10 * DAY;
    const aged = { updatedAt: old, latestAttentionAt: old, sectionId: "sec_a" };
    const rows: Record<string, unknown> = {
      env_open: { outcome: "available", pullRequest: { state: "open" } },
      env_merged: { outcome: "available", pullRequest: { state: "merged" } },
      env_draft: { outcome: "available", pullRequest: { state: "draft" } },
      env_closed: { outcome: "available", pullRequest: { state: "closed" } },
      env_absent: { outcome: "absent" },
      env_down: { outcome: "unavailable" },
      env_junk: { outcome: "available" },
    };
    const keys = [...Object.keys(rows), "env_missing"];
    const threads = keys.map((key) => listed(key, { ...aged, environmentId: key }));
    const result = await overview(threads, {}, rows);
    const expected = buildSpaces({
      threads: threads.map((thread) => ({
        id: thread.id,
        parentThreadId: null,
        projectId: thread.projectId,
        sectionId: thread.sectionId,
        isArchived: false,
        isHidden: false,
      })),
      sections: [{ id: "sec_a", name: "Launch" }],
      facts: (thread) => ({
        lifecycle: "active",
        asks: false,
        failed: false,
        working: false,
        pr: spacePrOfRow(rows[thread.id]),
        idea: false,
        orchestrator: false,
        activityAt: old,
      }),
      now: Date.now(),
      unassignedName: "No Space",
    });
    expect(result.spaces).toEqual(expected);
    expect(result.pullRequests).toBe("unavailable");
  });

  it("publishes getSpaceOverview, and only it, for cross-plugin discovery with JSON schemas", async () => {
    const harness = await loadPlugin();
    const published = harness.inspection.registrations.experimental_publishedRpcMethods;
    expect(published.map((method) => method.method)).toEqual(["getSpaceOverview"]);
    expect(published[0]?.registrationDescription).toMatch(/Space overview/);
    expect(published[0]?.inputSchema).toMatchObject({ type: "object" });
    expect(published[0]?.outputSchema).toMatchObject({ type: "object" });
    expect(harness.inspection.registrations.rpcMethods).toContain("getSpaceOverview");
  });
});
