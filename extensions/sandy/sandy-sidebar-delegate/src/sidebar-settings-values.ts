import { DEFAULT_INACTIVE_AFTER_HOURS } from "./inactive";
import { DEFAULT_SNOOZE_PRESET_CONFIG } from "./lifecycle";

export const CHILD_THREAD_SORT_FIELDS = ["created", "activity"] as const;
export type ChildThreadSortField = (typeof CHILD_THREAD_SORT_FIELDS)[number];
export const CHILD_THREAD_SORT_DIRECTIONS = ["ascending", "descending"] as const;
export type ChildThreadSortDirection = (typeof CHILD_THREAD_SORT_DIRECTIONS)[number];

export const CHILD_THREAD_ICON_STYLES = ["disc", "provider"] as const;
export type ChildThreadIconStyle = (typeof CHILD_THREAD_ICON_STYLES)[number];

export const THREAD_DENSITIES = ["auto", "comfortable", "compact", "dense"] as const;
export type ThreadDensity = (typeof THREAD_DENSITIES)[number];
export type RowDensity = Exclude<ThreadDensity, "auto">;
export const SHELF_DENSITIES = ["default", "comfortable", "compact", "dense"] as const;
export type ShelfDensity = (typeof SHELF_DENSITIES)[number];
export const DENSITY_SHELVES = ["pinned", "active", "working", "review", "inactive"] as const;
export type DensityShelf = (typeof DENSITY_SHELVES)[number];
export type ShelfDensities = Record<DensityShelf, ShelfDensity>;

const LEGACY_THREAD_DISPLAY_DENSITY: Record<string, ThreadDensity> = {
  full: "comfortable",
  "compact-working": "auto",
  "compact-all": "dense",
};

export const PROJECT_COLOR_DISPLAYS = ["all", "full", "grouped"] as const;
export type ProjectColorDisplay = (typeof PROJECT_COLOR_DISPLAYS)[number];

export interface ChildThreadSort {
  field: ChildThreadSortField;
  direction: ChildThreadSortDirection;
}

export interface SidebarSettingsValues {
  snoozePresets: string;
  inactiveThreadsEnabled: boolean;
  inactiveAfterHours: number;
  showRunningChildrenWhenCollapsed: boolean;
  /** Leave finished delegate children and workflow workers out of the thread list. */
  hideFinishedSubagents: boolean;
  autoSettleInactive: boolean;
  autoSettleAfterDays: number;
  autoSettleOnMerge: boolean;
  childSortField: ChildThreadSortField;
  childSortDirection: ChildThreadSortDirection;
  childIconStyle: ChildThreadIconStyle;
  /** How many lines each thread row takes; auto picks per thread. */
  threadDensity: ThreadDensity;
  /** Per-shelf density overrides; default follows threadDensity. */
  shelfDensities: ShelfDensities;
  /** Show only project icons on compact Active, Pinned, and Working cards. */
  compactProjectIconOnly: boolean;
  /** Below Comfortable: keep pinned threads as full cards. */
  keepPinnedThreadsFull: boolean;
  /** Below Comfortable: keep threads that just woke as full cards. */
  keepWokeThreadsFull: boolean;
  /**
   * Legacy switch that threadDensity replaced. Kept in step with it so an
   * older plugin version still reads the user's choice.
   */
  compactWorkingThreads: boolean;
  /** Experimental: move threads with live work to their own shelf. */
  workingShelf: boolean;
  /** Experimental: keep the shelves below Active docked to the bottom. */
  dockShelves: boolean;
  projectColorsEnabled: boolean;
  /** Where project stripes appear; enabled project names are always colored. */
  projectColorDisplay: ProjectColorDisplay;
}

export const DEFAULT_SIDEBAR_SETTINGS: SidebarSettingsValues = {
  snoozePresets: DEFAULT_SNOOZE_PRESET_CONFIG,
  inactiveThreadsEnabled: true,
  inactiveAfterHours: DEFAULT_INACTIVE_AFTER_HOURS,
  showRunningChildrenWhenCollapsed: true,
  hideFinishedSubagents: true,
  autoSettleInactive: true,
  autoSettleAfterDays: 3,
  autoSettleOnMerge: true,
  childSortField: "created",
  childSortDirection: "ascending",
  childIconStyle: "disc",
  threadDensity: "comfortable",
  shelfDensities: { pinned: "default", active: "default", working: "default", review: "default", inactive: "default" },
  compactProjectIconOnly: false,
  keepPinnedThreadsFull: false,
  keepWokeThreadsFull: false,
  compactWorkingThreads: false,
  workingShelf: false,
  dockShelves: false,
  projectColorsEnabled: false,
  projectColorDisplay: "all",
};

export function childThreadSortOf(settings: SidebarSettingsValues | null): ChildThreadSort {
  return {
    field: settings?.childSortField ?? DEFAULT_SIDEBAR_SETTINGS.childSortField,
    direction: settings?.childSortDirection ?? DEFAULT_SIDEBAR_SETTINGS.childSortDirection,
  };
}

type ChildThreadSettings = Pick<SidebarSettingsValues, "childSortField" | "childSortDirection" | "childIconStyle">;

function oneOf<const T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * The thread density from an untrusted record. Settings saved before density
 * carry the old threadDisplay choice or, older still, only the old switch;
 * both map onto a density here, once.
 */
export function threadDensityOf(value: {
  threadDensity?: unknown;
  threadDisplay?: unknown;
  compactWorkingThreads?: unknown;
}): ThreadDensity {
  if (THREAD_DENSITIES.includes(value.threadDensity as ThreadDensity)) return value.threadDensity as ThreadDensity;
  if (typeof value.threadDisplay === "string" && Object.hasOwn(LEGACY_THREAD_DISPLAY_DENSITY, value.threadDisplay)) {
    return LEGACY_THREAD_DISPLAY_DENSITY[value.threadDisplay]!;
  }
  return value.compactWorkingThreads === true ? "auto" : "comfortable";
}

export function shelfDensitiesOf(value: unknown): ShelfDensities {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    DENSITY_SHELVES.map((shelf) => [shelf, oneOf(SHELF_DENSITIES, record[shelf], "default")]),
  ) as ShelfDensities;
}

export function projectColorDisplayOf(value: unknown): ProjectColorDisplay {
  return oneOf(PROJECT_COLOR_DISPLAYS, value, DEFAULT_SIDEBAR_SETTINGS.projectColorDisplay);
}

/**
 * The child-thread settings from an untrusted record, such as a database row
 * or a cache written by an older version. Missing or unknown values fall back
 * to the defaults.
 */
export function childThreadSettingsOf(
  value: {
    [Key in keyof ChildThreadSettings]?: unknown;
  },
): ChildThreadSettings {
  return {
    childSortField: oneOf(CHILD_THREAD_SORT_FIELDS, value.childSortField, DEFAULT_SIDEBAR_SETTINGS.childSortField),
    childSortDirection: oneOf(
      CHILD_THREAD_SORT_DIRECTIONS,
      value.childSortDirection,
      DEFAULT_SIDEBAR_SETTINGS.childSortDirection,
    ),
    childIconStyle: oneOf(CHILD_THREAD_ICON_STYLES, value.childIconStyle, DEFAULT_SIDEBAR_SETTINGS.childIconStyle),
  };
}
