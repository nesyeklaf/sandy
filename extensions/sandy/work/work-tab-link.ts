// The one Work tab and the section a part asks it to show. Parts open the tab through useOpenWork
// instead of their own tabs; the section travels as the tab's target, which the tab reads once.
import { experimental_useAppPanel } from "@sandy-sdk/plugin-sdk/app";

export const WORK_SECTIONS = ["goal", "stage", "delegates", "workflows"] as const;
export type WorkSection = (typeof WORK_SECTIONS)[number];

function isWorkSection(value: unknown): value is WorkSection {
  return typeof value === "string" && (WORK_SECTIONS as readonly string[]).includes(value);
}

export const WORK_TAB = {
  id: "work",
  context: { kind: "thread" },
  availability: "fixed",
  experimental_target: { validate: isWorkSection },
} as const;

/** Opens the Work tab of the current thread view on that section. */
export function useOpenWork(): (section: WorkSection) => void {
  const panel = experimental_useAppPanel();
  return (section) => {
    panel.openTab({ tab: WORK_TAB, target: section });
  };
}
