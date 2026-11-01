import type { Anchor } from "./anchors-contract";
import type { TocBand } from "./toc-extension";

const HUE: Record<Anchor["kind"], number> = { note: 80, comment: 250, tag: 150, link: 300, bookmark: 80 };

/** One rail mark per message seq and kind, coloured like its card. */
export function anchorBands(anchors: readonly Anchor[]): TocBand[] {
  const seen = new Set<string>();
  const bands: TocBand[] = [];
  for (const anchor of anchors) {
    if (anchor.seq === null) continue;
    const key = anchor.seq + ":" + anchor.kind;
    if (seen.has(key)) continue;
    seen.add(key);
    bands.push({
      fromSeq: anchor.seq,
      toSeq: anchor.seq,
      hue: HUE[anchor.kind],
      label: anchor.body !== "" ? anchor.body.slice(0, 60) : anchor.kind,
    });
  }
  return bands;
}
