// The thread header button has no replacement slot in the current SDK (a thread action is a menu
// entry, not a component), but the host still mounts `experimental_threadHeaderAction` and
// `useSandyNavigate().openThreadPanel` for plugins built against older SDKs. These types stand in
// for the removed declarations.
import type { ComponentType } from "react";
import type { PluginAppSlots, SandyNavigate } from "@sandy-sdk/plugin-sdk/app";

export interface LegacyHeaderActionProps {
  threadId: string;
  projectId: string;
  isCompactViewport: boolean;
}

export type LegacyNavigate = SandyNavigate & {
  openThreadPanel(options: { actionId: string }): boolean;
};

export function registerHeaderAction(
  slots: PluginAppSlots,
  registration: { id: string; title: string; component: ComponentType<LegacyHeaderActionProps> },
): void {
  (slots as unknown as { experimental_threadHeaderAction(r: typeof registration): void })
    .experimental_threadHeaderAction(registration);
}
