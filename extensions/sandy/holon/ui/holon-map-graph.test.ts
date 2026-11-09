import type { ElkNode } from "elkjs/lib/elk-api";
import { describe, expect, it } from "vitest";
import type { MapHolon, MapOutput, MapSeam, SideLight } from "../core/outputs";
import {
  ancestorsOf,
  boxLight,
  buildElkGraph,
  bundleSeams,
  buildModel,
  commonContainer,
  fitViewport,
  holonForFile,
  keepAnchor,
  openForFocus,
  openToDepth,
  placeLayout,
  rep,
  shortenContract,
  toggled,
  visibleIds,
  zoomAt,
} from "./holon-map-graph";

function holon(id: string, parent: string | null, extra: Partial<MapHolon> = {}): MapHolon {
  return {
    id,
    kind: "container",
    title: id,
    status: "active",
    parent,
    file: `${id}.holon`,
    light: "open",
    sides: { I: "open", It: "open", We: "open", They: "open" },
    drift: [],
    driftBelow: 0,
    childCount: 0,
    carriedBy: [],
    ...extra,
  };
}

function seam(from: string, to: string, contract: string, extra: Partial<MapSeam> = {}): MapSeam {
  return { from, to, contract, light: "soft", readOnly: false, exclusive: false, drift: null, ...extra };
}

function output(holons: MapHolon[], seams: MapSeam[]): MapOutput {
  return { format: "holon-map/v0", holons, seams, warnings: [], computedAt: "2026-11-08T12:00:00Z", commit: "fixture" };
}

const holons = [
  holon("org", null, { childCount: 1 }),
  holon("shop", "org", { childCount: 3 }),
  holon("api", "shop", { childCount: 2 }),
  holon("handler", "api"),
  holon("auth", "api"),
  holon("db", "shop"),
  holon("web", "shop"),
  holon("alice", null),
];

const model = (seams: MapSeam[]) => buildModel(output(holons, seams));

describe("model", () => {
  it("keeps pre-order, nests children under their parent and treats an unknown parent as a root", () => {
    const built = buildModel(output([...holons, holon("lost", "gone")], []));
    expect(built.roots).toEqual(["org", "alice", "lost"]);
    expect(built.childrenOf.get("api")).toEqual(["handler", "auth"]);
    expect(visibleIds(built, new Set(["org", "shop"]))).toEqual(["org", "shop", "api", "db", "web", "alice", "lost"]);
  });

  it("drops seams whose end is not a holon of the model", () => {
    expect(model([seam("api", "db", "a"), seam("api", "ghost", "b")]).seams).toHaveLength(1);
  });
});

describe("opening", () => {
  it("opens the ancestors of the focus and not the focus itself", () => {
    const built = model([]);
    expect(ancestorsOf(built, "handler")).toEqual(["org", "shop", "api"]);
    expect([...openForFocus(built, "handler")]).toEqual(["org", "shop", "api"]);
    expect([...openForFocus(built, "org")]).toEqual([]);
  });

  it("treats a holon without parts as closed even when it is in the open set", () => {
    const built = model([]);
    expect(visibleIds(built, new Set(["org", "shop", "api", "handler"]))).toEqual(["org", "shop", "api", "handler", "auth", "db", "web", "alice"]);
  });

  it("toggles without mutating the old set and opens to a depth", () => {
    const open = new Set(["org"]);
    expect([...toggled(open, "shop")]).toEqual(["org", "shop"]);
    expect([...toggled(open, "org")]).toEqual([]);
    expect([...open]).toEqual(["org"]);
    expect([...openToDepth(model([]), 2)].sort()).toEqual(["org", "shop"]);
  });
});

describe("holonForFile", () => {
  it("matches a workspace path to the holon whose file ends it, longest first", () => {
    const model = buildModel(output([holon("a", null, { file: "a.holon" }), holon("b", null, { file: "x/a.holon" })], []));
    expect(holonForFile(model, "x/a.holon")).toBe("b");
    expect(holonForFile(model, "/work/repo/a.holon")).toBe("a");
    expect(holonForFile(model, "other.holon")).toBeNull();
  });
});

describe("rep", () => {
  it("is the nearest visible holon on the way down from the roots", () => {
    const built = model([]);
    expect(rep(built, new Set(["org", "shop", "api"]), "handler")).toBe("handler");
    expect(rep(built, new Set(["org", "shop"]), "handler")).toBe("api");
    expect(rep(built, new Set(), "handler")).toBe("org");
    expect(rep(built, new Set(["org"]), "org")).toBe("org");
  });
});

describe("bundleSeams", () => {
  const open = new Set(["org", "shop"]);

  it("attaches the seams of hidden parts to the visible box, counts them and drops the ones inside it", () => {
    const built = model([
      seam("handler", "db", "Writes rows"),
      seam("auth", "db", "Reads users"),
      seam("handler", "auth", "Calls auth"),
      seam("web", "api", "Calls the API"),
    ]);
    const bundles = bundleSeams(built, open);
    expect(bundles.map((bundle) => [bundle.from, bundle.to, bundle.count, bundle.label])).toEqual([
      ["api", "db", 2, "Writes rows +1"],
      ["web", "api", 1, "Calls the API"],
    ]);
  });

  it("shows the inner seam once the box is open and no longer attaches it to the box", () => {
    const built = model([seam("handler", "db", "Writes rows"), seam("handler", "auth", "Calls auth")]);
    const bundles = bundleSeams(built, new Set(["org", "shop", "api"]));
    expect(bundles.map((bundle) => `${bundle.from}>${bundle.to}`)).toEqual(["handler>db", "handler>auth"]);
  });

  it("dedupes equal contracts into one label and keeps the seam count", () => {
    const built = model([seam("handler", "db", "Writes rows. Locks first."), seam("auth", "db", "Writes rows")]);
    const [bundle] = bundleSeams(built, open);
    expect(bundle).toMatchObject({ count: 2, contracts: ["Writes rows"], label: "Writes rows" });
  });

  it("labels unlabelled bundles by their count and leaves single ones without label", () => {
    const built = model([seam("handler", "db", ""), seam("auth", "db", " "), seam("web", "db", "")]);
    const bundles = bundleSeams(built, open);
    expect(bundles.map((bundle) => bundle.label)).toEqual(["2 seams", ""]);
  });

  it("is red when any bundled seam drifts, takes the worst light and is read-only only when all are", () => {
    const built = model([
      seam("handler", "db", "a", { light: "hard", readOnly: true }),
      seam("auth", "db", "b", { light: "refuted", readOnly: true, drift: "contradiction" }),
    ]);
    const [bundle] = bundleSeams(built, open);
    expect(bundle).toMatchObject({ drift: true, light: "refuted", readOnly: true });
    const mixed = bundleSeams(model([seam("handler", "db", "a", { readOnly: true }), seam("auth", "db", "b")]), open);
    expect(mixed[0]).toMatchObject({ drift: false, readOnly: false });
  });

  it("skips seams between a box and its own part", () => {
    const built = model([seam("api", "handler", "Hosts")]);
    expect(bundleSeams(built, new Set(["org", "shop", "api"]))).toEqual([]);
  });
});

describe("shortenContract", () => {
  it("takes the first sentence and cuts long text with an ellipsis", () => {
    expect(shortenContract("Reads users. Never writes.")).toBe("Reads users");
    expect(shortenContract("Signs customers in and out, and is the only writer of password hashes.", 20)).toBe("Signs customers in…");
    expect(shortenContract("  spaced\n out  ")).toBe("spaced out");
  });
});

describe("side recolouring", () => {
  it("shows the overall light for All and the light of one side otherwise", () => {
    const item = holon("x", null, { light: "drift", sides: { I: "hard", It: "refuted", We: "claimed", They: "open" } as Record<"I" | "It" | "We" | "They", SideLight> });
    expect(boxLight(item, "All")).toBe("drift");
    expect(boxLight(item, "I")).toBe("hard");
    expect(boxLight(item, "It")).toBe("refuted");
    expect(boxLight(item, "They")).toBe("open");
  });
});

describe("elk graph", () => {
  it("contains only visible boxes and places each bundle in the common open container", () => {
    const built = model([seam("handler", "auth", "Calls auth"), seam("handler", "db", "Writes rows"), seam("web", "db", "Reads")]);
    const open = new Set(["org", "shop", "api"]);
    const root = buildElkGraph(built, open, bundleSeams(built, open));
    const ids = (node: ElkNode): string[] => [node.id, ...(node.children ?? []).flatMap(ids)];
    expect(ids(root)).toEqual(["__root", "org", "shop", "api", "handler", "auth", "db", "web", "alice"]);
    const find = (node: ElkNode, id: string): ElkNode | undefined => (node.id === id ? node : (node.children ?? []).map((child) => find(child, id)).find((hit) => hit !== undefined));
    expect(find(root, "api")!.edges!.map((edge) => edge.sources[0] + ">" + edge.targets[0])).toEqual(["handler>auth"]);
    expect(find(root, "shop")!.edges!.map((edge) => edge.sources[0] + ">" + edge.targets[0])).toEqual(["handler>db", "web>db"]);
    expect(find(root, "handler")!.width).toBeGreaterThan(100);
    expect(find(root, "api")!.width).toBeUndefined();
  });

  it("finds the common open container of two boxes", () => {
    const built = model([]);
    expect(commonContainer(built, new Set(["org", "shop", "api"]), "handler", "db")).toBe("shop");
    expect(commonContainer(built, new Set(["org", "shop", "api"]), "handler", "auth")).toBe("api");
    expect(commonContainer(built, new Set(["org", "shop"]), "org", "alice")).toBe("__root");
    expect(commonContainer(built, new Set(["org", "shop"]), "api", "alice")).toBe("__root");
  });
});

describe("placeLayout", () => {
  it("adds parent offsets to boxes and positions edges and labels in their container", () => {
    const result: ElkNode = {
      id: "__root",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      children: [
        {
          id: "shop",
          x: 20,
          y: 30,
          width: 300,
          height: 200,
          children: [{ id: "db", x: 10, y: 60, width: 100, height: 40 }],
          edges: [
            {
              id: "e0",
              sources: ["a"],
              targets: ["b"],
              container: "shop",
              sections: [{ id: "s", startPoint: { x: 1, y: 2 }, bendPoints: [{ x: 5, y: 2 }], endPoint: { x: 5, y: 9 } }],
              labels: [{ id: "l", text: "Writes", x: 7, y: 3, width: 40, height: 14 }],
            } as NonNullable<ElkNode["edges"]>[number],
          ],
        },
      ],
    };
    const placed = placeLayout(result);
    expect(placed.rects.get("db")).toMatchObject({ x: 30, y: 90, w: 100, h: 40, depth: 2 });
    expect(placed.width).toBe(400);
    expect(placed.edges[0]!.points).toEqual([{ x: 21, y: 32 }, { x: 25, y: 32 }, { x: 25, y: 39 }]);
    expect(placed.edges[0]!.label).toEqual({ text: "Writes", x: 27, y: 33, w: 40, h: 14 });
  });
});

describe("viewport", () => {
  const screenOf = (view: { x: number; y: number; k: number }, rect: { x: number; y: number }) => ({ x: view.x + rect.x * view.k, y: view.y + rect.y * view.k });

  it("keeps the clicked box where it was on screen after a relayout moved it", () => {
    const view = { x: 40, y: -10, k: 0.8 };
    const before = { x: 100, y: 50, w: 150, h: 60, depth: 1 };
    const after = { x: 260, y: 20, w: 150, h: 60, depth: 1 };
    expect(screenOf(keepAnchor(view, before, after), after)).toEqual(screenOf(view, before));
  });

  it("zooms around the cursor and clamps the zoom", () => {
    const view = { x: 10, y: 20, k: 1 };
    const zoomed = zoomAt(view, 2, 100, 100);
    expect(zoomed.k).toBe(2);
    const worldBefore = { x: (100 - view.x) / view.k, y: (100 - view.y) / view.k };
    expect(screenOf(zoomed, worldBefore)).toEqual({ x: 100, y: 100 });
    expect(zoomAt(view, 1000, 0, 0).k).toBe(3);
    expect(zoomAt(view, 0.0001, 0, 0).k).toBe(0.1);
  });

  it("fits a box into the view centred", () => {
    const fitted = fitViewport({ x: 100, y: 100, w: 400, h: 200, depth: 0 }, 824, 440);
    expect(fitted.k).toBeCloseTo(Math.min(800 / 400, 400 / 200, 1.3));
    const centre = screenOf(fitted, { x: 300, y: 200 });
    expect(centre.x).toBeCloseTo(412);
    expect(centre.y).toBeCloseTo(220);
    expect(fitViewport({ x: 0, y: 0, w: 0, h: 0, depth: 0 }, 800, 400)).toEqual({ x: 0, y: 0, k: 1 });
  });
});
