import { useRequirePierreWorkerPool } from "@/lib/pierre-worker-pool-gate";
import { useEffect } from "react";
import { SandyDiffSplit } from "./SandyDiffSplit";
import { SandySourceCodeSplit } from "./SandySourceCodeSplit";
import {
  useDiffRendererReplacement,
  useSourceCodeRendererReplacement,
} from "./codeRendererProvider";

export function useDiffRendererLoad(): void {
  const builtin = useDiffRendererReplacement().kind === "owner";
  useRequirePierreWorkerPool(builtin);
  useEffect(() => {
    if (builtin) void SandyDiffSplit.preload();
  }, [builtin]);
}

export function useSourceCodeRendererLoad(): void {
  const builtin = useSourceCodeRendererReplacement().kind === "owner";
  useRequirePierreWorkerPool(builtin);
  useEffect(() => {
    if (builtin) void SandySourceCodeSplit.preload();
  }, [builtin]);
}
