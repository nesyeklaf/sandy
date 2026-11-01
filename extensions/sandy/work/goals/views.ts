// Plain values the app bundle needs. No imports, so the frontend build never pulls in the server SDK.

/** Banner lines and tab sections the user can switch off; all on by default (plugin settings). */
export const VIEWS = {
  showBanner: "Goal banner above the composer",
  bannerStatus: "Banner: status",
  bannerTitle: "Banner: goal title",
  bannerProgress: "Banner: task progress bar",
  bannerCurrentTask: "Banner: current task",
  bannerUsage: "Banner: time and tokens",
  bannerBudget: "Banner: budget",
  bannerMore: "Banner: +N more open goals",
  bannerBlocked: "Banner: blocked reason and suggestion",
  bannerControls: "Banner: pause and resume buttons",
  bannerSessionTasks: "Banner: session tasks when no goal is focused",
  bannerActivity: "Banner: the tool call running now, while the agent works",
  tabTasks: "Tab: task tree",
  tabSessionTasks: "Tab: session tasks when no goal is focused",
  tabCriteria: "Tab: completion criteria and evidence",
  tabAudit: "Tab: auditor result",
  tabActivity: "Tab: recent activity",
  tabPool: "Tab: all open goals",
  tabArchived: "Tab: archived goals",
} as const;
export type View = keyof typeof VIEWS;

export const COMMANDS = ["goal-pause", "goal-resume", "goal-unfocus", "goal-status", "goal-focus", "goal-clear"] as const;

/**
 * The slash command a button sends. Clear needs a goal id and passes --yes: the user confirmed in SANDY,
 * and pi's own dialog would never reach them (needs the pi-goal-x fork in pi/goal-x).
 */
export function commandText(command: (typeof COMMANDS)[number], arg?: string): string {
  if (command === "goal-clear") {
    if (!arg) throw new Error("goal-clear needs a goal id");
    return `/goal-clear ${arg} --yes`;
  }
  return arg ? `/${command} ${arg}` : `/${command}`;
}
