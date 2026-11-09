import type { ReactNode } from "react";
import { glyph, type ViewOutput } from "../core/outputs";
import type { Light } from "./holon-map-graph";

const TONE: Record<Light, string> = {
  hard: "text-foreground",
  soft: "text-foreground",
  claimed: "text-muted-foreground",
  open: "text-muted-foreground",
  refuted: "text-destructive",
  expired: "text-destructive",
  drift: "text-destructive",
};

function Lamp({ light }: { light: Light }) {
  return (
    <span className={TONE[light]} title={light} aria-label={light}>
      {glyph(light)}
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="text-xs font-medium uppercase text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function HolonLink({ id, title, light, onOpen, note }: { id: string; title: string; light: Light; onOpen(id: string): void; note?: string }) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onClick={() => onOpen(id)}
    >
      <Lamp light={light} />
      <span className="truncate">{title}</span>
      <span className="text-xs text-muted-foreground">{id}</span>
      {note === undefined ? null : <span className="ml-auto text-xs text-destructive">{note}</span>}
    </button>
  );
}

export function HolonView({ view, onOpen }: { view: ViewOutput; onOpen(id: string): void }) {
  const { focus } = view;
  return (
    <div className="bg-background p-4 text-sm text-foreground">
      <div className="mx-auto max-w-3xl space-y-4">
        {view.parent === null ? null : (
          <HolonLink id={view.parent.id} title={view.parent.title} light={view.parent.light} onOpen={onOpen} note={view.parent.driftBelow > 0 ? `◇ ${view.parent.driftBelow}` : undefined} />
        )}
        <header className="space-y-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Lamp light={focus.light} />
            {focus.title}
          </h2>
          <p className="text-xs text-muted-foreground">
            {focus.id} · {focus.kind} · {focus.status}
            {focus.carriedBy.length > 0 ? ` · carried by ${focus.carriedBy.map((item) => item.title).join(", ")}` : ""}
            {focus.driftBelow > 0 ? ` · ◇ ${focus.driftBelow} drift here and below` : ""}
          </p>
        </header>
        <Section title="Why">
          <p>{focus.why === "" ? "Nothing above asks for it yet." : focus.why}</p>
        </Section>
        <Section title="Contract">
          <p>{focus.contract}</p>
        </Section>
        <Section title="Sides">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {(["I", "It", "We", "They"] as const).map((side) => {
              const item = focus.sides[side];
              return [
                <dt key={`${side}-t`} className="flex items-center gap-2 font-medium">
                  <Lamp light={item.light} />
                  {side}
                </dt>,
                <dd key={`${side}-d`} className="text-muted-foreground">
                  {item.light}
                  {item.kind === null ? "" : ` · ${item.kind}`}
                  {item.source === null ? "" : ` ${item.source}`}
                  {item.by === null ? "" : ` · ${item.by}`}
                  {item.expires === null ? "" : ` · until ${item.expires}`}
                  {` · ${item.detail}`}
                </dd>,
              ];
            })}
          </dl>
        </Section>
        {focus.drift.length === 0 ? null : (
          <Section title="Drift">
            <ul className="space-y-1">
              {focus.drift.map((item, index) => (
                <li key={index} className="text-destructive">
                  ◇ {item.kind}
                  {item.side === null ? "" : ` ${item.side}`}
                  {item.seam === null ? "" : ` seam ${item.seam}`}: {item.detail}
                </li>
              ))}
            </ul>
          </Section>
        )}
        {view.children.length === 0 ? null : (
          <Section title="Parts">
            {view.children.map((child) => (
              <HolonLink key={child.id} id={child.id} title={child.title} light={child.light} onOpen={onOpen} note={child.driftBelow > 0 ? `◇ ${child.driftBelow}` : undefined} />
            ))}
          </Section>
        )}
        {view.seams.length === 0 ? null : (
          <Section title="Seams">
            <ul className="space-y-1">
              {view.seams.map((seam, index) => (
                <li key={index} className="flex flex-wrap items-baseline gap-2">
                  <Lamp light={seam.light} />
                  <button type="button" className="underline-offset-2 hover:underline" onClick={() => onOpen(seam.from === focus.id ? seam.to : seam.from)}>
                    {seam.from === focus.id ? `→ ${seam.toTitle}` : `← ${seam.fromTitle}`}
                  </button>
                  <span className="text-muted-foreground">{seam.contract}</span>
                  {seam.readOnly ? <span className="text-xs text-muted-foreground">read-only</span> : null}
                  {seam.exclusive ? <span className="text-xs text-muted-foreground">exclusive</span> : null}
                  {seam.drift === null ? null : <span className="text-xs text-destructive">◇ {seam.drift}</span>}
                </li>
              ))}
            </ul>
          </Section>
        )}
        {view.warnings.length === 0 ? null : (
          <Section title="Warnings">
            <ul>
              {view.warnings.map((warning) => (
                <li key={warning}>! {warning}</li>
              ))}
            </ul>
          </Section>
        )}
        <p className="text-xs text-muted-foreground">
          computed at {view.computedAt}, commit {view.commit.slice(0, 12)}
        </p>
      </div>
    </div>
  );
}
