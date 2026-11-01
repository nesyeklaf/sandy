import type { ComponentProps } from "react";
import { SidebarVisibilityCustomize as SharedSidebarVisibilityCustomize } from "@sandy/shared-ui/sidebar-visibility-customize";
import { SidebarTouchSensor } from "./sidebarTouchSensor";

export function SidebarVisibilityCustomize(
  props: Omit<
    ComponentProps<typeof SharedSidebarVisibilityCustomize>,
    "touchSensor"
  >,
) {
  return (
    <SharedSidebarVisibilityCustomize
      {...props}
      touchSensor={SidebarTouchSensor}
    />
  );
}
