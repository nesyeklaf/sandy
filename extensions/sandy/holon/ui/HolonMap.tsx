import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { glyph, SIDES, type MapHolon, type Side } from "../core/outputs";
import {
  ancestorsOf,
  boxLight,
  buildElkGraph,
  bundleSeams,
  childrenIds,
  fitTargetId,
  fitViewport,
  isOpen,
  keepAnchor,
  openForFocus,
  placeLayout,
  rep,
  ROOT_ID,
  titleLines,
  toggled,
  zoomAt,
  type BundledSeam,
  type Light,
  type MapModel,
  type PlacedLayout,
  type Rect,
  type SideFilter,
  type Viewport,
} from "./holon-map-graph";
import { layoutGraph } from "./holon-map-layout";

type Tone = "ok" | "warn" | "idle" | "bad";

const TONE_OF: Record<Light, Tone> = { hard: "ok", soft: "ok", claimed: "warn", expired: "warn", open: "idle", refuted: "bad", drift: "bad" };

const CELL_FILL: Record<Light, string> = {
  hard: "fill-success",
  soft: "fill-success/50",
  claimed: "fill-attention",
  open: "fill-muted-foreground/35",
  refuted: "fill-destructive",
  expired: "fill-warning",
  drift: "fill-destructive",
};

const BOX_STROKE: Record<Light, string> = {
  hard: "stroke-success",
  soft: "stroke-success/60",
  claimed: "stroke-attention",
  open: "stroke-border",
  refuted: "stroke-destructive",
  expired: "stroke-warning",
  drift: "stroke-destructive",
};

const EDGE_STROKE: Record<Tone, string> = { ok: "stroke-success", warn: "stroke-attention", idle: "stroke-muted-foreground", bad: "stroke-destructive" };
const EDGE_FILL: Record<Tone, string> = { ok: "fill-success", warn: "fill-attention", idle: "fill-muted-foreground", bad: "fill-destructive" };
const TONES: Tone[] = ["ok", "warn", "idle", "bad"];

const CELLS: Record<Side, { col: number; row: number }> = { I: { col: 0, row: 0 }, It: { col: 1, row: 0 }, We: { col: 0, row: 1 }, They: { col: 1, row: 1 } };
const SIDE_FILTERS: SideFilter[] = ["All", ...SIDES];
const DRAG_THRESHOLD = 5;
const WHEEL_STEP = 0.0016;
const PINCH_STEP = 0.01;
const BUTTON_STEP = 1.25;

const BUTTON =
  "inline-flex h-7 items-center justify-center rounded-md border border-border bg-background px-2 text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface LayoutState {
  placed: PlacedLayout;
  bundles: BundledSeam[];
}

interface BoxProps {
  holon: MapHolon;
  rect: Rect;
  open: boolean;
  expandable: boolean;
  selected: boolean;
  side: SideFilter;
  onSelect(id: string): void;
  onToggle(id: string): void;
}

function clip(text: string, width: number, charWidth: number = 7.4): string {
  const chars = Math.max(4, Math.floor(width / charWidth));
  return text.length <= chars ? text : `${text.slice(0, chars - 1)}…`;
}

const Box = memo(function Box({ holon, rect, open, expandable, selected, side, onSelect, onToggle }: BoxProps) {
  const light = boxLight(holon, side);
  const lines = open ? [clip(holon.title, rect.w - 100)] : titleLines(holon.title);
  const gridX = rect.x + rect.w - (expandable ? 64 : 30);
  const gridY = rect.y + 10;
  const headerText = clip(`${holon.kind} · ${holon.status}`, gridX - 6 - (rect.x + 26), 6.8);
  const stroke = selected ? "stroke-ring" : side === "All" ? (holon.status === "proposed" ? "stroke-muted-foreground" : "stroke-border") : BOX_STROKE[light];
  return (
    <g className={holon.status === "retired" ? "opacity-60" : undefined}>
      <g
        role="button"
        tabIndex={0}
        aria-label={`${holon.title}, ${holon.kind}, ${holon.status}`}
        aria-pressed={selected}
        className="cursor-pointer focus-visible:outline-none"
        onClick={() => onSelect(holon.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(holon.id);
          }
        }}
      >
        <rect
          x={rect.x}
          y={rect.y}
          width={rect.w}
          height={rect.h}
          rx={open ? 14 : 10}
          strokeWidth={selected ? 2.5 : 1.2}
          strokeDasharray={holon.status === "proposed" ? "5 4" : undefined}
          className={`${open ? "fill-muted/40" : "fill-background"} ${stroke}`}
        />
        <circle cx={rect.x + 16} cy={rect.y + 14} r={4.5} className={CELL_FILL[light]}>
          <title>{light}</title>
        </circle>
        <text x={rect.x + 26} y={rect.y + 18} className="fill-muted-foreground font-mono text-2xs">
          {headerText}
          <title>{`${holon.kind} · ${holon.status}`}</title>
        </text>
        {lines.map((line, index) => (
          <text key={index} x={rect.x + 12} y={rect.y + 38 + index * 17} className="fill-foreground text-sm font-semibold">
            {line}
          </text>
        ))}
        {SIDES.map((name) => {
          const cell = CELLS[name];
          return (
            <rect
              key={name}
              x={gridX + cell.col * 10}
              y={gridY + cell.row * 10}
              width={8}
              height={8}
              rx={2}
              className={`${CELL_FILL[holon.sides[name]]} ${side === name ? "stroke-foreground" : "stroke-transparent"}`}
              strokeWidth={1}
            >
              <title>{`${name}: ${holon.sides[name]}`}</title>
            </rect>
          );
        })}
        {holon.driftBelow > 0 ? (
          <text x={rect.x + rect.w - 12} y={rect.y + rect.h - 10} textAnchor="end" className="fill-destructive text-2xs font-semibold">
            {glyph("drift")} {holon.driftBelow}
            <title>{`${holon.driftBelow} drift here and below`}</title>
          </text>
        ) : null}
      </g>
      {expandable ? (
        <g
          role="button"
          tabIndex={0}
          aria-label={`${open ? "Close" : "Open"} ${holon.title}`}
          aria-expanded={open}
          className="cursor-pointer focus-visible:outline-none"
          onClick={() => onToggle(holon.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onToggle(holon.id);
            }
          }}
        >
          <rect x={rect.x + rect.w - 32} y={rect.y + 8} width={24} height={24} rx={6} strokeWidth={1} className="fill-secondary stroke-border hover:fill-state-active" />
          <text x={rect.x + rect.w - 20} y={rect.y + 25} textAnchor="middle" className="fill-foreground font-mono text-sm">
            {open ? "−" : "+"}
          </text>
        </g>
      ) : null}
    </g>
  );
});

function EdgeLayer({ layout, markerPrefix, model }: { layout: LayoutState; markerPrefix: string; model: MapModel }) {
  return (
    <>
      {layout.placed.edges.map((edge, index) => {
        const bundle = layout.bundles[Number(edge.id.slice(1))];
        if (bundle === undefined || edge.points.length < 2) return null;
        const tone: Tone = bundle.drift ? "bad" : TONE_OF[bundle.light];
        const path = `M${edge.points.map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" L")}`;
        const from = model.holons.get(bundle.from)?.title ?? bundle.from;
        const to = model.holons.get(bundle.to)?.title ?? bundle.to;
        const summary = `${from} → ${to}\n${bundle.contracts.join("\n")}`;
        return (
          <g key={`${edge.id}-${index}`}>
            <path
              d={path}
              fill="none"
              strokeWidth={bundle.drift ? 1.8 : 1.3}
              strokeDasharray={bundle.readOnly ? "5 4" : undefined}
              markerEnd={`url(#${markerPrefix}-${tone})`}
              className={EDGE_STROKE[tone]}
            >
              <title>{summary}</title>
            </path>
          </g>
        );
      })}
    </>
  );
}

function EdgeLabels({ layout }: { layout: LayoutState }) {
  return (
    <>
      {layout.placed.edges.map((edge) => {
        const bundle = layout.bundles[Number(edge.id.slice(1))];
        if (bundle === undefined || edge.label === null) return null;
        const bad = bundle.drift;
        return (
          <g key={edge.id} className="pointer-events-none">
            <rect x={edge.label.x} y={edge.label.y} width={edge.label.w} height={edge.label.h} rx={3} className="fill-background/90" />
            <text x={edge.label.x + 4} y={edge.label.y + 10.5} className={`font-mono text-2xs ${bad ? "fill-destructive" : "fill-muted-foreground"}`}>
              {edge.label.text}
            </text>
          </g>
        );
      })}
    </>
  );
}

export interface HolonMapProps {
  model: MapModel;
  selected: string;
  onSelect(id: string): void;
}

export function HolonMap({ model, selected, onSelect }: HolonMapProps) {
  const markerPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => openForFocus(model, selected));
  const [side, setSide] = useState<SideFilter>("All");
  const [layout, setLayout] = useState<LayoutState | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [view, setView] = useState<Viewport>({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const sizeRef = useRef({ w: 0, h: 0 });
  const pendingFit = useRef<string | null>(selected);
  const anchor = useRef<{ id: string; rect: Rect } | null>(null);
  const ownSelection = useRef<string | null>(selected);
  const suppressClick = useRef(false);

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const measure = () => {
      const box = svg.getBoundingClientRect();
      sizeRef.current = { w: box.width, h: box.height };
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (ownSelection.current === selected) return;
    ownSelection.current = selected;
    setOpen((current) => {
      const next = new Set(current);
      for (const ancestor of ancestorsOf(model, selected)) next.add(ancestor);
      return next.size === current.size ? current : next;
    });
    pendingFit.current = selected;
    if (layoutRef.current !== null) applyPending(layoutRef.current);
  }, [selected, model]);

  useEffect(() => {
    let current = true;
    const bundles = bundleSeams(model, open);
    layoutGraph(buildElkGraph(model, open, bundles)).then(
      (result) => {
        if (!current) return;
        setFailure(null);
        setLayout({ placed: placeLayout(result), bundles });
      },
      (cause: unknown) => {
        if (current) setFailure(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [model, open]);

  function applyPending(next: LayoutState): void {
    const fit = pendingFit.current;
    const { w, h } = sizeRef.current;
    if (fit !== null) {
      const target = next.placed.rects.get(fitTargetId(model, open, fit)) ?? next.placed.rects.get(ROOT_ID);
      if (target !== undefined) {
        pendingFit.current = null;
        setView(fitViewport(target, w, h));
      }
      return;
    }
    const held = anchor.current;
    if (held !== null) {
      anchor.current = null;
      const after = next.placed.rects.get(held.id);
      if (after !== undefined) setView((current) => keepAnchor(current, held.rect, after));
    }
  }

  useLayoutEffect(() => {
    if (layout !== null) applyPending(layout);
  }, [layout]);

  const choose = useCallback(
    (id: string) => {
      if (suppressClick.current) return;
      ownSelection.current = id;
      onSelect(id);
    },
    [onSelect],
  );

  const toggle = useCallback(
    (id: string) => {
      if (suppressClick.current) return;
      const rect = layoutRef.current?.placed.rects.get(id);
      if (rect !== undefined) anchor.current = { id, rect };
      ownSelection.current = id;
      onSelect(id);
      setOpen((current) => toggled(current, id));
    },
    [onSelect],
  );

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const pinch = useRef<{ d: number; k: number; cx: number; cy: number; vx: number; vy: number } | null>(null);
  const moved = useRef(false);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const svg = svgRef.current;
      if (svg === null || !pointers.current.has(event.pointerId)) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const started = pinch.current;
      if (started !== null && pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
        const next = zoomAt({ x: started.vx, y: started.vy, k: started.k }, Math.hypot(a.x - b.x, a.y - b.y) / started.d, started.cx, started.cy);
        moved.current = true;
        setView(next);
        return;
      }
      const drag = pan.current;
      if (drag === null) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!moved.current && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      moved.current = true;
      setView((current) => ({ k: current.k, x: drag.vx + dx, y: drag.vy + dy }));
    };
    const release = (event: PointerEvent) => {
      if (!pointers.current.delete(event.pointerId)) return;
      if (pointers.current.size < 2) pinch.current = null;
      if (pointers.current.size === 0) {
        pan.current = null;
        if (moved.current) {
          suppressClick.current = true;
          setTimeout(() => {
            suppressClick.current = false;
          }, 0);
        }
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const box = svg.getBoundingClientRect();
      const step = Math.abs(event.deltaY) < 50 ? PINCH_STEP : WHEEL_STEP;
      setView((current) => zoomAt(current, Math.exp(-event.deltaY * step), event.clientX - box.left, event.clientY - box.top));
    };
    svg.addEventListener("wheel", wheel, { passive: false });
    return () => svg.removeEventListener("wheel", wheel);
  }, []);

  function pointerDown(event: ReactPointerEvent<SVGSVGElement>): void {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    moved.current = false;
    const current = viewRef.current;
    if (pointers.current.size === 1) pan.current = { x: event.clientX, y: event.clientY, vx: current.x, vy: current.y };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const box = event.currentTarget.getBoundingClientRect();
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: current.k, cx: (a.x + b.x) / 2 - box.left, cy: (a.y + b.y) / 2 - box.top, vx: current.x, vy: current.y };
      pan.current = null;
    }
  }

  function zoomBy(factor: number): void {
    const { w, h } = sizeRef.current;
    setView((current) => zoomAt(current, factor, w / 2, h / 2));
  }

  function fitTo(id: string | null): void {
    const placed = layoutRef.current?.placed;
    if (placed === undefined) return;
    const target = placed.rects.get(fitTargetId(model, open, id)) ?? placed.rects.get(ROOT_ID);
    const box = svgRef.current?.getBoundingClientRect();
    const { w, h } = box === undefined || box.width === 0 ? sizeRef.current : { w: box.width, h: box.height };
    if (target !== undefined) setView(fitViewport(target, w, h));
  }

  const chain = useMemo(() => [...ancestorsOf(model, selected), selected], [model, selected]);
  const selectedBox = rep(model, open, selected);

  const boxes = useMemo(() => {
    if (layout === null) return null;
    const entries = [...layout.placed.rects.entries()].filter(([id]) => model.holons.has(id));
    entries.sort((a, b) => a[1].depth - b[1].depth);
    return entries;
  }, [layout, model]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <nav aria-label="Holon path" className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {chain.map((id, index) => (
            <span key={id} className="flex items-center gap-1">
              {index === 0 ? null : <span className="text-muted-foreground">/</span>}
              <button
                type="button"
                aria-current={id === selected ? "true" : undefined}
                className="rounded-md px-1.5 py-0.5 hover:bg-state-hover aria-[current=true]:font-semibold"
                onClick={() => {
                  ownSelection.current = null;
                  pendingFit.current = id;
                  onSelect(id);
                  if (id === selected) fitTo(id);
                }}
              >
                {model.holons.get(id)?.title ?? id}
              </button>
            </span>
          ))}
        </nav>
        <div role="group" aria-label="Side" className="flex items-center gap-1">
          <span className="text-muted-foreground">Side</span>
          {SIDE_FILTERS.map((name) => (
            <button key={name} type="button" aria-pressed={side === name} className={`${BUTTON} aria-pressed:bg-state-active`} onClick={() => setSide(name)}>
              {name}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Zoom" className="flex items-center gap-1">
          <button type="button" aria-label="Zoom out" className={BUTTON} onClick={() => zoomBy(1 / BUTTON_STEP)}>
            −
          </button>
          <button type="button" aria-label="Zoom in" className={BUTTON} onClick={() => zoomBy(BUTTON_STEP)}>
            +
          </button>
          <button type="button" className={BUTTON} onClick={() => fitTo(selected)}>
            Fit
          </button>
          <button type="button" className={BUTTON} onClick={() => fitTo(null)}>
            Fit all
          </button>
        </div>
      </div>
      <div className="relative">
        <svg
          ref={svgRef}
          role="group"
          aria-label="Map of the holons"
          className="block h-[60vh] min-h-80 w-full cursor-grab touch-none select-none rounded-lg border border-border bg-background active:cursor-grabbing"
          onPointerDown={pointerDown}
        >
          <defs>
            {TONES.map((tone) => (
              <marker key={tone} id={`${markerPrefix}-${tone}`} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto">
                <path d="M1 1L9 5L1 9z" className={EDGE_FILL[tone]} />
              </marker>
            ))}
          </defs>
          {layout === null || boxes === null ? null : (
            <g transform={`translate(${view.x.toFixed(1)} ${view.y.toFixed(1)}) scale(${view.k.toFixed(4)})`}>
              {boxes.filter(([id]) => isOpen(model, open, id)).map(([id, rect]) => (
                <Box key={id} holon={model.holons.get(id)!} rect={rect} open expandable selected={id === selectedBox} side={side} onSelect={choose} onToggle={toggle} />
              ))}
              <EdgeLayer layout={layout} markerPrefix={markerPrefix} model={model} />
              {boxes.filter(([id]) => !isOpen(model, open, id)).map(([id, rect]) => (
                <Box
                  key={id}
                  holon={model.holons.get(id)!}
                  rect={rect}
                  open={false}
                  expandable={childrenIds(model, id).length > 0}
                  selected={id === selectedBox}
                  side={side}
                  onSelect={choose}
                  onToggle={toggle}
                />
              ))}
              <EdgeLabels layout={layout} />
            </g>
          )}
        </svg>
        {layout === null && failure === null ? <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">Laying out the map…</p> : null}
        {failure === null ? null : (
          <p className="absolute inset-x-0 top-2 text-center text-xs text-destructive" role="alert">
            Layout failed: {failure}
          </p>
        )}
        <p className="pointer-events-none absolute bottom-2 left-3 text-2xs text-muted-foreground">Drag to pan · Ctrl or ⌘ + scroll or pinch to zoom · +/− opens and closes a box</p>
      </div>
    </div>
  );
}
