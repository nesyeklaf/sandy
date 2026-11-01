import type {
  ExperimentalThreadTocBand,
  ExperimentalThreadTocSelection,
} from "@sandy-sdk/plugin-sdk";

export const TOC_MAX_BAND_LANES = 3;

interface SeqTick {
  id: string;
  messageSeq: number;
}

export interface TickRange {
  start: number;
  end: number;
}

export function bandTickRange(
  ticks: readonly SeqTick[],
  band: Pick<ExperimentalThreadTocBand, "fromSeq" | "toSeq">,
): TickRange | null {
  if (ticks.length === 0) return null;
  let start = -1;
  let end = -1;
  ticks.forEach((tick, index) => {
    if (tick.messageSeq >= band.fromSeq && tick.messageSeq <= band.toSeq) {
      if (start < 0) start = index;
      end = index;
    }
  });
  if (start >= 0) return { start, end };
  const next = ticks.findIndex((tick) => tick.messageSeq >= band.fromSeq);
  const index = next >= 0 ? next : ticks.length - 1;
  return { start: index, end: index };
}

export function assignBandLanes(ranges: readonly TickRange[]): number[] {
  const lanes: number[] = [];
  ranges.forEach((range, index) => {
    const taken = new Set<number>();
    ranges.slice(0, index).forEach((other, otherIndex) => {
      if (other.start <= range.end && range.start <= other.end) {
        taken.add(lanes[otherIndex] ?? 0);
      }
    });
    let lane = 0;
    while (taken.has(lane) && lane < TOC_MAX_BAND_LANES - 1) lane += 1;
    lanes.push(lane);
  });
  return lanes;
}

export function selectionFromTicks({
  fromTickId,
  maxSeq,
  toTickId,
  userTicks,
}: {
  fromTickId: string;
  maxSeq: number;
  toTickId: string;
  userTicks: readonly SeqTick[];
}): ExperimentalThreadTocSelection | null {
  const first = userTicks.findIndex((tick) => tick.id === fromTickId);
  const second = userTicks.findIndex((tick) => tick.id === toTickId);
  if (first < 0 || second < 0) return null;
  const low = userTicks[Math.min(first, second)];
  const highIndex = Math.max(first, second);
  const high = userTicks[highIndex];
  if (!low || !high) return null;
  const following = userTicks[highIndex + 1];
  return {
    fromSeq: low.messageSeq,
    toSeq: following
      ? following.messageSeq - 1
      : Math.max(maxSeq, high.messageSeq),
  };
}

export function pickBandAtTick(
  ranges: readonly TickRange[],
  tickIndex: number,
): number | null {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestSpan = Number.POSITIVE_INFINITY;
  ranges.forEach((range, index) => {
    const distance =
      tickIndex < range.start
        ? range.start - tickIndex
        : tickIndex > range.end
          ? tickIndex - range.end
          : 0;
    const span = range.end - range.start;
    if (distance < bestDistance || (distance === bestDistance && span < bestSpan)) {
      best = index;
      bestDistance = distance;
      bestSpan = span;
    }
  });
  return best;
}
