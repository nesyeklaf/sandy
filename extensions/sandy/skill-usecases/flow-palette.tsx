import { useEffect, useMemo, useRef, useState } from "react";
import type { SkillInfo } from "./check";
import { AD_HOC_SKILL, BLOCKS, blockedReason, type PaletteItem, type Placement } from "./canvas-model";
import type { Flow } from "./graph";
import { formatIo } from "./io";

export const ITEM_MIME = "application/x-sandy-flow-item";

export interface PickerEntry {
  key: string;
  group: "Blocks" | "Skills";
  title: string;
  purpose: string;
  io: string;
  item: PaletteItem;
}

export function paletteEntries(skills: readonly SkillInfo[]): PickerEntry[] {
  return [
    { key: "block:skill", group: "Blocks", title: AD_HOC_SKILL.title, purpose: AD_HOC_SKILL.purpose, io: "", item: { kind: "skill", skill: null } },
    ...BLOCKS.map((block): PickerEntry => ({ key: "block:" + block.kind, group: "Blocks", title: block.title, purpose: block.purpose, io: "", item: { kind: block.kind } })),
    ...skills.map(
      (skill): PickerEntry => ({
        key: "skill:" + skill.name,
        group: "Skills",
        title: skill.name,
        purpose: skill.purpose,
        io: skill.inputs.length === 0 && skill.outputs.length === 0 ? "" : (formatIo(skill.inputs) || "nothing") + " → " + (formatIo(skill.outputs) || "nothing"),
        item: { kind: "skill", skill },
      }),
    ),
  ];
}

export function encodeItem(entry: PickerEntry): string {
  return entry.key;
}

export function decodeItem(key: string, skills: readonly SkillInfo[]): PaletteItem | null {
  return paletteEntries(skills).find((entry) => entry.key === key)?.item ?? null;
}

function matches(entry: PickerEntry, needle: string): boolean {
  return needle === "" || (entry.title + " " + entry.purpose + " " + entry.group).toLowerCase().includes(needle);
}

export function Palette({ skills, onAdd }: { skills: readonly SkillInfo[]; onAdd: (item: PaletteItem) => void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(true);
  const entries = useMemo(() => paletteEntries(skills), [skills]);
  const needle = query.trim().toLowerCase();
  if (!open)
    return (
      <aside aria-label="Palette" className="flex w-10 shrink-0 flex-col items-center border-r border-border py-2">
        <button type="button" className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent" aria-label="Open palette" onClick={() => setOpen(true)}>
          ▸
        </button>
      </aside>
    );
  const shown = entries.filter((entry) => matches(entry, needle));
  return (
    <aside aria-label="Palette" className="flex w-60 shrink-0 flex-col border-r border-border">
      <div className="flex items-center gap-2 px-3 pb-1 pt-2">
        <h3 className="flex-1 text-xs font-medium text-muted-foreground">Palette · drag or click</h3>
        <button type="button" className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent" aria-label="Close palette" onClick={() => setOpen(false)}>
          ◂
        </button>
      </div>
      <div className="px-3 pb-2">
        <input type="search" aria-label="Search blocks and skills" placeholder="Search blocks and skills" className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3">
        {shown.map((entry, index) => (
          <li key={entry.key}>
            {index === 0 || shown[index - 1]!.group !== entry.group ? <p className="pb-1 pt-2 text-xs text-muted-foreground">{entry.group}</p> : null}
            <button
              type="button"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(ITEM_MIME, encodeItem(entry));
                event.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => onAdd(entry.item)}
              className="block w-full cursor-grab rounded-lg border border-border bg-card/60 px-2.5 py-2 text-left hover:bg-accent/50 active:cursor-grabbing"
            >
              <span className="block text-sm font-medium">{entry.title}</span>
              <span className="line-clamp-2 block text-xs text-muted-foreground">{entry.purpose}</span>
              {entry.io === "" ? null : <span className="mt-1 block break-words font-mono text-xs text-muted-foreground">{entry.io}</span>}
            </button>
          </li>
        ))}
        {shown.length === 0 ? <li className="p-2 text-xs text-muted-foreground">Nothing matches "{query.trim()}"</li> : null}
      </ul>
    </aside>
  );
}

export function Picker({
  flow,
  skills,
  placement,
  anchor,
  onPick,
  onClose,
}: {
  flow: Flow;
  skills: readonly SkillInfo[];
  placement: Placement;
  anchor: { x: number; y: number };
  onPick: (item: PaletteItem) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const needle = query.trim().toLowerCase();
  const shown = paletteEntries(skills)
    .filter((entry) => matches(entry, needle))
    .map((entry) => ({ entry, why: blockedReason(flow, entry.item, placement) }));
  const enabled = shown.filter((row) => row.why === null);
  const current = Math.min(active, Math.max(0, enabled.length - 1));
  const choose = (item: PaletteItem) => {
    onPick(item);
    onClose();
  };
  return (
    <div
      role="dialog"
      aria-label="Add a block"
      className="absolute z-20 flex max-h-80 w-72 flex-col rounded-lg border border-border bg-background shadow-lg"
      style={{ left: anchor.x, top: anchor.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <input
        ref={input}
        aria-label="Search blocks and skills"
        placeholder="Add a block or skill…"
        className="h-9 rounded-t-lg border-b border-border bg-transparent px-3 text-sm outline-none"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          else if (event.key === "ArrowDown") setActive(Math.min(current + 1, enabled.length - 1));
          else if (event.key === "ArrowUp") setActive(Math.max(current - 1, 0));
          else if (event.key === "Enter") {
            const row = enabled[current];
            if (row !== undefined) choose(row.entry.item);
          } else return;
          event.preventDefault();
        }}
      />
      <ul role="listbox" aria-label="Blocks and skills" className="min-h-0 flex-1 overflow-y-auto p-1">
        {shown.map((row, index) => {
          const on = row.why === null && enabled[current] === row;
          return (
            <li key={row.entry.key}>
              {index === 0 || shown[index - 1]!.entry.group !== row.entry.group ? <p className="px-2 pb-0.5 pt-1.5 text-xs text-muted-foreground">{row.entry.group}</p> : null}
              <button
                type="button"
                role="option"
                aria-selected={on}
                aria-disabled={row.why !== null}
                disabled={row.why !== null}
                onPointerMove={() => row.why === null && setActive(enabled.indexOf(row))}
                onClick={() => choose(row.entry.item)}
                className={"block w-full rounded-md px-2 py-1 text-left disabled:opacity-50 " + (on ? "bg-accent" : "")}
              >
                <span className="block text-sm">
                  {row.entry.title}
                  {row.why === null ? null : <em className="text-muted-foreground"> · {row.why}</em>}
                </span>
                <span className="block truncate text-xs text-muted-foreground">{row.entry.purpose}</span>
              </button>
            </li>
          );
        })}
        {shown.length === 0 ? <li className="p-2 text-xs text-muted-foreground">Nothing matches "{query.trim()}"</li> : null}
      </ul>
    </div>
  );
}
