import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Problem, SkillInfo } from "./check";
import { GAP_Y, NODE_H, connect, entryPoint, exitPoint, insertNode, layout, nodeWidth, type Edit, type PaletteItem, type Placement } from "./canvas-model";
import { backWires, exitLabels, nodeTitle, wireAt, type Flow, type FlowNode, type Wire } from "./graph";
import { ITEM_MIME, Palette, Picker, decodeItem } from "./flow-palette";

export type Selection = { kind: "node"; id: string } | { kind: "wire"; id: string } | null;

interface View {
  x: number;
  y: number;
  k: number;
}

type Gesture =
  | { kind: "pan"; startX: number; startY: number; view: View }
  | { kind: "node"; id: string; startX: number; startY: number; originX: number; originY: number; moved: boolean }
  | { kind: "link"; from: string; port: number; x: number; y: number };

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 1.6;
const TOOL = "h-7 rounded-md border border-border bg-background px-2 text-xs hover:bg-accent";

const KIND_LABEL: Record<FlowNode["kind"], string> = { skill: "Skill", input: "Input", gate: "Gate", fork: "Fork", output: "Output" };

function clampZoom(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

function whoOf(node: FlowNode): string {
  if (node.kind === "gate") return node.owner === "owner" ? "you" : node.owner === "agent" ? "agent decides" : "anyone";
  if (node.kind === "skill") return node.skill === null ? "ad hoc" : "agent";
  return "";
}

function exitText(node: FlowNode, port: number, flow: Flow): string {
  const label = exitLabels(node)[port] ?? "";
  if (node.kind === "fork") {
    const path = port < node.paths.length ? node.paths[port] : node.otherwise;
    return path === undefined || path === null || path.note.trim() === "" ? label : label + " · " + path.note.trim();
  }
  if (node.kind === "gate" && node.ends.includes(port) && wireAt(flow, node.id, port) === undefined) return label + " · ends";
  return label;
}

function hasNamedExits(node: FlowNode): boolean {
  return node.kind === "gate" || node.kind === "fork";
}

function wireGeometry(flow: Flow, wire: Wire, back: ReadonlySet<string>, loopX: number): { path: string; mid: { x: number; y: number } } | null {
  const from = flow.nodes.find((node) => node.id === wire.from);
  const to = flow.nodes.find((node) => node.id === wire.to);
  if (from === undefined || to === undefined) return null;
  const a = exitPoint(from, wire.port);
  const b = entryPoint(to);
  if (!back.has(wire.id) && b.y > a.y + 8) {
    const m = (a.y + b.y) / 2;
    return { path: "M" + a.x + " " + a.y + " C" + a.x + " " + m + " " + b.x + " " + m + " " + b.x + " " + b.y, mid: { x: (a.x + b.x) / 2, y: m } };
  }
  const drop = hasNamedExits(from) ? 30 : 16;
  return {
    path: "M" + a.x + " " + a.y + " L" + a.x + " " + (a.y + drop) + " L" + loopX + " " + (a.y + drop) + " L" + loopX + " " + (b.y - 16) + " L" + b.x + " " + (b.y - 16) + " L" + b.x + " " + b.y,
    mid: { x: loopX, y: (a.y + b.y) / 2 },
  };
}

export function FlowCanvas({
  flow,
  skills,
  problems,
  selection,
  fitKey,
  message,
  onSelect,
  onChange,
}: {
  flow: Flow;
  skills: readonly SkillInfo[];
  problems: readonly Problem[];
  selection: Selection;
  fitKey: string;
  message: string;
  onSelect: (selection: Selection) => void;
  onChange: (edit: Edit) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const gesture = useRef<Gesture | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [link, setLink] = useState<{ from: string; port: number; x: number; y: number } | null>(null);
  const [hoverWire, setHoverWire] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ placement: Placement; anchor: { x: number; y: number } } | null>(null);

  const shown: Flow = drag === null ? flow : { ...flow, nodes: flow.nodes.map((node) => (node.id === drag.id ? { ...node, x: drag.x, y: drag.y } : node)) };

  const fit = useCallback(() => {
    const element = box.current;
    if (element === null) return;
    const width = element.clientWidth;
    const height = element.clientHeight;
    if (flow.nodes.length === 0) {
      setView({ x: width / 2, y: height / 3, k: 1 });
      return;
    }
    const left = Math.min(...flow.nodes.map((node) => node.x));
    const top = Math.min(...flow.nodes.map((node) => node.y));
    const right = Math.max(...flow.nodes.map((node) => node.x + nodeWidth(node))) + 60;
    const bottom = Math.max(...flow.nodes.map((node) => node.y + NODE_H)) + GAP_Y;
    const k = clampZoom(Math.min(1, (width - 80) / Math.max(1, right - left), (height - 80) / Math.max(1, bottom - top)));
    setView({ x: (width - (right - left) * k) / 2 - left * k, y: 40 - top * k, k });
  }, [flow.nodes]);

  const fitRef = useRef(fit);
  fitRef.current = fit;
  useLayoutEffect(() => {
    fitRef.current();
    setPicker(null);
  }, [fitKey]);

  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = viewRef.current;
      if (event.ctrlKey || event.metaKey) {
        const rect = element.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const k = clampZoom(current.k * Math.exp(-event.deltaY / 300));
        setView({ k, x: px - ((px - current.x) / current.k) * k, y: py - ((py - current.y) / current.k) * k });
      } else setView({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const local = (clientX: number, clientY: number) => {
    const rect = box.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };
  const world = (clientX: number, clientY: number) => {
    const point = local(clientX, clientY);
    return { x: (point.x - view.x) / view.k, y: (point.y - view.y) / view.k };
  };
  const zoomBy = (factor: number) => {
    const element = box.current;
    if (element === null) return;
    const px = element.clientWidth / 2;
    const py = element.clientHeight / 2;
    const k = clampZoom(view.k * factor);
    setView({ k, x: px - ((px - view.x) / view.k) * k, y: py - ((py - view.y) / view.k) * k });
  };
  const center = () => {
    const element = box.current;
    const width = element?.clientWidth ?? 600;
    const height = element?.clientHeight ?? 400;
    return { x: (width / 2 - view.x) / view.k, y: (height / 2 - view.y) / view.k };
  };
  const addFree = (item: PaletteItem, at: { x: number; y: number }) => onChange(insertNode(flow, item, { kind: "free", x: at.x - 120, y: at.y - NODE_H / 2 }));
  const openPicker = (placement: Placement, event: { clientX: number; clientY: number }) => {
    const element = box.current;
    const point = local(event.clientX, event.clientY);
    const x = Math.max(8, Math.min(point.x, (element?.clientWidth ?? 600) - 296));
    const y = Math.max(8, Math.min(point.y + 12, (element?.clientHeight ?? 400) - 330));
    setPicker({ placement, anchor: { x, y } });
  };

  const capture = (event: ReactPointerEvent) => box.current?.setPointerCapture(event.pointerId);
  const onBackgroundDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    setPicker(null);
    capture(event);
    gesture.current = { kind: "pan", startX: event.clientX, startY: event.clientY, view };
  };
  const onNodeDown = (event: ReactPointerEvent, node: FlowNode) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    setPicker(null);
    capture(event);
    gesture.current = { kind: "node", id: node.id, startX: event.clientX, startY: event.clientY, originX: node.x, originY: node.y, moved: false };
  };
  const onPortDown = (event: ReactPointerEvent, node: FlowNode, port: number) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    setPicker(null);
    capture(event);
    const point = world(event.clientX, event.clientY);
    gesture.current = { kind: "link", from: node.id, port, ...point };
    setLink({ from: node.id, port, ...point });
  };
  const onMove = (event: ReactPointerEvent) => {
    const current = gesture.current;
    if (current === null) return;
    if (current.kind === "pan") setView({ ...current.view, x: current.view.x + event.clientX - current.startX, y: current.view.y + event.clientY - current.startY });
    else if (current.kind === "node") {
      const dx = (event.clientX - current.startX) / view.k;
      const dy = (event.clientY - current.startY) / view.k;
      if (!current.moved && Math.hypot(dx, dy) < 3) return;
      current.moved = true;
      setDrag({ id: current.id, x: Math.round(current.originX + dx), y: Math.round(current.originY + dy) });
    } else setLink({ from: current.from, port: current.port, ...world(event.clientX, event.clientY) });
  };
  const onUp = (event: ReactPointerEvent) => {
    const current = gesture.current;
    gesture.current = null;
    if (current === null) return;
    if (current.kind === "pan") {
      if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 3) onSelect(null);
      return;
    }
    if (current.kind === "node") {
      const moved = drag;
      setDrag(null);
      if (!current.moved || moved === null) {
        onSelect({ kind: "node", id: current.id });
        return;
      }
      const node = flow.nodes.find((item) => item.id === current.id);
      onChange({
        flow: { ...flow, nodes: flow.nodes.map((item) => (item.id === current.id ? { ...item, x: moved.x, y: moved.y } : item)) },
        nodeId: current.id,
        message: "Moved " + (node === undefined ? "block" : nodeTitle(node)),
      });
      return;
    }
    setLink(null);
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-node-id]")?.getAttribute("data-node-id");
    const from = flow.nodes.find((node) => node.id === current.from);
    const to = flow.nodes.find((node) => node.id === target);
    if (from === undefined || to === undefined || to.id === from.id || to.kind === "input") return;
    onChange({ flow: connect(flow, from.id, current.port, to.id), nodeId: null, message: "Connected " + nodeTitle(from) + " → " + nodeTitle(to) });
  };

  const back = backWires(shown);
  const loopBase = shown.nodes.length === 0 ? 0 : Math.max(...shown.nodes.map((node) => node.x + nodeWidth(node))) + 36;
  const loops = shown.wires.filter((wire) => back.has(wire.id) || !shown.nodes.some((node) => node.id === wire.to && node.y > (shown.nodes.find((item) => item.id === wire.from)?.y ?? 0)));
  const severityOf = (id: string) => {
    const mine = problems.filter((problem) => problem.nodeId === id);
    return mine.some((problem) => problem.severity === "error") ? "error" : mine.length > 0 ? "warn" : null;
  };
  const selectedNode = selection?.kind === "node" ? selection.id : null;
  const selectedWire = selection?.kind === "wire" ? selection.id : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <Palette skills={skills} onAdd={(item) => addFree(item, center())} />
      <div
        ref={box}
        className="relative min-h-0 min-w-0 flex-1 touch-none select-none overflow-hidden bg-background"
        style={{ backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)", backgroundSize: 20 * view.k + "px " + 20 * view.k + "px", backgroundPosition: view.x + "px " + view.y + "px" }}
        onPointerDown={onBackgroundDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => {
          gesture.current = null;
          setDrag(null);
          setLink(null);
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(ITEM_MIME)) event.preventDefault();
        }}
        onDrop={(event) => {
          const item = decodeItem(event.dataTransfer.getData(ITEM_MIME), skills);
          if (item === null) return;
          event.preventDefault();
          addFree(item, world(event.clientX, event.clientY));
        }}
      >
        <div className="absolute left-0 top-0 origin-top-left" style={{ transform: "translate(" + view.x + "px, " + view.y + "px) scale(" + view.k + ")" }}>
          <svg className="absolute left-0 top-0 overflow-visible" width="1" height="1" aria-hidden="true">
            {shown.wires.map((wire) => {
              const geometry = wireGeometry(shown, wire, back, loopBase + loops.indexOf(wire) * 14);
              if (geometry === null) return null;
              const active = selectedWire === wire.id || hoverWire === wire.id;
              return (
                <g key={wire.id}>
                  <path d={geometry.path} fill="none" className={active ? "stroke-primary" : "stroke-muted-foreground"} strokeOpacity={active ? 1 : 0.55} strokeWidth={active ? 2.5 : 1.75} />
                  <path
                    d={geometry.path}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={14}
                    className="cursor-pointer"
                    style={{ pointerEvents: "stroke" }}
                    onPointerEnter={() => setHoverWire(wire.id)}
                    onPointerLeave={() => setHoverWire((current) => (current === wire.id ? null : current))}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      onSelect({ kind: "wire", id: wire.id });
                    }}
                  />
                </g>
              );
            })}
            {link === null
              ? null
              : (() => {
                  const from = shown.nodes.find((node) => node.id === link.from);
                  if (from === undefined) return null;
                  const a = exitPoint(from, link.port);
                  return <path d={"M" + a.x + " " + a.y + " L" + link.x + " " + link.y} fill="none" className="stroke-primary" strokeWidth={2} strokeDasharray="5 4" />;
                })()}
          </svg>
          {shown.wires.map((wire) => {
            if (selectedWire !== wire.id && hoverWire !== wire.id) return null;
            const geometry = wireGeometry(shown, wire, back, loopBase + loops.indexOf(wire) * 14);
            if (geometry === null) return null;
            return (
              <button
                key={"plus-" + wire.id}
                type="button"
                aria-label="Insert a block on this wire"
                className="absolute z-10 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background text-xs hover:bg-accent"
                style={{ left: geometry.mid.x, top: geometry.mid.y }}
                onPointerEnter={() => setHoverWire(wire.id)}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => openPicker({ kind: "wire", wireId: wire.id }, event)}
              >
                +
              </button>
            );
          })}
          {shown.nodes.map((node) => {
            const width = nodeWidth(node);
            const severity = severityOf(node.id);
            const who = whoOf(node);
            const tone = severity === "error" ? "border-destructive" : severity === "warn" ? "border-warning" : selectedNode === node.id ? "border-primary" : "border-border";
            return (
              <div key={node.id}>
                <div
                  data-node-id={node.id}
                  role="button"
                  tabIndex={0}
                  aria-label={KIND_LABEL[node.kind] + ": " + nodeTitle(node)}
                  aria-pressed={selectedNode === node.id}
                  onPointerDown={(event) => onNodeDown(event, node)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect({ kind: "node", id: node.id });
                    }
                  }}
                  className={
                    "absolute flex cursor-grab items-center gap-2 rounded-lg border bg-card px-3 shadow-sm active:cursor-grabbing " +
                    tone +
                    (selectedNode === node.id ? " ring-2 ring-primary/40" : "") +
                    (node.kind === "gate" ? " bg-accent" : "")
                  }
                  style={{ left: node.x, top: node.y, width, height: NODE_H }}
                >
                  <span className="shrink-0 rounded bg-muted px-1 text-xs text-muted-foreground">{KIND_LABEL[node.kind]}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{nodeTitle(node)}</span>
                  {who === "" ? null : <span className="shrink-0 rounded-full border border-border px-1.5 text-xs text-muted-foreground">{who}</span>}
                </div>
                {node.kind === "input" ? null : (
                  <span aria-hidden="true" className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-border bg-muted-foreground" style={{ left: entryPoint(node).x, top: entryPoint(node).y }} />
                )}
                {exitLabels(node).map((_, port) => {
                  const point = exitPoint(node, port);
                  const wired = wireAt(shown, node.id, port) !== undefined;
                  const named = hasNamedExits(node);
                  return (
                    <div key={"exit-" + String(port)}>
                      <span
                        role="presentation"
                        title="Drag to a block to connect"
                        className="absolute z-10 size-3 -translate-x-1/2 -translate-y-1/2 cursor-crosshair rounded-sm border border-border bg-muted-foreground hover:bg-primary"
                        style={{ left: point.x, top: point.y }}
                        onPointerDown={(event) => onPortDown(event, node, port)}
                      />
                      {named ? (
                        <span className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap text-xs text-muted-foreground" style={{ left: point.x, top: point.y + 6 }}>
                          {exitText(node, port, shown)}
                        </span>
                      ) : null}
                      {wired ? null : (
                        <button
                          type="button"
                          aria-label={"Add a block after " + nodeTitle(node) + (named ? " › " + (exitLabels(node)[port] ?? "") : "")}
                          className="absolute z-10 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background text-xs hover:bg-accent"
                          style={{ left: point.x, top: point.y + (named ? 36 : 18) }}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => openPicker({ kind: "after", nodeId: node.id, port }, event)}
                        >
                          +
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        {flow.nodes.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <button
              type="button"
              className="h-9 rounded-md border border-dashed border-border bg-background px-4 text-sm hover:bg-accent"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                const at = center();
                const element = box.current;
                openPicker({ kind: "free", x: at.x - 120, y: at.y - NODE_H / 2 }, { clientX: (element?.getBoundingClientRect().left ?? 0) + (element?.clientWidth ?? 0) / 2 - 144, clientY: event.clientY });
              }}
            >
              + Add first block
            </button>
          </div>
        ) : null}
        <div className="absolute bottom-3 left-3 flex items-center gap-1" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" className={TOOL} aria-label="Zoom in" onClick={() => zoomBy(1.2)}>
            +
          </button>
          <button type="button" className={TOOL} aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
            −
          </button>
          <button type="button" className={TOOL} onClick={fit}>
            Fit
          </button>
          <button type="button" className={TOOL} onClick={() => onChange({ flow: layout(flow), nodeId: null, message: "Laid out the flow top to bottom" })}>
            Auto-layout
          </button>
        </div>
        <p aria-live="polite" className="pointer-events-none absolute bottom-4 right-3 max-w-[60%] truncate text-xs text-muted-foreground">
          {message}
        </p>
        {picker === null ? null : (
          <Picker flow={flow} skills={skills} placement={picker.placement} anchor={picker.anchor} onPick={(item) => onChange(insertNode(flow, item, picker.placement))} onClose={() => setPicker(null)} />
        )}
      </div>
    </div>
  );
}
