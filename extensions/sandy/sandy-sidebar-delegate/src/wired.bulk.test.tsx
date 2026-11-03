// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createWired } from "./test-wired";
import { sortPinnedThreads } from "./pinned-order";
import { loadInboxApp, thread, toastMocks } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());
await loadInboxApp();

type Wired = Awaited<ReturnType<typeof createWired>>;

const item = (id: string, extra: Parameters<typeof thread>[0] = {}) =>
  thread({ id, title: `Work ${id}`, updatedAt: Date.now(), ...extra });

const tagsOf = (wired: Wired, id: string) =>
  (
    wired.db
      .prepare("SELECT tag FROM topic_tags WHERE owner_kind = 'thread' AND owner_id = ? ORDER BY tag")
      .all(id) as Array<{ tag: string }>
  ).map((row) => row.tag);

function lastUndo(): () => void {
  const [, options] = toastMocks.success.mock.calls.at(-1)! as [
    string,
    { action: { label: string; onClick: () => void } },
  ];
  expect(options.action.label).toBe("Undo");
  return options.action.onClick;
}

async function pinOrder(wired: Wired) {
  const projects = await wired.sandy.sdk.projects.list({ include: "threads", includePersonal: true });
  const threads = projects.flatMap((project) => ("threads" in project ? project.threads : []));
  return sortPinnedThreads(threads.filter((entry) => entry.pinnedAt !== null)).map((entry) => entry.id);
}

const archivedAt = async (wired: Wired, threadId: string) =>
  (await wired.sandy.sdk.threads.get({ threadId })).archivedAt;

const pinnedAt = async (wired: Wired, threadId: string) => (await wired.sandy.sdk.threads.get({ threadId })).pinnedAt;

async function select(...titles: string[]) {
  fireEvent.click(await screen.findByRole("button", { name: /^View options/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Select threads" }));
  for (const title of titles) fireEvent.click(await screen.findByRole("checkbox", { name: `Select ${title}` }));
  return screen.getByRole("toolbar", { name: "Selected threads" });
}

it("tags while the tag index is still loading without dropping existing tags", async () => {
  const wired = await createWired([item("a"), item("b")], {
    rpcGate: (method) => (method === "listAllTags" ? new Promise<void>(() => {}) : undefined),
  });
  await wired.call("setTopicTags", { kind: "thread", ownerId: "a", tags: ["existing"] });
  wired.mount();
  const bar = await select("Work a", "Work b");
  fireEvent.click(within(bar).getByRole("button", { name: "Tag" }));
  const input = await screen.findByRole("textbox", { name: "Tag name" });
  fireEvent.change(input, { target: { value: "New" } });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => expect(tagsOf(wired, "b")).toEqual(["new"]));
  expect(tagsOf(wired, "a")).toEqual(["existing", "new"]);
  lastUndo()();
  await waitFor(() => expect(tagsOf(wired, "b")).toEqual([]));
  expect(tagsOf(wired, "a")).toEqual(["existing"]);
});

it("undoes a bulk Pin by unpinning again and restoring the lifecycle row", async () => {
  const wired = await createWired([item("a")]);
  await wired.call("updateSidebarSettings", { autoSettleInactive: false });
  wired.mount();
  const bar = await select("Work a");
  fireEvent.click(within(bar).getByRole("button", { name: "Pin" }));
  await waitFor(async () => expect(await pinnedAt(wired, "a")).not.toBeNull());
  await waitFor(() => expect(toastMocks.success).toHaveBeenCalled());
  lastUndo()();
  await waitFor(async () => expect(await pinnedAt(wired, "a")).toBeNull());
  expect(await wired.call("listLifecycle")).toEqual({ rows: [] });
});

it("unpins all-pinned selections and Undo pins them back in their old order", async () => {
  const pinned = (id: string, key: string) => item(id, { isPinned: true, pinnedAt: 1, pinSortKey: key });
  const wired = await createWired([pinned("p1", "a"), pinned("p2", "b"), pinned("p3", "c")]);
  await wired.call("updateSidebarSettings", { autoSettleInactive: false });
  wired.mount();
  const bar = await select("Work p1", "Work p3");
  fireEvent.click(within(bar).getByRole("button", { name: "Unpin" }));
  await waitFor(async () => expect(await pinOrder(wired)).toEqual(["p2"]));
  await waitFor(() => expect(toastMocks.success).toHaveBeenCalled());
  lastUndo()();
  await waitFor(async () => expect(await pinOrder(wired)).toEqual(["p1", "p2", "p3"]));
});

it("undoes a bulk Snooze by restoring the pin, its order and the earlier lifecycle row", async () => {
  const pinned = (id: string, key: string) => item(id, { isPinned: true, pinnedAt: 1, pinSortKey: key });
  const wired = await createWired([pinned("p1", "a"), pinned("p2", "b"), item("resumed")]);
  await wired.call("updateSidebarSettings", { autoSettleInactive: false });
  await wired.call("resume", { threadId: "resumed" });
  const resumedRow = ((await wired.call("listLifecycle")) as { rows: unknown[] }).rows;
  wired.mount();
  const bar = await select("Work p1", "Work resumed");
  fireEvent.keyDown(within(bar).getByRole("combobox", { name: "Snooze selected" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("option", { name: "1 hour" }));
  await waitFor(async () => expect(await pinOrder(wired)).toEqual(["p2"]));
  await waitFor(() => expect(toastMocks.success).toHaveBeenCalled());
  lastUndo()();
  await waitFor(async () => expect(await pinOrder(wired)).toEqual(["p1", "p2"]));
  expect(await wired.call("listLifecycle")).toEqual({ rows: resumedRow });
});

it("undoes a bulk Archive for the whole archived tree, children after their parent", async () => {
  const wired = await createWired([
    item("c", { parentThreadId: "p", title: "Child" }),
    item("old", { parentThreadId: "p", isArchived: true, archivedAt: 1 }),
    item("p"),
  ]);
  wired.mount();
  const bar = await select("Work p");
  fireEvent.click(within(bar).getByRole("button", { name: "Archive" }));
  await waitFor(async () => expect(await archivedAt(wired, "c")).not.toBeNull());
  await waitFor(() => expect(toastMocks.success).toHaveBeenCalled());
  lastUndo()();
  await waitFor(async () => expect(await archivedAt(wired, "c")).toBeNull());
  expect(await archivedAt(wired, "p")).toBeNull();
  expect(await archivedAt(wired, "old")).toBe(1);
});
