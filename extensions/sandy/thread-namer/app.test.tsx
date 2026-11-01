// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@sandy-sdk/plugin-sdk/testing/app";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { PluginRpcTestHandlers } from "@sandy-sdk/plugin-sdk/testing/app";
import type { rpcContract } from "./server";

const load = () => loadPluginApp(() => import("./app"));

/** A complete set of rpc handlers; every test overrides the ones it drives. */
function handlers(
  overrides: Partial<PluginRpcTestHandlers<typeof rpcContract>>,
): PluginRpcTestHandlers<typeof rpcContract> {
  return {
    rename: () => ({ ok: true, title: "Flaky login test" }),
    catalog: () => EMPTY_CATALOG,
    selectAgent: ({ selection }) => ({ selection }),
    ...overrides,
  };
}

const EMPTY_CATALOG = {
  selection: null,
  choices: [],
  unavailable: [] as string[],
  pending: [] as string[],
  discovering: false,
};

// renderSlot mounts into the document and leaves it there; without this every
// later query sees the previous test's copy of the slot too.
afterEach(cleanup);

describe("registrations", () => {
  it("registers the header button and the settings section", async () => {
    const app = await load();

    expect(app.threadHeaderActions.map((action) => action.id)).toEqual([
      "rename",
    ]);
    expect(app.settingsSections.map((section) => section.id)).toEqual(["agent"]);
  });
});

describe("the header button", () => {
  it("names the thread it is rendered for", async () => {
    const app = await load();
    const slot = renderSlot<
      { threadId: string; projectId: string; isCompactViewport: boolean },
      typeof rpcContract
    >(
      app.threadHeaderActions[0]!,
      {
        threadId: "thr_1",
        projectId: "proj_1",
        isCompactViewport: false,
      },
      { rpc: handlers({ rename: () => ({ ok: true, title: "Flaky login test" }) }) },
    );

    fireEvent.click(
      slot.getByRole("button", { name: "Re-generate thread name" }),
    );

    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toEqual([
        { method: "rename", input: { threadId: "thr_1" } },
      ]),
    );
  });

  it("stays usable after the agent fails", async () => {
    const app = await load();
    const slot = renderSlot<
      { threadId: string; projectId: string; isCompactViewport: boolean },
      typeof rpcContract
    >(
      app.threadHeaderActions[0]!,
      { threadId: "thr_1", projectId: "proj_1", isCompactViewport: false },
      {
        rpc: handlers({
          rename: () => ({
            ok: false,
            error: "The agent stopped with an error.",
          }),
        }),
      },
    );

    const button = slot.getByRole("button", {
      name: "Re-generate thread name",
    });
    fireEvent.click(button);

    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    expect(slot.inspection.rpcCalls).toHaveLength(1);
  });
});

describe("the model picker", () => {
  const catalog = {
    selection: null,
    choices: [
      {
        providerId: "claude",
        providerName: "Claude Code",
        model: "claude-opus-5",
        label: "Opus 5",
        description: "The big one",
        reasoning: [
          { level: "low" as const, description: "Fast" },
          { level: "high" as const, description: "Careful" },
        ],
        defaultReasoningLevel: "medium" as const,
        extra: false,
      },
      {
        providerId: "codex",
        providerName: "Codex",
        model: "gpt-5-mini",
        label: "5 mini",
        description: "The small one",
        reasoning: [],
        defaultReasoningLevel: "medium" as const,
        extra: true,
      },
    ],
    unavailable: [] as string[],
    pending: [] as string[],
    discovering: false,
  };

  function render(overrides: Partial<typeof catalog> = {}) {
    return loadPluginApp(() => import("./app")).then((app) =>
      renderSlot<Record<string, never>, typeof rpcContract>(
        app.settingsSections[0]!,
        {},
        { rpc: handlers({ catalog: () => ({ ...catalog, ...overrides }) }) },
      ),
    );
  }

  it("offers the thread's own agent and hides the extra models", async () => {
    const slot = await render();

    await slot.findByText("The thread's own agent");
    expect(slot.getByText("Opus 5")).toBeTruthy();
    expect(slot.queryByText("5 mini")).toBeNull();
  });

  it("lists an extra model once it is searched for", async () => {
    const slot = await render();
    await slot.findByText("Opus 5");

    fireEvent.change(slot.getByLabelText("Search models"), {
      target: { value: "mini" },
    });

    await slot.findByText("5 mini");
    expect(slot.queryByText("Opus 5")).toBeNull();
  });

  it("saves a picked model, then offers its reasoning efforts", async () => {
    const slot = await render();
    await slot.findByText("Opus 5");

    fireEvent.click(slot.getByText("Opus 5"));

    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "selectAgent",
        input: {
          selection: {
            providerId: "claude",
            model: "claude-opus-5",
            reasoningLevel: null,
          },
        },
      }),
    );
    await slot.findByText("Reasoning");
    expect(slot.getByText("Default (Medium)")).toBeTruthy();

    fireEvent.click(slot.getByRole("button", { name: "High — Careful" }));

    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "selectAgent",
        input: {
          selection: {
            providerId: "claude",
            model: "claude-opus-5",
            reasoningLevel: "high",
          },
        },
      }),
    );
  });

  it("names the agents that reported no models", async () => {
    const slot = await render({ unavailable: ["Cursor"] });

    await slot.findByText(/No models from Cursor/);
  });
});
