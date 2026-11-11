// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, loadInboxApp, defaultSidebarSettings } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

const sections = [{ id: "sec_a", name: "Launch", createdAt: 0, updatedAt: 0 }];
const projects = [
  {
    id: "proj_1",
    name: "Alpha",
    isPersonal: false,
    href: "/projects/proj_1",
    settingsHref: "/projects/proj_1/settings",
  },
];

function renderSpaces(update = vi.fn(async () => ({})), create = vi.fn(async () => ({ id: "sec_new" }))) {
  window.localStorage.clear();
  return {
    update,
    create,
    ...renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "In launch", projectId: "proj_1", sectionId: "sec_a" }),
          thread({ id: "b", title: "Loose one", projectId: "proj_1", sectionId: null }),
        ],
        projects,
        sections,
      },
      threadActions: () => [],
      sdk: { threads: { update }, threadSections: { create } } as never,
    }),
  };
}

async function expandSpaces() {
  fireEvent.click(await screen.findByRole("radio", { name: "Spaces" }));
  fireEvent.click(await screen.findByRole("button", { name: "No Space (1)" }));
}

describe("spaces layout", () => {
  it("draws each row at its shelf's Auto density", async () => {
    window.localStorage.clear();
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "busy", title: "Busy one", projectId: "proj_1", indicator: "runtime" }),
          thread({ id: "ask", title: "Asking one", projectId: "proj_1", hasPendingInteraction: true }),
          thread({ id: "idle", title: "Idle one", projectId: "proj_1" }),
        ],
        projects,
        sections,
      },
      rpc: {
        getSidebarSettings: () => ({ ...defaultSidebarSettings, threadDensity: "auto" }),
        listLifecycle: () => ({ rows: [] }),
      },
    });
    fireEvent.click(await screen.findByRole("radio", { name: "Spaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "No Space (3)" }));
    const density = (title: string) =>
      screen.getByRole("link", { name: title }).closest("[data-parent-card]")?.getAttribute("data-row-density");
    await waitFor(() => expect(density("Busy one")).toBe("compact"));
    expect(density("Asking one")).toBe("comfortable");
    expect(density("Idle one")).toBe("dense");
  });

  it("opens collapsed Spaces with counts and groups rows by repository, and remembers the layout", async () => {
    renderSpaces();
    fireEvent.click(await screen.findByRole("radio", { name: "Spaces" }));
    const launch = await screen.findByRole("region", { name: "Launch" });
    expect(within(launch).queryByText("In launch")).toBeNull();
    fireEvent.click(within(launch).getByRole("button", { name: "Launch (1)" }));
    expect(within(launch).getByText("Alpha")).toBeTruthy();
    expect(within(launch).getByText("In launch")).toBeTruthy();
    const loose = screen.getByRole("region", { name: "No Space" });
    fireEvent.click(within(loose).getByRole("button", { name: "No Space (1)" }));
    expect(within(loose).getByText("Loose one")).toBeTruthy();
    fireEvent.click(within(launch).getByRole("button", { name: "Launch (1)" }));
    expect(screen.queryByText("In launch")).toBeNull();
    expect(screen.getByRole("radio", { name: "Spaces" }).getAttribute("aria-checked")).toBe("true");
  });

  it("filters a Space by a stat chip and disables zero counts", async () => {
    window.localStorage.clear();
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "ask",
            title: "Asking one",
            projectId: "proj_1",
            sectionId: "sec_a",
            hasPendingInteraction: true,
          }),
          thread({ id: "calm", title: "Calm one", projectId: "proj_1", sectionId: "sec_a" }),
        ],
        projects,
        sections,
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });
    fireEvent.click(await screen.findByRole("radio", { name: "Spaces" }));
    const launch = await screen.findByRole("region", { name: "Launch" });
    expect((within(launch).getByRole("button", { name: "0 working in Launch" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(within(launch).getByRole("button", { name: "1 needs you in Launch" }));
    expect(within(launch).getByText("Asking one")).toBeTruthy();
    expect(within(launch).queryByText("Calm one")).toBeNull();
  });

  it("moves a session into a section from the context menu", async () => {
    const { update } = renderSpaces();
    await expandSpaces();
    fireEvent.contextMenu(await screen.findByText("Loose one"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Space…" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Launch" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ threadId: "b", sectionId: "sec_a" }));
  });

  it("creates a project from the menu and moves the session into it", async () => {
    const { update, create } = renderSpaces();
    await expandSpaces();
    fireEvent.contextMenu(await screen.findByText("Loose one"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Space…" }));
    const input = await screen.findByLabelText("New Space");
    fireEvent.change(input, { target: { value: "  Umzug  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: "Umzug" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ threadId: "b", sectionId: "sec_new" }));
  });

  it("opens Spaces collapsed when no layout was ever stored", async () => {
    window.localStorage.clear();
    renderSlot(inbox, listProps, {
      legacyFlowDefault: false,
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "In launch", projectId: "proj_1", sectionId: "sec_a" }),
          thread({ id: "b", title: "Loose one", projectId: "proj_1", sectionId: null }),
        ],
        projects,
        sections,
      },
      threadActions: () => [],
    });
    expect(await screen.findByRole("button", { name: "Launch (1)" })).toBeTruthy();
    expect(window.localStorage.getItem("sandy-sidebar:list-view:v1")).not.toBe("flow");
    expect(screen.getByRole("radio", { name: "Spaces" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: "Launch (1)" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("In launch")).toBeNull();
  });

  it("[real-session-actions] expands a worker tree and answers a pending question from a Space row", async () => {
    const question = {
      id: "int_q",
      threadId: "root",
      status: "pending",
      statusReason: null,
      createdAt: 10,
      resolvedAt: null,
      turnId: "turn_1",
      providerId: "codex",
      providerThreadId: "p_1",
      providerRequestId: "r_1",
      payload: {
        kind: "user_question",
        questions: [
          {
            id: "branch",
            prompt: "Create a branch?",
            multiSelect: false,
            allowFreeText: false,
            required: true,
            options: [{ value: "yes", label: "Yes, create it" }],
          },
        ],
      },
    };
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "root",
            title: "Root",
            projectId: "proj_1",
            sectionId: "sec_a",
            hasPendingInteraction: true,
            indicator: "waiting-for-input",
          }),
          thread({ id: "worker", title: "Worker", projectId: "proj_1", sectionId: "sec_a", parentThreadId: "root" }),
        ],
        projects,
        sections,
      },
      rpc: { listLifecycle: () => ({ rows: [] }), getSidebarSettings: () => ({ ...defaultSidebarSettings }) },
      sdk: { threads: { interactions: { list: async () => [question], resolve: async () => ({}) } } } as never,
    });
    fireEvent.click(await screen.findByRole("radio", { name: "Spaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "1 needs you in Launch" }));
    fireEvent.click(await screen.findByRole("button", { name: "1 child thread" }));
    expect(await screen.findByRole("button", { name: /Open child thread: Worker/ })).toBeTruthy();
    const group = await screen.findByRole("group", { name: "Answer Root" });
    fireEvent.click(within(group).getByRole("button", { name: "Yes, create it" }));
    expect(within(group).getByText("Answered “Yes, create it”")).toBeTruthy();
    await waitFor(
      () => expect(rendered.sdkCalls.some((call) => call.method === "threads.interactions.resolve")).toBe(true),
      { timeout: 10_000 },
    );
  });
});
