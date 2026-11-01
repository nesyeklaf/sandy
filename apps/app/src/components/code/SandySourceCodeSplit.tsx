import { defineSplit } from "@/lib/define-split";
import { SourceLoadingSkeleton } from "./code-loading-skeletons";
import type { SandySourceCodeProps } from "./code-rendering";

export const SandySourceCodeSplit = defineSplit<SandySourceCodeProps>({
  id: "sandy-source-code",
  load: () => import("./SandySourceCode").then((module) => module.default),
  loading: () => <SourceLoadingSkeleton />,
  tier: "intent",
});
