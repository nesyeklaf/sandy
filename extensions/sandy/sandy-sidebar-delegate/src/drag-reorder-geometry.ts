import { type OrderUnit, movePinnedId } from "./pinned-order";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { sameOrder, type ReorderScope } from "./inbox-layout";
import type { createDragPreview } from "./drag-preview";
import type { ListAnimationController } from "./useListMotion";

export interface InboxDragOrder {
  shelf: "pinned" | "inbox";
  mode: "thread" | "unit";
  movingId: string;
  parentKey?: string | null;
  ids: string[];
}

export interface DragReorderOptions {
  key: string;
  shelf: "pinned" | "inbox";
  target: { isReordering: boolean };
  activeReorderCancelRef: RefObject<(() => void) | null>;
  dragOrderRef: RefObject<InboxDragOrder | null>;
  dragPreviewRef: RefObject<ReturnType<typeof createDragPreview> | null>;
  listAnimationController: ListAnimationController;
  suppressDragClick: (key: string) => void;
  reorderScopeRef: RefObject<(key: string, shelf: "pinned" | "inbox") => ReorderScope>;
  storedOrderUnitsRef: RefObject<OrderUnit[]>;
  setDragOrder: Dispatch<SetStateAction<InboxDragOrder | null>>;
  commitReorder: (
    shelf: "pinned" | "inbox",
    mode: "thread" | "unit",
    ids: readonly string[],
    key: string,
    parentKey?: string | null,
  ) => void;
}

export function createDragReorderGeometry(
  {
    shelf,
    key,
    dragOrderRef,
    reorderScopeRef,
    storedOrderUnitsRef,
    dragPreviewRef,
    setDragOrder,
  }: Pick<
    DragReorderOptions,
    "shelf" | "key" | "dragOrderRef" | "reorderScopeRef" | "storedOrderUnitsRef" | "dragPreviewRef" | "setDragOrder"
  >,
  readState: () => { scrollContainer: HTMLElement | null; listElement: HTMLElement | null },
  position: { resolvedY: number; reorderDirection: number },
) {
  return function reorderAt(clientX: number, clientY: number) {
    const { scrollContainer, listElement } = readState();
    const current = dragOrderRef.current;
    if (!current || current.shelf !== shelf) return;
    // Content coordinates include auto-scroll. Keep the last direction
    // when the pointer is stationary: a tall neighbour can occupy the
    // cursor after a swap, but must not swap back without a reversal.
    const contentY = clientY + (scrollContainer?.scrollTop ?? 0);
    if (contentY !== position.resolvedY) position.reorderDirection = Math.sign(contentY - position.resolvedY);
    position.resolvedY = contentY;
    const visibleIds = reorderScopeRef.current(key, shelf).ids;
    const hit = document.elementFromPoint(clientX, clientY);
    const hitRow = hit instanceof Element ? hit.closest("li") : null;
    // A whole project is one target among the top-level units; inside
    // a project's own drag, its header is not a row at all.
    let unitRow = hit instanceof Element ? hit.closest<HTMLElement>("[data-reorder-unit]") : null;
    while (unitRow && !visibleIds.includes(unitRow.dataset.reorderUnit ?? "")) {
      unitRow = unitRow.parentElement?.closest<HTMLElement>("[data-reorder-unit]") ?? null;
    }
    const row =
      current.mode === "unit" ? (unitRow ?? hitRow) : hitRow?.hasAttribute("data-reorder-unit") ? null : hitRow;
    const targetThreadId = row
      ?.querySelector<HTMLAnchorElement>("[data-sidebar-thread-id]")
      ?.getAttribute("data-sidebar-thread-id");
    const targetId =
      current.mode === "unit" && unitRow
        ? unitRow.getAttribute("data-reorder-unit")
        : current.mode === "unit"
          ? storedOrderUnitsRef.current.find(
              (unit) => visibleIds.includes(unit.key) && !!targetThreadId && unit.ids.includes(targetThreadId),
            )?.key
          : targetThreadId;

    let nextIds: string[] | null = null;
    if (row && targetId && visibleIds.includes(targetId) && current.movingId !== targetId) {
      const targetDirection = Math.sign(current.ids.indexOf(targetId) - current.ids.indexOf(current.movingId));
      if (targetDirection === position.reorderDirection) {
        nextIds = movePinnedId(current.ids, current.movingId, targetId, targetDirection < 0 ? "before" : "after");
      }
    } else if (!targetId && listElement) {
      // Headers, padding and the run-off below the last row are not rows,
      // so hit-testing alone strands a drag aimed at either end of a
      // shelf. Resolve those against the list box instead — but only
      // directly above or below it, or a pointer parked off to the side
      // of the sidebar would keep snapping the row to an end.
      const listRect = listElement.getBoundingClientRect();
      const within = clientX >= listRect.left && clientX <= listRect.right;
      const before = within && clientY < listRect.top && position.reorderDirection < 0;
      const after = within && clientY > listRect.bottom && position.reorderDirection > 0;
      const edgeId = before
        ? current.ids.find((id) => id !== current.movingId)
        : after
          ? [...current.ids].reverse().find((id) => id !== current.movingId)
          : undefined;
      if (edgeId) {
        nextIds = movePinnedId(current.ids, current.movingId, edgeId, before ? "before" : "after");
      }
    }

    if (!nextIds || sameOrder(nextIds, current.ids)) return;
    dragPreviewRef.current?.capture();
    const next = { ...current, ids: nextIds };
    dragOrderRef.current = next;
    setDragOrder(next);
  };
}
