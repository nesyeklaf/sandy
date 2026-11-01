import { describe, expect, it } from "vitest";
import { anchorBands } from "./anchor-bands";
import type { Anchor } from "./anchors-contract";

const make = (patch: Partial<Anchor>): Anchor => ({
  id: "a",
  threadId: "t",
  kind: "note",
  messageId: "m",
  seq: 3,
  quote: "",
  offset: null,
  body: "",
  tags: [],
  targetId: null,
  author: "user",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

describe("anchorBands", () => {
  it("draws one mark per message and kind, coloured by kind", () => {
    const bands = anchorBands([
      make({ id: "1", body: "first" }),
      make({ id: "2", body: "second" }),
      make({ id: "3", kind: "comment" }),
      make({ id: "4", seq: null }),
    ]);
    expect(bands.map((band) => [band.fromSeq, band.toSeq, band.hue])).toEqual([
      [3, 3, 80],
      [3, 3, 250],
    ]);
    expect(bands[1]?.label).toBe("comment");
  });
});
