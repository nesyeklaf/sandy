import { useLayoutEffect, type RefObject } from "react";

export function useRowFocusHandoff(rowRef: RefObject<HTMLLIElement | null>, threadId: string) {
  useLayoutEffect(() => {
    return () => {
      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement) || !rowRef.current?.contains(focused)) return;
      const sidebar = rowRef.current.closest<HTMLElement>("[data-sandy-sidebar-root]");
      const childId = focused.getAttribute("data-child-thread-id");
      const control = focused.getAttribute("data-thread-control");
      queueMicrotask(() => {
        if (!sidebar?.isConnected || document.activeElement !== document.body) return;
        const replacement = [...sidebar.querySelectorAll<HTMLAnchorElement>("a[data-sidebar-thread-id]")].find(
          (link) => link.dataset.sidebarThreadId === threadId,
        );
        const row = replacement?.closest("li");
        const child =
          childId &&
          [...(row?.querySelectorAll<HTMLElement>("[data-child-thread-id]") ?? [])].find(
            (item) => item.dataset.childThreadId === childId,
          );
        const matchingControl =
          control &&
          [...(row?.querySelectorAll<HTMLElement>("[data-thread-control]") ?? [])].find(
            (item) => item.dataset.threadControl === control,
          );
        (child || matchingControl || replacement)?.focus();
      });
    };
  }, [rowRef, threadId]);
}
