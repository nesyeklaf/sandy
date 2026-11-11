// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

import { prThreads, setup } from "./test-spaces";

describe("Space expansion migrated from a saved Tree device", () => {
  it("keeps the sections Tree left open and persists them", async () => {
    const view = setup({
      threads: prThreads(),
      storage: {
        "sandy-sidebar:list-view:v1": "tree",
        "sandy-sidebar:tree-collapse:v1": JSON.stringify(["sec_b"]),
      },
    });
    expect((await screen.findByRole("button", { name: "Launch (3)" })).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Plan (1)" }).getAttribute("aria-expanded")).toBe("false");
    expect(JSON.parse(localStorage.getItem("sandy-sidebar:space-expansion:v1") ?? "null")).toEqual(["sec_a"]);
    view.unmount();
  });

  it("starts collapsed when no Tree choice was saved", async () => {
    const view = setup({ threads: prThreads() });
    expect((await screen.findByRole("button", { name: "Launch (3)" })).getAttribute("aria-expanded")).toBe("false");
    view.unmount();
  });
});
