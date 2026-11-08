import { describe, expect, it } from "vitest";
import { compile, dataKey, evaluate, initialState, type LoadedData } from "./core";
import type { Value } from "./core/types";
import { loadGalleryFile, readGallerySpec } from "./data-source";

const VIEW_PATH = "data/holon/view-account.json";

const TONE: Record<string, string> = { hard: "good", soft: "info", claimed: "neutral", open: "neutral", refuted: "bad", expired: "warn", drift: "warn" };

function badges(value: unknown, found: { text: unknown; tone: unknown }[] = []): { text: unknown; tone: unknown }[] {
  if (Array.isArray(value)) value.forEach((entry) => badges(entry, found));
  else if (typeof value === "object" && value !== null) {
    const node = value as { kind?: string; type?: string; props?: Record<string, unknown> };
    if (node.kind === "node" && node.type === "Badge") found.push({ text: node.props?.text ?? node.props?.label, tone: node.props?.tone });
    Object.values(node.props ?? {}).forEach((entry) => badges(entry, found));
  }
  return found;
}

async function seamBadges(light: string, drift: string | null): Promise<{ text: unknown; tone: unknown }[]> {
  const loaded = await loadGalleryFile(VIEW_PATH, { raw: false });
  if (!loaded.ok) throw new Error("view-account.json missing");
  const view = structuredClone(loaded.value) as { seams: Record<string, unknown>[] };
  view.seams = [{ ...view.seams[0], light, drift }];
  const result = compile(await readGallerySpec("Card-seam.ui"));
  const data = new Map<string, LoadedData>([[dataKey({ path: VIEW_PATH, raw: false }), { ok: true, value: view as unknown as Value } as LoadedData]]);
  const evaluated = evaluate(result.program!, initialState(result.program!, data), data);
  return badges(evaluated.roots);
}

describe("Card-seam", () => {
  it.each(Object.keys(TONE))("tones a %s seam by its light", async (light) => {
    const found = await seamBadges(light, null);
    expect(found).toHaveLength(1);
    expect(found[0].tone).toBe(TONE[light]);
  });

  it("keeps the light's tone when the seam also drifts", async () => {
    const found = await seamBadges("hard", "contradiction");
    expect(found[0].tone).toBe("good");
  });
});
