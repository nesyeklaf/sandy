import type {
  SkillSelectionUpdateResult,
  SkillSelectionView,
} from "@sandy/server-contract";
import type { QueryClientArg } from "../cache-effect-types";
import {
  allProjectSkillsQueryKey,
  projectSkillsQueryKey,
  skillSelectionQueryKey,
} from "../queries/query-keys";
import { invalidateQueryKeys } from "./cache-effect-utils";

interface ProjectSkillsInvalidationArg extends QueryClientArg {
  projectId: string;
}

export function invalidateAllProjectSkillsQueries({
  queryClient,
}: QueryClientArg): void {
  invalidateQueryKeys({ queryClient, queryKeys: [allProjectSkillsQueryKey()] });
}

interface ApplySkillSelectionMutationResultArg extends QueryClientArg {
  result: SkillSelectionUpdateResult;
}

export function applySkillSelectionMutationResult({
  queryClient,
  result,
}: ApplySkillSelectionMutationResultArg): void {
  queryClient.setQueryData<SkillSelectionView>(skillSelectionQueryKey(), {
    selection: result.selection,
    providers: result.providers,
  });
  invalidateAllProjectSkillsQueries({ queryClient });
}

export function invalidateProjectSkillsMutationQueries({
  projectId,
  queryClient,
}: ProjectSkillsInvalidationArg): void {
  invalidateQueryKeys({
    queryClient,
    queryKeys: [projectSkillsQueryKey(projectId)],
  });
}
