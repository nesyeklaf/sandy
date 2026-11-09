import type { ElkNode } from "elkjs/lib/elk-api";
import type { HolonLight, MapHolon, MapOutput, MapSeam, Side, SideLight } from "../core/outputs";

export type SideFilter = "All" | Side;
export type Light = HolonLight | SideLight;
export type OpenSet = ReadonlySet<string>;

export interface MapModel {
  holons: ReadonlyMap<string, MapHolon>;
  childrenOf: ReadonlyMap<string, readonly string[]>;
  roots: readonly string[];
  seams: readonly MapSeam[];
}

export interface BundledSeam {
  key: string;
  from: string;
  to: string;
  count: number;
  contracts: string[];
  label: string;
  light: SideLight;
  drift: boolean;
  readOnly: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface PlacedEdge {
  id: string;
  points: Point[];
  label: { text: string; x: number; y: number; w: number; h: number } | null;
}

export interface PlacedLayout {
  rects: ReadonlyMap<string, Rect>;
  edges: PlacedEdge[];
  width: number;
  height: number;
}

export interface Viewport {
  x: number;
  y: number;
  k: number;
}

const SEVERITY: Record<Light, number> = { refuted: 5, drift: 5, expired: 4, open: 3, claimed: 2, soft: 1, hard: 0 };

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 3;
export const LABEL_LENGTH = 34;

export function buildModel(map: MapOutput): MapModel {
  const holons = new Map<string, MapHolon>();
  for (const holon of map.holons) holons.set(holon.id, holon);
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const holon of map.holons) {
    if (holon.parent !== null && holons.has(holon.parent) && holon.parent !== holon.id) {
      const siblings = childrenOf.get(holon.parent);
      if (siblings === undefined) childrenOf.set(holon.parent, [holon.id]);
      else siblings.push(holon.id);
    } else roots.push(holon.id);
  }
  return { holons, childrenOf, roots, seams: map.seams.filter((seam) => holons.has(seam.from) && holons.has(seam.to)) };
}

export function holonForFile(model: MapModel, path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  let best: MapHolon | null = null;
  for (const holon of model.holons.values()) {
    const matches = normalized === holon.file || normalized.endsWith(`/${holon.file}`);
    if (matches && (best === null || holon.file.length > best.file.length)) best = holon;
  }
  return best?.id ?? null;
}

export function childrenIds(model: MapModel, id: string): readonly string[] {
  return model.childrenOf.get(id) ?? [];
}

export function chainOf(model: MapModel, id: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: MapHolon | undefined = model.holons.get(id);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current.id);
    current = current.parent === null ? undefined : model.holons.get(current.parent);
  }
  return chain;
}

export function ancestorsOf(model: MapModel, id: string): string[] {
  return chainOf(model, id).slice(0, -1);
}

export function isOpen(model: MapModel, open: OpenSet, id: string): boolean {
  return open.has(id) && childrenIds(model, id).length > 0;
}

export function openForFocus(model: MapModel, id: string): Set<string> {
  return new Set(ancestorsOf(model, id));
}

export function toggled(open: OpenSet, id: string): Set<string> {
  const next = new Set(open);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function openToDepth(model: MapModel, depth: number): Set<string> {
  const open = new Set<string>();
  const walk = (id: string, level: number): void => {
    const children = childrenIds(model, id);
    if (children.length === 0 || level >= depth) return;
    open.add(id);
    for (const child of children) walk(child, level + 1);
  };
  for (const root of model.roots) walk(root, 0);
  return open;
}

export function rep(model: MapModel, open: OpenSet, id: string): string {
  for (const ancestor of chainOf(model, id)) {
    if (ancestor === id || !isOpen(model, open, ancestor)) return ancestor;
  }
  return id;
}

function isWithin(model: MapModel, id: string, ancestor: string): boolean {
  return id !== ancestor && chainOf(model, id).includes(ancestor);
}

export function visibleIds(model: MapModel, open: OpenSet): string[] {
  const visible: string[] = [];
  const walk = (id: string): void => {
    visible.push(id);
    if (isOpen(model, open, id)) for (const child of childrenIds(model, id)) walk(child);
  };
  for (const root of model.roots) walk(root);
  return visible;
}

export function shortenContract(contract: string, max: number = LABEL_LENGTH): string {
  const flat = contract.replace(/\s+/g, " ").trim();
  const sentence = flat.split(/(?<=[.;:!?])\s/, 1)[0] ?? flat;
  const text = sentence.replace(/[.;:]$/, "");
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function worstLight(lights: readonly SideLight[]): SideLight {
  let worst: SideLight = "hard";
  for (const light of lights) if (SEVERITY[light] > SEVERITY[worst]) worst = light;
  return worst;
}

export function bundleSeams(model: MapModel, open: OpenSet): BundledSeam[] {
  const groups = new Map<string, { from: string; to: string; seams: MapSeam[] }>();
  for (const seam of model.seams) {
    const from = rep(model, open, seam.from);
    const to = rep(model, open, seam.to);
    if (from === to || isWithin(model, from, to) || isWithin(model, to, from)) continue;
    const key = `${from}>${to}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { from, to, seams: [seam] });
    else group.seams.push(seam);
  }
  const bundles: BundledSeam[] = [];
  for (const [key, group] of groups) {
    const contracts = [...new Set(group.seams.map((seam) => shortenContract(seam.contract)).filter((text) => text !== ""))];
    const extra = contracts.length - 1;
    const label = contracts.length === 0 ? (group.seams.length > 1 ? `${group.seams.length} seams` : "") : `${contracts[0]}${extra > 0 ? ` +${extra}` : ""}`;
    bundles.push({
      key,
      from: group.from,
      to: group.to,
      count: group.seams.length,
      contracts,
      label,
      light: worstLight(group.seams.map((seam) => seam.light)),
      drift: group.seams.some((seam) => seam.drift !== null),
      readOnly: group.seams.every((seam) => seam.readOnly),
    });
  }
  return bundles;
}

export function boxLight(holon: MapHolon, side: SideFilter): Light {
  return side === "All" ? holon.light : holon.sides[side];
}

export function titleLines(title: string, width: number = 24, maxLines: number = 3): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of title.split(/\s+/).filter((item) => item !== "")) {
    if (current !== "" && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else current = current === "" ? word : `${current} ${word}`;
  }
  if (current !== "") lines.push(current);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]!.slice(0, Math.max(1, width - 1))}…`;
    return kept;
  }
  return lines.length === 0 ? [""] : lines;
}

export function leafSize(holon: MapHolon): { w: number; h: number } {
  const lines = titleLines(holon.title);
  const longest = Math.max(...lines.map((line) => line.length), `${holon.kind} · ${holon.status}`.length * 0.85);
  return { w: Math.round(Math.min(260, Math.max(180, longest * 7.4 + 70))), h: 44 + lines.length * 17 };
}

export function openMinWidth(holon: MapHolon): number {
  return Math.round(Math.min(420, holon.title.length * 7.8 + 160));
}

const ROOT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.spacing.nodeNodeBetweenLayers": "46",
  "elk.spacing.nodeNode": "26",
  "elk.spacing.edgeNode": "14",
  "elk.spacing.edgeEdge": "10",
  "elk.layered.spacing.edgeNodeBetweenLayers": "14",
  "elk.edgeLabels.inline": "false",
  "elk.spacing.edgeLabel": "3",
  "elk.padding": "[top=20,left=20,bottom=20,right=20]",
};

export const ROOT_ID = "__root";

export function buildElkGraph(model: MapModel, open: OpenSet, bundles: readonly BundledSeam[]): ElkNode {
  const byId = new Map<string, ElkNode>();
  const make = (id: string): ElkNode => {
    const holon = model.holons.get(id)!;
    let node: ElkNode;
    if (isOpen(model, open, id)) {
      node = {
        id,
        children: childrenIds(model, id).map(make),
        edges: [],
        layoutOptions: {
          "elk.padding": "[top=58,left=16,bottom=16,right=16]",
          "elk.nodeSize.constraints": "[MINIMUM_SIZE]",
          "elk.nodeSize.minimum": `(${openMinWidth(holon)},90)`,
        },
      };
    } else {
      const size = leafSize(holon);
      node = { id, width: size.w, height: size.h };
    }
    byId.set(id, node);
    return node;
  };
  const root: ElkNode = { id: ROOT_ID, layoutOptions: ROOT_OPTIONS, children: model.roots.map(make), edges: [] };
  byId.set(ROOT_ID, root);
  bundles.forEach((bundle, index) => {
    const edge: NonNullable<ElkNode["edges"]>[number] = { id: `e${index}`, sources: [bundle.from], targets: [bundle.to] };
    if (bundle.label !== "") edge.labels = [{ id: `e${index}l`, text: bundle.label, width: Math.round(bundle.label.length * 6.3 + 8), height: 14 }];
    const owner = byId.get(commonContainer(model, open, bundle.from, bundle.to)) ?? root;
    owner.edges!.push(edge);
  });
  return root;
}

export function commonContainer(model: MapModel, open: OpenSet, a: string, b: string): string {
  const chainA = chainOf(model, a);
  const chainB = chainOf(model, b);
  let common: string = ROOT_ID;
  for (let index = 0; index < Math.min(chainA.length, chainB.length); index++) {
    if (chainA[index] !== chainB[index]) break;
    if (chainA[index] !== a && chainA[index] !== b && isOpen(model, open, chainA[index]!)) common = chainA[index]!;
  }
  return common;
}

export function placeLayout(result: ElkNode): PlacedLayout {
  const rects = new Map<string, Rect>();
  const edges: PlacedEdge[] = [];
  const walk = (node: ElkNode, ox: number, oy: number, depth: number): void => {
    const x = (node.x ?? 0) + ox;
    const y = (node.y ?? 0) + oy;
    rects.set(node.id, { x, y, w: node.width ?? 0, h: node.height ?? 0, depth });
    for (const edge of node.edges ?? []) {
      const container = (edge as { container?: string }).container;
      const base = container === undefined ? { x, y } : (rects.get(container) ?? { x, y });
      const points: Point[] = [];
      for (const section of edge.sections ?? []) {
        for (const point of [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]) points.push({ x: point.x + base.x, y: point.y + base.y });
      }
      const label = edge.labels?.[0];
      edges.push({
        id: edge.id,
        points,
        label: label === undefined ? null : { text: label.text ?? "", x: (label.x ?? 0) + base.x, y: (label.y ?? 0) + base.y, w: label.width ?? 0, h: label.height ?? 0 },
      });
    }
    for (const child of node.children ?? []) walk(child, x, y, depth + 1);
  };
  walk(result, 0, 0, 0);
  const rootRect = rects.get(ROOT_ID);
  return { rects, edges, width: rootRect?.w ?? 0, height: rootRect?.h ?? 0 };
}

export function fitTargetId(model: MapModel, open: OpenSet, id: string | null): string {
  if (id === null) return ROOT_ID;
  const parent = model.holons.get(rep(model, open, id))?.parent ?? null;
  return parent !== null && model.holons.has(parent) ? parent : ROOT_ID;
}

export function fitViewport(box: Rect, width: number, height: number, maxZoom: number = 1.3): Viewport {
  if (width <= 0 || height <= 0 || box.w <= 0 || box.h <= 0) return { x: 0, y: 0, k: 1 };
  const k = clampZoom(Math.min((width - 24) / box.w, (height - 40) / box.h, maxZoom));
  return { k, x: (width - box.w * k) / 2 - box.x * k, y: (height - box.h * k) / 2 - box.y * k };
}

export function clampZoom(k: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, k));
}

export function zoomAt(view: Viewport, factor: number, cx: number, cy: number): Viewport {
  const k = clampZoom(view.k * factor);
  const ratio = k / view.k;
  return { k, x: cx - (cx - view.x) * ratio, y: cy - (cy - view.y) * ratio };
}

export function keepAnchor(view: Viewport, before: Rect, after: Rect): Viewport {
  return { k: view.k, x: view.x + (before.x - after.x) * view.k, y: view.y + (before.y - after.y) * view.k };
}
