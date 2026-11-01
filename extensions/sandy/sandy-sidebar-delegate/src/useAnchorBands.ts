import { useMemo } from "react";
import { anchorBands } from "./anchor-bands";
import type { TocBand } from "./toc-extension";
import { useAnchors } from "./useAnchors";

/** Marks for the thread TOC rail. */
export function useAnchorBands(threadId: string): readonly TocBand[] {
  const anchors = useAnchors(threadId);
  return useMemo(() => anchorBands(anchors), [anchors]);
}
