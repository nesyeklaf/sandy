import { describe, expect, it, vi } from "vitest";
import plugin from "./server";
import { DEFAULT_SIDEBAR_SETTINGS } from "./sidebar-settings-values";
import { createFakePluginHost, disposers, loadPlugin } from "./test-server";

describe("lifecycle RPC", () => {
  it("stores the grouped sidebar settings through RPC", async () => {
    const harness = await loadPlugin();
    expect(harness.inspection.registrations.settingsDescriptors).toEqual({});
    await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toEqual({
      ...DEFAULT_SIDEBAR_SETTINGS,
      snoozePresets: "1h, Wait refresh (5 hours)=5h, evening@18:00, tomorrow@09:00, next-week@09:00",
      showRunningChildrenWhenCollapsed: true,
      autoSettleInactive: true,
      autoSettleAfterDays: 3,
      autoSettleOnMerge: true,
      childSortField: "created",
      childSortDirection: "ascending",
      childIconStyle: "disc",
      compactWorkingThreads: false,
      workingShelf: false,
      dockShelves: false,
      projectColorsEnabled: false,
      projectColorDisplay: "all",
      spaceHeaderDensity: "compact",
    });
    await expect(
      harness.behavior.callRpc("updateSidebarSettings", {
        snoozePresets: "10m, 4h",
        showRunningChildrenWhenCollapsed: false,
        autoSettleInactive: false,
        autoSettleAfterDays: 7,
        autoSettleOnMerge: false,
        childSortField: "activity",
        childSortDirection: "descending",
        childIconStyle: "provider",
        compactWorkingThreads: true,
        workingShelf: true,
        dockShelves: true,
        projectColorsEnabled: true,
        projectColorDisplay: "grouped",
      }),
    ).resolves.toEqual({
      ...DEFAULT_SIDEBAR_SETTINGS,
      snoozePresets: "10m, 4h",
      showRunningChildrenWhenCollapsed: false,
      autoSettleInactive: false,
      autoSettleAfterDays: 7,
      autoSettleOnMerge: false,
      childSortField: "activity",
      childSortDirection: "descending",
      childIconStyle: "provider",
      threadDensity: "auto",
      compactWorkingThreads: true,
      workingShelf: true,
      dockShelves: true,
      projectColorsEnabled: true,
      projectColorDisplay: "grouped",
    });
    // A client that predates the setting leaves it out and must not reset it.
    await expect(
      harness.behavior.callRpc("updateSidebarSettings", {
        snoozePresets: "10m, 4h",
        showRunningChildrenWhenCollapsed: false,
        autoSettleInactive: false,
        autoSettleAfterDays: 7,
        autoSettleOnMerge: false,
        childSortField: "activity",
        childSortDirection: "descending",
        childIconStyle: "provider",
      }),
    ).resolves.toMatchObject({
      threadDensity: "auto",
      compactWorkingThreads: true,
      workingShelf: true,
      dockShelves: true,
      projectColorsEnabled: true,
      projectColorDisplay: "grouped",
    });
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "sidebar-settings",
      payload: {},
    });
    expect(harness.inspection.registrations.schedules).toContainEqual(
      expect.objectContaining({ name: "auto-settle", cron: "*/5 * * * *" }),
    );
  });

  it("persists color display mode across reloads and rejects unknown modes", async () => {
    const harness = await loadPlugin();
    const settings = (await harness.behavior.callRpc("getSidebarSettings", {})) as Record<string, unknown>;
    await harness.behavior.callRpc("updateSidebarSettings", { ...settings, projectColorDisplay: "full" });
    await expect(
      harness.behavior.callRpc("updateSidebarSettings", { ...settings, projectColorDisplay: "invalid" }),
    ).rejects.toThrow("rpc input validation failed");
    const reloaded = await harness.lifecycle.reload(plugin);
    disposers.push(() => reloaded.harness.lifecycle.dispose());
    await expect(reloaded.harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({
      projectColorDisplay: "full",
      projectColorsEnabled: false,
    });
  });

  it("rejects invalid snooze shortcuts at the RPC boundary", async () => {
    const harness = await loadPlugin();

    await expect(
      harness.behavior.callRpc("updateSidebarSettings", {
        snoozePresets: "later",
        showRunningChildrenWhenCollapsed: true,
        autoSettleInactive: true,
        autoSettleAfterDays: 3,
        autoSettleOnMerge: true,
        childSortField: "created",
        childSortDirection: "ascending",
        childIconStyle: "disc",
      }),
    ).rejects.toThrow("rpc input validation failed");
    await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({
      snoozePresets: "1h, Wait refresh (5 hours)=5h, evening@18:00, tomorrow@09:00, next-week@09:00",
    });
  });

  it("saves editable calendar shortcuts and rejects invalid times", async () => {
    const harness = await loadPlugin();
    const settings = (await harness.behavior.callRpc("getSidebarSettings", {})) as Record<string, unknown>;
    const snoozePresets = "1h, Wait refresh=5h, Tonight=evening@20:00, Morning=tomorrow@08:30, Monday=next-week@10:00";
    await expect(
      harness.behavior.callRpc("updateSidebarSettings", { ...settings, snoozePresets }),
    ).resolves.toMatchObject({ snoozePresets });
    await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({ snoozePresets });
    await expect(
      harness.behavior.callRpc("updateSidebarSettings", { ...settings, snoozePresets: "tomorrow@24:00" }),
    ).rejects.toThrow("rpc input validation failed");
    await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({ snoozePresets });
  });

  it("migrates values from the previous flat settings form", async () => {
    const { sandy, harness } = createFakePluginHost({
      pluginId: "sandy-sidebar",
      sdk: {
        plugins: {
          getSettings: async () => ({
            ok: true as const,
            schema: {},
            values: {
              snoozePresets: "20m, 6h",
              inactiveAfterHours: "18",
              showRunningChildrenWhenCollapsed: false,
              autoSettleInactive: false,
              autoSettleAfterDays: "14",
              autoSettleOnMerge: false,
            },
          }),
        },
      },
    });
    await plugin(sandy);
    disposers.push(() => harness.lifecycle.dispose());

    await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toEqual({
      ...DEFAULT_SIDEBAR_SETTINGS,
      snoozePresets: "20m, 6h",
      showRunningChildrenWhenCollapsed: false,
      autoSettleInactive: false,
      autoSettleAfterDays: 14,
      autoSettleOnMerge: false,
      childSortField: "created",
      childSortDirection: "ascending",
      childIconStyle: "disc",
      compactWorkingThreads: false,
      workingShelf: false,
      dockShelves: false,
      projectColorsEnabled: false,
      projectColorDisplay: "all",
    });
  });
});

it("writes only JSON and keeps historical columns unchanged across reloads", async () => {
  const getSettings = vi.fn(async () => ({ values: {}, pluginId: "sandy-sidebar" }));
  const { sandy, harness } = createFakePluginHost({ pluginId: "sandy-sidebar", sdk: { plugins: { getSettings } } });
  await plugin(sandy);
  disposers.push(() => harness.lifecycle.dispose());
  const db = sandy.storage.database();
  const { settings_json: beforeJson, ...beforeColumns } = db.prepare("SELECT * FROM sidebar_settings").get() as Record<
    string,
    unknown
  >;
  expect(beforeJson).toBeNull();
  const next = {
    ...DEFAULT_SIDEBAR_SETTINGS,
    snoozePresets: "20m, 6h",
    workingShelf: true,
    compactProjectIconOnly: true,
  };
  await expect(harness.behavior.callRpc("updateSidebarSettings", next)).resolves.toEqual(next);
  const { settings_json: storedJson, ...afterColumns } = db.prepare("SELECT * FROM sidebar_settings").get() as Record<
    string,
    unknown
  >;
  expect(JSON.parse(storedJson as string)).toEqual(next);
  expect(afterColumns).toEqual(beforeColumns);
  const reloaded = await harness.lifecycle.reload(plugin);
  disposers.push(() => reloaded.harness.lifecycle.dispose());
  await expect(reloaded.harness.behavior.callRpc("getSidebarSettings", {})).resolves.toEqual(next);
  expect(getSettings).toHaveBeenCalledTimes(1);
});

it("defaults missing and invalid JSON fields without losing valid settings", async () => {
  const { sandy, harness } = createFakePluginHost({ pluginId: "sandy-sidebar" });
  await plugin(sandy);
  disposers.push(() => harness.lifecycle.dispose());
  const db = sandy.storage.database();
  db.prepare("UPDATE sidebar_settings SET settings_json = ? WHERE id = 1").run(
    JSON.stringify({
      snoozePresets: "20m, 6h",
      autoSettleInactive: false,
      inactiveThreadsEnabled: "false",
      autoSettleAfterDays: -1,
      childSortField: "invalid",
      compactProjectIconOnly: "true",
      projectColorDisplay: "invalid",
      removedSetting: true,
    }),
  );
  await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toEqual({
    ...DEFAULT_SIDEBAR_SETTINGS,
    snoozePresets: "20m, 6h",
    autoSettleInactive: false,
  });
});

it.each(["", "{broken", "null", "[]", "42", '"settings"'])("defaults malformed JSON %s", async (stored) => {
  const { sandy, harness } = createFakePluginHost({ pluginId: "sandy-sidebar" });
  await plugin(sandy);
  disposers.push(() => harness.lifecycle.dispose());
  sandy.storage.database().prepare("UPDATE sidebar_settings SET settings_json = ? WHERE id = 1").run(stored);
  await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toEqual(DEFAULT_SIDEBAR_SETTINGS);
  expect(harness.inspection.logEntries).toContainEqual(
    expect.objectContaining({
      level: "warn",
      message: expect.stringMatching(/^Could not parse sidebar_settings\.settings_json; using defaults: .+/),
    }),
  );
});

it.each([
  [{ compactWorkingThreads: true }, "auto"],
  [{ compactWorkingThreads: false }, "comfortable"],
  [{ threadDisplay: "full", compactWorkingThreads: false }, "comfortable"],
  [{ threadDisplay: "compact-working", compactWorkingThreads: true }, "auto"],
  [{ threadDisplay: "compact-all", compactWorkingThreads: true }, "dense"],
  [{ threadDisplay: "toString", compactWorkingThreads: false }, "comfortable"],
  [{ threadDensity: "huge-future", compactWorkingThreads: true }, "auto"],
  [{ threadDensity: "huge-future", compactWorkingThreads: false }, "comfortable"],
])("reads thread density %j from settings saved without a known value", async (stored, threadDensity) => {
  const { sandy, harness } = createFakePluginHost({ pluginId: "sandy-sidebar" });
  await plugin(sandy);
  disposers.push(() => harness.lifecycle.dispose());
  sandy.storage
    .database()
    .prepare("UPDATE sidebar_settings SET settings_json = ? WHERE id = 1")
    .run(JSON.stringify(stored));
  await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({
    threadDensity,
    compactWorkingThreads: threadDensity !== "comfortable",
  });
});

it("keeps the legacy switch in step when density changes", async () => {
  const harness = await loadPlugin();
  for (const [threadDensity, compactWorkingThreads] of [
    ["auto", true],
    ["dense", true],
    ["compact", true],
    ["comfortable", false],
  ] as const) {
    await expect(harness.behavior.callRpc("updateSidebarSettings", { threadDensity })).resolves.toMatchObject({
      threadDensity,
      compactWorkingThreads,
    });
  }
  await expect(
    harness.behavior.callRpc("updateSidebarSettings", { compactWorkingThreads: true }),
  ).resolves.toMatchObject({ threadDensity: "auto", compactWorkingThreads: true });
});

it("accepts shelf densities from an open tab that predates the ideas shelf", async () => {
  const harness = await loadPlugin();
  const { ideas: _ideas, ...withoutIdeas } = DEFAULT_SIDEBAR_SETTINGS.shelfDensities;
  await expect(
    harness.behavior.callRpc("updateSidebarSettings", { shelfDensities: { ...withoutIdeas, working: "dense" } }),
  ).resolves.toMatchObject({ shelfDensities: { working: "dense", ideas: "default" } });
  await harness.behavior.callRpc("updateSidebarSettings", {
    shelfDensities: { ...DEFAULT_SIDEBAR_SETTINGS.shelfDensities, ideas: "compact" },
  });
  await expect(
    harness.behavior.callRpc("updateSidebarSettings", { shelfDensities: { ...withoutIdeas, pinned: "dense" } }),
  ).resolves.toMatchObject({ shelfDensities: { pinned: "dense", ideas: "compact" } });
});

it("stores per-shelf density overrides and keeps the rest at default", async () => {
  const harness = await loadPlugin();
  await expect(
    harness.behavior.callRpc("updateSidebarSettings", {
      shelfDensities: {
        pinned: "comfortable",
        needs: "default",
        failed: "default",
        working: "dense",
        review: "default",
        waiting: "compact",
        ideas: "dense",
        merged: "default",
      },
    }),
  ).resolves.toMatchObject({
    shelfDensities: {
      pinned: "comfortable",
      needs: "default",
      working: "dense",
      review: "default",
      waiting: "compact",
      ideas: "dense",
    },
  });
  await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({
    shelfDensities: { pinned: "comfortable", working: "dense", waiting: "compact", ideas: "dense" },
  });
});
