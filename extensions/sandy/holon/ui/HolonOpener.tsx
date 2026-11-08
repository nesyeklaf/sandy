import { useEffect, useState, type ReactNode } from "react";
import { useRpc, type PluginFileOpenerProps } from "@sandy-sdk/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { ViewOutput } from "../core/outputs";

type Light = ViewOutput["focus"]["light"] | ViewOutput["focus"]["sides"]["I"]["light"];

const GLYPH: Record<Light, string> = {
  hard: "●",
  soft: "◐",
  claimed: "◌",
  open: "○",
  refuted: "✕",
  expired: "◇",
  drift: "◇",
};

const TONE: Record<Light, string> = {
  hard: "text-foreground",
  soft: "text-foreground",
  claimed: "text-muted-foreground",
  open: "text-muted-foreground",
  refuted: "text-destructive",
  expired: "text-destructive",
  drift: "text-destructive",
};

type State = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; view: ViewOutput };

function Lamp({ light }: { light: Light }) {
  return (
    <span className={TONE[light]} title={light} aria-label={light}>
      {GLYPH[light]}
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

function HolonView({ view, onOpen }: { view: ViewOutput; onOpen(id: string): void }) {
  const { focus } = view;
  return (
    <div className="h-full min-h-0 overflow-auto bg-background p-4 text-sm text-foreground">
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

export function HolonOpener({ path, source, Original }: PluginFileOpenerProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [focus, setFocus] = useState<string | undefined>(undefined);
  const [state, setState] = useState<State>({ status: "loading" });
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    setFocus(undefined);
  }, [path]);

  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    rpc
      .call("view", {
        source: { kind: source.kind, threadId: source.threadId, environmentId: source.environmentId },
        path,
        ...(focus === undefined ? {} : { id: focus }),
      })
      .then((result) => {
        if (!current) return;
        setState(result.ok ? { status: "ready", view: result.view } : { status: "error", error: result.error });
      })
      .catch((cause: unknown) => {
        if (current) setState({ status: "error", error: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      current = false;
    };
  }, [rpc, path, source.kind, source.threadId, source.environmentId, focus]);

  const toggle = (
    <button
      type="button"
      className="absolute right-3 top-3 z-10 inline-flex h-7 items-center rounded-md border border-border bg-background px-2 text-xs text-foreground hover:bg-state-hover"
      onClick={() => setRaw((value) => !value)}
    >
      {raw ? "Holon view" : "File"}
    </button>
  );

  if (raw || state.status === "error") {
    return (
      <div className="relative flex h-full min-h-0 flex-col">
        {state.status === "error" ? <p className="border-b border-border px-3 py-2 text-xs text-destructive" role="alert">{state.error}</p> : toggle}
        <div className="min-h-0 flex-1">
          <Original />
        </div>
      </div>
    );
  }
  if (state.status === "loading") {
    return <div className="flex h-full min-h-0 items-center justify-center text-sm text-muted-foreground">Computing the holon…</div>;
  }
  return (
    <div className="relative h-full min-h-0">
      {toggle}
      <HolonView view={state.view} onOpen={setFocus} />
    </div>
  );
}
