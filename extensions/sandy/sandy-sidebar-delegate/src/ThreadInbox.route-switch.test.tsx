// @vitest-environment jsdom
import { Profiler, createElement } from "react";
import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginSdkApp, PluginThreadListProps } from "@sandy-sdk/plugin-sdk/app";

const commits = vi.hoisted(() => ({
  cards: new Map<string, number>(),
  views: { count: 0 },
}));

vi.mock("./ThreadCard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ThreadCard")>();
  const Card = actual.ThreadCard;
  return {
    ...actual,
    ThreadCard: (props: Parameters<typeof Card>[0]) =>
      createElement(
        Profiler,
        {
          id: props.thread.id,
          onRender: (id: string) => commits.cards.set(id, (commits.cards.get(id) ?? 0) + 1),
        },
        createElement(Card, props),
      ),
  };
});

vi.mock("./ThreadInboxView", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ThreadInboxView")>();
  const View = actual.ThreadInboxView;
  return {
    ...actual,
    ThreadInboxView: (props: Parameters<typeof View>[0]) => {
      commits.views.count += 1;
      return createElement(View, props);
    },
  };
});

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

const testInbox = await import("./test-inbox");
const { listProps, loadInboxApp, render, thread } = testInbox;

await loadInboxApp();

const THREAD_COUNT = 24;
const THREADS = Array.from({ length: THREAD_COUNT }, (_, index) =>
  thread({
    id: `thr_${String(index).padStart(2, "0")}`,
    title: `Thread ${index}`,
    updatedAt: 1000 - index,
    createdAt: 1000 - index,
    latestAttentionAt: 1000 - index,
  }),
);

const runtime = (globalThis as typeof globalThis & { __sandyPluginRuntime: { pluginSdkApp: PluginSdkApp } })
  .__sandyPluginRuntime.pluginSdkApp;
const fakeUseSidebarThreads = runtime.experimental_useSidebarThreads;

afterEach(() => {
  runtime.experimental_useSidebarThreads = fakeUseSidebarThreads;
});

function propsFor(activeThreadId: string): PluginThreadListProps {
  return { ...listProps, activeThreadId };
}

const PROJECTS = [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }];

function freshHostState(threads: typeof THREADS) {
  return {
    status: "ready" as const,
    threads: [...threads],
    projects: PROJECTS.map((project) => ({ ...project })),
    sections: [],
    experimental_hosts: [],
    experimental_archived: null,
  };
}

describe("switching the open thread", () => {
  it("renders only the previous and the new row, and the list body once", async () => {
    let hostState = freshHostState(THREADS);
    runtime.experimental_useSidebarThreads = () => hostState;
    const slot = render(THREADS);
    const Component = testInbox.inbox.component;
    act(() => slot.lifecycle.rerender(<Component {...propsFor("thr_03")} />));
    await screen.findByText("Thread 0");
    await act(async () => undefined);
    expect(commits.cards.size).toBeGreaterThanOrEqual(20);

    for (const [from, to] of [
      ["thr_03", "thr_07"],
      ["thr_07", "thr_11"],
      ["thr_11", "thr_02"],
    ]) {
      commits.cards.clear();
      commits.views.count = 0;
      hostState = freshHostState(THREADS);
      act(() => slot.lifecycle.rerender(<Component {...propsFor(to)} />));
      expect([...commits.cards.keys()].sort()).toEqual([from, to].sort());
      expect(commits.views.count).toBeLessThanOrEqual(1);
    }
  });
});
