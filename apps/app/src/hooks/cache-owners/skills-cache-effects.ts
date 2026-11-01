import type { QueryClientArg } from "../cache-effect-types";
import {
  allProjectSkillsQueryKey,
  projectSkillsQueryKey,
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

export function invalidateProjectSkillsMutationQueries({
  projectId,
  queryClient,
}: ProjectSkillsInvalidationArg): void {
  invalidateQueryKeys({
    queryClient,
    queryKeys: [projectSkillsQueryKey(projectId)],
  });
}
