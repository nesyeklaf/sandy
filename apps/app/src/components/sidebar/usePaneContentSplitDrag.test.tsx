// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createStore } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { countPanes, listPanes } from "@/lib/split-layout";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import {
  createSinglePaneLayout,
  reconcileLayoutForContent,
} from "@/views/thread-detail/splitThreadNavigation";
import { beginSidebarPaneContentSplitDrag } from "./usePaneContentSplitDrag";

vi.mock("@/lib/thread-mention-drop", () => ({
  resolveThreadMentionDropTarget: () => null,
}));

const content = { kind: "thread" as const, projectId: "p", threadId: "B" };

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function dragRowIntoMain({
  openOnPress,
}: {
  openOnPress: boolean;
}) {
  const store = createStore();
  store.set(
    splitLayoutAtom,
    createSinglePaneLayout({ projectId: "p", threadId: "A" }),
  );
  const navigate = vi.fn();
  render(
    <>
      <aside data-sidebar="sidebar">
        <a
          href="#"
          onPointerDown={(event) => {
            beginSidebarPaneContentSplitDrag({
              event,
              store,
              navigate,
              content,
              label: "B",
            });
            if (openOnPress) {
              store.set(
                splitLayoutAtom,
                reconcileLayoutForContent(store.get(splitLayoutAtom), content),
              );
            }
          }}
        >
          Drag B
        </a>
      </aside>
      <main data-split-pane-id="pane-1" />
    </>,
  );
  const row = screen.getByRole("link", { name: "Drag B" });
  const main = document.querySelector("main")!;
  vi.spyOn(row.closest("aside")!, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 248, 800),
  );
  vi.spyOn(main, "getBoundingClientRect").mockReturnValue(
    new DOMRect(300, 0, 900, 800),
  );
  Object.defineProperty(document, "elementsFromPoint", {
    configurable: true,
    value: () => [main],
  });
  fireEvent.pointerDown(row, {
    pointerType: "mouse",
    button: 0,
    clientX: 20,
    clientY: 300,
  });
  fireEvent.pointerMove(window, { clientX: 1150, clientY: 400 });
  fireEvent.pointerUp(window, { clientX: 1150, clientY: 400 });
  return { store, navigate };
}

describe("beginSidebarPaneContentSplitDrag", () => {
  it.each([false, true])(
    "splits the dragged thread beside the open one when the press already opened it (openOnPress=%s)",
    (openOnPress) => {
      const { store } = dragRowIntoMain({ openOnPress });
      const layout = store.get(splitLayoutAtom)!;
      expect(countPanes(layout.root)).toBe(2);
      expect(
        listPanes(layout.root).map((pane) =>
          pane.content.kind === "thread" ? pane.content.threadId : null,
        ),
      ).toEqual(["A", "B"]);
      expect(layout.focusedPaneId).toBe(
        listPanes(layout.root).find(
          (pane) =>
            pane.content.kind === "thread" && pane.content.threadId === "B",
        )!.paneId,
      );
    },
  );
});
