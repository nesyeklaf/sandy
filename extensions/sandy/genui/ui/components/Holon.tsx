import { memo, useContext, useMemo, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  DRIFT_KINDS,
  LIGHTS,
  readHolonView,
  SIDE_HINTS,
  SIDE_NAMES,
  type DriftKind,
  type HolonChild,
  type HolonDrift,
  type HolonSeam,
  type HolonSide,
  type HolonSummary,
  type HolonView,
  type Light,
  type SideName,
} from "../../core/holon";
import { CardDepthContext } from "../runtime";
import { propsKey, usePersistedState } from "../usePersistedState";
import { formatNumber, TONE_TEXT, type Props } from "../values";
import { ReportFrame, TEXT_BUTTON, useFileOpener } from "./codeHealthKit";
import { ErrorLine } from "./display";
import { CAPTION } from "./inputs";

const PAGE = 50;

const CHIP = "inline-flex items-center rounded-sm bg-surface-recessed px-1.5 text-[11px] leading-5 text-muted-foreground";

const TONE_CHIP: Record<"warn" | "bad", string> = {
  warn: "bg-warning/18 text-warning-text",
  bad: "bg-destructive/12 text-destructive",
};

function Glyph({ light }: { light: Light }) {
  const look = LIGHTS[light];
  return (
    <span role="img" aria-label={look.label} className={cn("inline-block w-4 shrink-0 text-center font-mono leading-5", TONE_TEXT[look.tone])}>
      {look.glyph}
    </span>
  );
}

function CodePath({ path }: { path: string }) {
  const file = useFileOpener(path);
  if (file === null) return <span className="min-w-0 font-mono text-xs leading-5 text-foreground [overflow-wrap:anywhere]">{path}</span>;
  return (
    <button
      type="button"
      title={`Open ${file.target}`}
      onClick={() => void file.open(null)}
      className={cn(TEXT_BUTTON, "inline-flex min-w-0 items-center gap-1.5 text-left font-mono text-xs [overflow-wrap:anywhere]")}
    >
      <Icon name="FileText" aria-hidden className="size-3.5 shrink-0" />
      {path}
    </button>
  );
}

function DriftChip({ kind }: { kind: DriftKind }) {
  const look = DRIFT_KINDS[kind];
  return <span className={cn(CHIP, "font-medium", TONE_CHIP[look.tone])}>{look.label}</span>;
}

function sideFacts(side: HolonSide): string[] {
  return [
    side.kind,
    side.source,
    side.by === null ? null : `by ${side.by}`,
    side.at === null ? null : `at ${side.at}`,
    side.expires === null ? null : `expires ${side.expires}`,
  ].filter((part): part is string => part !== null);
}

function SideCell({ name, side }: { name: SideName; side: HolonSide }) {
  const look = LIGHTS[side.light];
  const facts = sideFacts(side);
  return (
    <li className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-surface-recessed/70 px-3 py-2">
      <div className="flex min-w-0 items-baseline gap-1.5">
        <Glyph light={side.light} />
        <span className="text-[13px] font-medium leading-5 text-foreground">{name}</span>
        <span className={cn("text-xs leading-5", TONE_TEXT[look.tone] || "text-muted-foreground")}>{look.label}</span>
      </div>
      <p className={cn(CAPTION, "m-0")}>{SIDE_HINTS[name]}</p>
      {side.detail === null ? null : <p className="m-0 text-xs leading-5 text-foreground [overflow-wrap:anywhere]">{side.detail}</p>}
      {facts.length === 0 ? null : <p className={cn(CAPTION, "m-0 [overflow-wrap:anywhere]")}>{facts.join(" · ")}</p>}
    </li>
  );
}

function driftWhere(drift: HolonDrift): string | null {
  if (drift.side !== null) return `side ${drift.side}`;
  if (drift.seam !== null) return `seam to ${drift.seam}`;
  return null;
}

function DriftList({ drift }: { drift: readonly HolonDrift[] }) {
  return (
    <ul aria-label="Drift" className="m-0 flex min-w-0 list-none flex-col gap-1 p-0">
      {drift.map((entry, index) => {
        const where = driftWhere(entry);
        return (
          <li key={index} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <DriftChip kind={entry.kind} />
            {where === null ? null : <span className={CAPTION}>{where}</span>}
            <span className="min-w-0 text-xs leading-5 text-foreground [overflow-wrap:anywhere]">{entry.detail}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <p className={cn(CAPTION, "m-0 font-medium")}>{label}</p>
      {children}
    </div>
  );
}

function belowText(driftBelow: number): string | null {
  return driftBelow > 0 ? `${formatNumber(driftBelow)} drift below` : null;
}

function Parent({ parent }: { parent: HolonSummary }) {
  const below = belowText(parent.driftBelow);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-5">
      <span className="text-muted-foreground">Part of</span>
      <Glyph light={parent.light} />
      <span className="font-medium text-foreground">{parent.title}</span>
      <span className="text-muted-foreground">{parent.kind}</span>
      {below === null ? null : <span className={cn(CHIP, TONE_CHIP.warn)}>{below}</span>}
    </div>
  );
}

const ChildRow = memo(function ChildRow({ child }: { child: HolonChild }) {
  const below = belowText(child.driftBelow);
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-border/60 py-1.5 first:border-t-0">
      <Glyph light={child.light} />
      <span className="min-w-0 text-[13px] leading-5 text-foreground [overflow-wrap:anywhere]">{child.title}</span>
      <span className={CAPTION}>{child.kind}</span>
      {child.status === "active" ? null : <span className={CHIP}>{child.status}</span>}
      {child.childCount > 0 ? <span className={CAPTION}>{`${formatNumber(child.childCount)} ${child.childCount === 1 ? "part" : "parts"}`}</span> : null}
      {below === null ? null : <span className={cn(CHIP, TONE_CHIP.warn)}>{below}</span>}
    </li>
  );
});

const SeamRow = memo(function SeamRow({ seam }: { seam: HolonSeam }) {
  const drifted = seam.drift !== null;
  return (
    <li className={cn("flex min-w-0 flex-col gap-0.5 rounded-lg px-3 py-2", drifted ? "bg-destructive/8 ring-1 ring-destructive/30" : "bg-surface-recessed/70")}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="text-[13px] font-medium leading-5 text-foreground">{seam.fromTitle}</span>
        <span
          aria-hidden
          className={cn("inline-block h-0 w-8 shrink-0 border-t-2", seam.readOnly ? "border-dashed" : "border-solid", drifted ? "border-destructive" : "border-muted-foreground/60")}
        />
        <span className="text-[13px] font-medium leading-5 text-foreground">{seam.toTitle}</span>
        <Glyph light={seam.light} />
        {seam.drift === null ? null : <DriftChip kind={seam.drift} />}
        {seam.readOnly ? <span className={CHIP}>read-only</span> : null}
        {seam.exclusive ? <span className={CHIP}>exclusive</span> : null}
      </div>
      <p className="m-0 text-xs leading-5 text-foreground [overflow-wrap:anywhere]">{seam.contract}</p>
    </li>
  );
});

function Paged<T>({ items, shown, more, label, render }: { items: readonly T[]; shown: number; more: () => void; label: string; render: (item: T, index: number) => ReactNode }) {
  const rest = items.length - Math.min(items.length, shown);
  return (
    <>
      {items.slice(0, shown).map(render)}
      {rest > 0 ? (
        <li className="list-none pt-1">
          <button type="button" onClick={more} className={TEXT_BUTTON}>
            Show {formatNumber(Math.min(rest, PAGE))} more of {formatNumber(rest)} {label}
          </button>
        </li>
      ) : null}
    </>
  );
}

function shownCount(stored: unknown): number | null {
  return typeof stored === "number" && Number.isSafeInteger(stored) && stored > 0 ? stored : null;
}

function HolonCard({ view, id }: { view: HolonView; id: string }) {
  const { focus, parent, children, seams, warnings } = view;
  const [shownChildren, setShownChildren] = usePersistedState<number>(`${id}:holon-children`, PAGE, shownCount);
  const [shownSeams, setShownSeams] = usePersistedState<number>(`${id}:holon-seams`, PAGE, shownCount);
  const below = belowText(focus.driftBelow);
  return (
    <div className="@container flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Glyph light={focus.light} />
          <h3 className="m-0 min-w-0 text-base font-medium leading-6 text-foreground [overflow-wrap:anywhere]">{focus.title}</h3>
          <span className={CHIP}>{focus.kind}</span>
          <span className={cn(CHIP, focus.status === "active" ? "" : TONE_CHIP.warn)}>{focus.status}</span>
          {below === null ? null : <span className={cn(CHIP, TONE_CHIP.warn)}>{below}</span>}
        </div>
        {parent === null ? null : <Parent parent={parent} />}
      </div>
      <Labelled label="Why">
        <p className="m-0 text-sm leading-5 text-foreground [overflow-wrap:anywhere]">{focus.why === "" ? "Nothing says why" : focus.why}</p>
      </Labelled>
      <Labelled label="Contract">
        <p className="m-0 text-sm leading-5 text-foreground [overflow-wrap:anywhere]">{focus.contract}</p>
      </Labelled>
      {focus.carriedBy.length === 0 ? null : (
        <Labelled label="Carried by">
          <p className="m-0 text-xs leading-5 text-foreground">{focus.carriedBy.map((carrier) => carrier.title).join(", ")}</p>
        </Labelled>
      )}
      <Labelled label="Proof">
        <ul aria-label="Sides" className="m-0 grid min-w-0 list-none grid-cols-1 gap-2 p-0 @lg:grid-cols-2">
          {SIDE_NAMES.map((name) => (
            <SideCell key={name} name={name} side={focus.sides[name]} />
          ))}
        </ul>
      </Labelled>
      {focus.drift.length === 0 ? null : (
        <Labelled label="Drift">
          <DriftList drift={focus.drift} />
        </Labelled>
      )}
      {focus.code.length === 0 ? null : (
        <Labelled label="Code">
          <ul aria-label="Code" className="m-0 flex min-w-0 list-none flex-col gap-0.5 p-0">
            {focus.code.map((path) => (
              <li key={path} className="min-w-0">
                <CodePath path={path} />
              </li>
            ))}
          </ul>
        </Labelled>
      )}
      {children.length === 0 ? null : (
        <Labelled label={`Parts (${formatNumber(children.length)})`}>
          <ul aria-label="Parts" className="m-0 flex min-w-0 list-none flex-col p-0">
            <Paged
              items={children}
              shown={shownChildren}
              more={() => setShownChildren((count) => count + PAGE)}
              label="parts"
              render={(child) => <ChildRow key={child.id} child={child} />}
            />
          </ul>
        </Labelled>
      )}
      {seams.length === 0 ? null : (
        <Labelled label={`Seams (${formatNumber(seams.length)})`}>
          <ul aria-label="Seams" className="m-0 flex min-w-0 list-none flex-col gap-1.5 p-0">
            <Paged
              items={seams}
              shown={shownSeams}
              more={() => setShownSeams((count) => count + PAGE)}
              label="seams"
              render={(seam, index) => <SeamRow key={`${seam.from}>${seam.to}#${index}`} seam={seam} />}
            />
          </ul>
        </Labelled>
      )}
      {warnings.length === 0 ? null : (
        <ul aria-label="Warnings" className="m-0 flex min-w-0 list-none flex-col gap-0.5 p-0">
          {warnings.map((warning, index) => (
            <li key={index} className="flex min-w-0 items-start gap-1.5 text-xs leading-5 text-warning-text [overflow-wrap:anywhere]">
              <Icon name="AlertTriangle" aria-hidden className="mt-[3px] size-3.5 shrink-0" />
              {warning}
            </li>
          ))}
        </ul>
      )}
      <p className={cn(CAPTION, "m-0")}>{`Computed ${view.computedAt} at ${view.commit}`}</p>
    </div>
  );
}

export function Holon({ props }: { props: Props }) {
  const read = useMemo(() => readHolonView(props.view), [props.view]);
  const id = useMemo(() => propsKey([props.view ?? null]), [props.view]);
  const depth = useContext(CardDepthContext);
  if (!read.ok) return <ErrorLine message={read.error} />;
  return (
    <CardDepthContext value={Math.max(depth, 1)}>
      <ReportFrame depth={depth} label={`Holon ${read.view.focus.title}`}>
        <HolonCard view={read.view} id={id} />
      </ReportFrame>
    </CardDepthContext>
  );
}
