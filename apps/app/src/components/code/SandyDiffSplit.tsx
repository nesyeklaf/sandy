import { defineSplit } from "@/lib/define-split";
import { DiffLoadingSkeleton } from "@sandy/shared-ui/diff-loading-skeleton";
import type { SandyDiffProps } from "./code-rendering";

export const SandyDiffSplit = defineSplit<SandyDiffProps>({
  id: "sandy-diff",
  load: () => import("./SandyDiff").then((module) => module.default),
  loading: () => <DiffLoadingSkeleton />,
  tier: "intent",
});
