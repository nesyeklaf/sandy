import { describe, expect, it } from "vitest";
import { readGallerySpec } from "./data-source";
import { examplesReport } from "./examples";

describe("examplesReport", () => {
  it.each(["Card-holon.ui", "Card-seam.ui", "Card-drift.ui"])("returns %s for Card", async (name) => {
    const report = await examplesReport(["Card"]);
    expect(report.ok).toBe(true);
    expect(report.text).toContain((await readGallerySpec(name)).trimEnd());
  });

  it("keeps the plain Card example first", async () => {
    const report = await examplesReport(["Card"]);
    expect(report.text.indexOf((await readGallerySpec("Card.ui")).trimEnd())).toBeGreaterThan(-1);
    expect(report.text.indexOf((await readGallerySpec("Card.ui")).trimEnd())).toBeLessThan(report.text.indexOf((await readGallerySpec("Card-seam.ui")).trimEnd()));
  });
});
