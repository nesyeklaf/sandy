import { useCallback } from "react";

/** How far the edge fade reaches once there is that much more to scroll. */
const FADE_PX = 12;

/**
 * T3 Code's sidebar scroll: no scrollbar, and an edge that fades out only on
 * a side with more content past it. The fade grows with the distance left to
 * scroll, up to FADE_PX, so a list resting at its top has a crisp top edge.
 *
 * Writes `--scroll-fade-top` and `--scroll-fade-bottom` on the scroller, read
 * by SCROLL_FADE_CLASS. Watch replacement children as well as their sizes:
 * loading and search swap whole shelf trees without replacing the scroller.
 */
export function useScrollFade<T extends HTMLElement>() {
  return useCallback((node: T | null) => {
    if (!node) return;
    const update = () => {
      const below = node.scrollHeight - node.clientHeight - node.scrollTop;
      node.style.setProperty("--scroll-fade-top", `${Math.min(Math.max(node.scrollTop, 0), FADE_PX)}px`);
      node.style.setProperty("--scroll-fade-bottom", `${Math.min(Math.max(below, 0), FADE_PX)}px`);
    };
    update();
    node.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    const observeSizes = () => {
      observer?.disconnect();
      observer?.observe(node);
      for (const child of Array.from(node.children)) observer?.observe(child);
    };
    observeSizes();
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => record.target === node && record.type === "childList")) observeSizes();
      update();
    });
    mutations.observe(node, { childList: true, characterData: true, subtree: true });
    return () => {
      node.removeEventListener("scroll", update);
      observer?.disconnect();
      mutations.disconnect();
    };
  }, []);
}

export const SCROLL_FADE_CLASS =
  "overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_bottom,transparent,black_var(--scroll-fade-top,0px),black_calc(100%-var(--scroll-fade-bottom,0px)),transparent)]";
