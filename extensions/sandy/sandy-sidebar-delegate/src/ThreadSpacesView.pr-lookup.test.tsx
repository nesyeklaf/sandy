// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { thread, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

import { setup } from "./test-spaces";

const LIMIT_PER_CALL = 200;
const ROOTS = LIMIT_PER_CALL + 1;
const MONTH = 30 * 24 * 60 * 60 * 1000;

describe("Space pull request lookup", () => {
  it("requests every environment in bounded calls so the last root leaves unknown", async () => {
    const requested: string[][] = [];
    const threads = Array.from({ length: ROOTS }, (_, index) =>
      thread({
        id: `old${index}`,
        title: `Old ${index}`,
        projectId: "proj_1",
        sectionId: "sec_a",
        updatedAt: Date.now() - MONTH,
        latestAttentionAt: Date.now() - MONTH,
        environment: {
          id: `env_${String(index).padStart(3, "0")}`,
          name: "Worktree",
          branchName: "test",
          workspaceDisplayKind: "managed-worktree",
          path: null,
          isWorktree: null,
          providerId: null,
        },
      }),
    );
    setup({
      threads,
      settings: { spaceHeaderDensity: "detailed" },
      pullRequests: ({ keys }) => {
        requested.push(keys);
        return Object.fromEntries(keys.map((key) => [key, { outcome: "absent" }]));
      },
    });
    const launch = await screen.findByRole("region", { name: "Launch" });
    await waitFor(() =>
      expect(within(launch).getByRole("button", { name: `${ROOTS} dormant in Launch` })).toBeTruthy(),
    );
    expect(Math.max(...requested.map((keys) => keys.length))).toBeLessThanOrEqual(LIMIT_PER_CALL);
    expect(new Set(requested.flat()).size).toBe(ROOTS);
  });
});
