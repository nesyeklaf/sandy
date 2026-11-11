import { getSkillSelection, setSkillSelection } from "@sandy/db";
import {
  canonicalSkillSelection,
  isSkillNameEnabled,
  type SkillSelection,
} from "@sandy/domain";
import type { SkillSelectionView } from "@sandy/server-contract";
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
): SkillSelectionView {
  setSkillSelection(deps.db, canonicalSkillSelection(selection));
  deps.hub.notifySystem(["config-changed"]);
  return readSkillSelectionView(deps);
}

export function filterSourcesBySkillSelection<T extends { name: string }>(
  selection: SkillSelection,
  sources: readonly T[],
): T[] {
  return sources.filter((source) =>
    isSkillNameEnabled(selection, source.name),
  );
}
