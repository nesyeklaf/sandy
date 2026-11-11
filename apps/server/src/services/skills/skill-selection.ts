import {
  getSkillSelection,
  listRunningThreads,
  setSkillSelection,
} from "@sandy/db";
import {
  canonicalSkillSelection,
  isSkillNameEnabled,
  skillSelectionKey,
  type SkillSelection,
} from "@sandy/domain";
import type {
  SkillSelectionUpdateResult,
  SkillSelectionView,
} from "@sandy/server-contract";
import type { AppDeps } from "../../types.js";

type SkillSelectionReadDeps = Pick<AppDeps, "db" | "providerRegistry">;
type SkillSelectionWriteDeps = SkillSelectionReadDeps & Pick<AppDeps, "hub">;

export function readSkillSelection(deps: Pick<AppDeps, "db">): SkillSelection {
  return getSkillSelection(deps.db);
}

export function readSkillSelectionView(
  deps: SkillSelectionReadDeps,
): SkillSelectionView {
  return {
    selection: readSkillSelection(deps),
    providers: deps.providerRegistry
      .list()
      .map((registration) => ({
        providerId: registration.info.id,
        displayName: registration.info.displayName,
        support: registration.skillSelectionSupport,
      }))
      .sort((left, right) =>
        left.displayName.localeCompare(right.displayName),
      ),
  };
}

export function updateSkillSelection(
  deps: SkillSelectionWriteDeps,
  selection: SkillSelection,
): SkillSelectionUpdateResult {
  const next = canonicalSkillSelection(selection);
  const changed =
    skillSelectionKey(readSkillSelection(deps)) !== skillSelectionKey(next);
  setSkillSelection(deps.db, next);
  if (changed) deps.hub.notifySystem(["config-changed"]);
  return {
    ...readSkillSelectionView(deps),
    pendingThreadIds: changed
      ? listRunningThreads(deps.db).map((thread) => thread.id)
      : [],
  };
}

export function filterSourcesBySkillSelection<T extends { name: string }>(
  selection: SkillSelection,
  sources: readonly T[],
): T[] {
  return sources.filter((source) =>
    isSkillNameEnabled(selection, source.name),
  );
}
