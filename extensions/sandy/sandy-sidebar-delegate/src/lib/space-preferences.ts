import { readStorageRaw } from "./storage-codec";
import { STORAGE_KEYS } from "./storage-keys";
import type { PreferenceCodec } from "./use-persisted-preference";

export const spaceExpansionCodec: PreferenceCodec<Set<string>> = {
  fallback: () => new Set(),
  decode: (stored) => {
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? new Set(parsed.filter((value): value is string => typeof value === "string")) : null;
  },
  encode: (value) => JSON.stringify([...value]),
};

export function expandedFromTreeCollapse(sectionIds: readonly string[], collapsed: ReadonlySet<string>): Set<string> {
  return new Set(sectionIds.filter((id) => !collapsed.has(id)));
}

function savedTreeCollapse(): ReadonlySet<string> | null {
  try {
    const parsed: unknown = JSON.parse(readStorageRaw(STORAGE_KEYS.treeCollapse.key) ?? "null");
    return Array.isArray(parsed) ? new Set(parsed.filter((value): value is string => typeof value === "string")) : null;
  } catch {
    return null;
  }
}

export function treeMigratingExpansionCodec(spaceKeys: readonly string[]): PreferenceCodec<Set<string>> {
  return {
    ...spaceExpansionCodec,
    fallback: () => {
      const collapsed = savedTreeCollapse();
      return collapsed === null ? new Set() : expandedFromTreeCollapse(spaceKeys, collapsed);
    },
  };
}
