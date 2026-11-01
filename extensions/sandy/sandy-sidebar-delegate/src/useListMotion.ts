import { createContext, useCallback, useContext } from "react";
import type { createListAnimationController } from "./lib/list-motion";

export { createListAnimationController } from "./lib/list-motion";

export type ListAnimationController = ReturnType<typeof createListAnimationController>;
export const ListAnimationContext = createContext<ListAnimationController | null>(null);

export function useListMotion<T extends HTMLElement>(owner?: ListAnimationController) {
  const inherited = useContext(ListAnimationContext);
  const controller = owner ?? inherited;
  if (!controller) throw new Error("List animations require an inbox controller");
  return useCallback(
    (node: T | null) => {
      if (!node || !controller.enabled || typeof window.matchMedia !== "function" || typeof node.animate !== "function")
        return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      return controller.register(node);
    },
    [controller],
  );
}
