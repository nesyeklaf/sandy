import { describe, expect, it } from "vitest";
import { makeHost } from "@sandy/test-helpers/domain-fixtures";
import { makePluginListItem } from "@/test/fixtures/plugins";
import {
  buildUpdateInventoryPlugins,
  updateInventoryHosts,
} from "./useUpdateInventory";

describe("buildUpdateInventoryPlugins", () => {
  it("lists tracking plugins with compatible or blocked candidates only", () => {
    const tracking = makePluginListItem({
      id: "notes",
      name: "Notes",
      source: "npm:@acme/notes@^1.0.0",
      updateState: {
        outcome: "update-available",
        availableVersion: "1.2.0",
        availableLabel: "1.2.0",
      },
    });
    const blocked = makePluginListItem({
      id: "linear",
      name: "Linear",
      source: "git:github.com/acme/linear@^0.8.0",
      updateState: {
        outcome: "incompatible",
        blockedVersion: "0.9.0",
        blockedLabel: "0.9.0",
        blockedReasons: ["engines.sandy requires >=2.0.0"],
      },
    });
    const current = makePluginListItem({
      id: "current",
      source: "npm:@acme/current@^1.0.0",
      updateState: { outcome: "current" },
    });
    const pinned = makePluginListItem({
      id: "pinned",
      source: "npm:@acme/pinned@1.0.0",
      updateState: {
        outcome: "pinned",
        blockedVersion: "2.0.0",
        blockedLabel: "2.0.0",
      },
    });
    const path = makePluginListItem({
      id: "local",
      source: "path:/plugins/local",
      updateState: { availableVersion: "9.9.9", availableLabel: "9.9.9" },
    });
    const builtin = makePluginListItem({
      id: "git",
      source: "builtin:git",
      provenance: "builtin",
      updateState: { availableVersion: "9.9.9", availableLabel: "9.9.9" },
    });

    expect(
      buildUpdateInventoryPlugins([
        tracking,
        blocked,
        current,
        pinned,
        path,
        builtin,
      ]),
    ).toEqual({
      trackedCount: 3,
      items: [
        {
          kind: "blocked",
          plugin: blocked,
          version: "0.9.0",
          reasons: ["engines.sandy requires >=2.0.0"],
        },
        { kind: "update", plugin: tracking, version: "1.2.0" },
      ],
    });
  });

  it("offers the compatible update when a newer release is also blocked", () => {
    const plugin = makePluginListItem({
      source: "npm:@acme/notes@^1.0.0",
      updateState: {
        outcome: "update-available",
        availableVersion: "1.2.0",
        availableLabel: "1.2.0",
        blockedVersion: "1.3.0",
        blockedLabel: "1.3.0",
        blockedReasons: ["engines.sandyPluginSdk requires ^3.0.0"],
      },
    });
    expect(buildUpdateInventoryPlugins([plugin]).items).toEqual([
      { kind: "update", plugin, version: "1.2.0" },
    ]);
  });
});

describe("updateInventoryHosts", () => {
  it("omits machines from ephemeral providers", () => {
    const modal = makeHost({
      id: "host_modal",
      type: "ephemeral",
      machineProviderId: "modal-sandbox",
    });
    const persistent = makeHost({
      id: "host_persistent",
      machineProviderId: "persistent-cloud",
    });
    const manual = makeHost({ id: "host_manual" });
    expect(updateInventoryHosts([modal, persistent, manual])).toEqual([
      persistent,
      manual,
    ]);
  });
});
