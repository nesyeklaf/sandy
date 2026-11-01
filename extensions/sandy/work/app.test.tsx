// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { loadPluginApp } from "@sandy-sdk/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app.tsx"));

describe("sandy/work app", () => {
  it("registers one Work tab instead of the parts' tabs", () => {
    const fixed = app.tabs.filter((tab) => tab.availability === "fixed");
    expect(fixed.map((tab) => tab.id)).toEqual(["work"]);
    expect(app.tabs.filter((tab) => tab.availability === "action").map((tab) => tab.id)).toEqual(["workflow-run"]);
    expect(fixed[0]).toMatchObject({ title: "Work", availability: "fixed", context: { kind: "thread" }, layout: "flush" });
  });

  it("registers one composer banner", () => {
    expect(app.composerCustomizations.map((c) => [c.id, c.banners?.map((b) => b.id)])).toEqual([["work", ["work"]]]);
  });

  it("keeps the parts' other slots", () => {
    expect(app.pendingInteractions.map((p) => p.id).sort()).toEqual(["force-proposal", "gate-approval", "question", "track-approval"]);
    expect(app.threadHeaderActions.map((a) => a.id)).toEqual(["stage"]);
    expect(app.threadContextSegments.map((s) => s.id)).toEqual(["delegates"]);
    expect(app.messageDirectives.map((d) => d.id)).toEqual(["workflow-plus-preview"]);
    expect(app.threadPanelActions.map((a) => a.title)).toEqual(["Workflow run"]);
  });
});
