// Composer button + popup: choose a persona (one) and skills (several) for
// the thread the composer belongs to.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useComposer, useRealtime, useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { PresetState, rpcContract } from "./contract";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type State = PresetState;
type Selection = { persona: string | null; skills: string[] };

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>;
/** Plain button; the vendored shadcn Button pulls in a package the server-side build cannot resolve. */
function Button({ className, ...props }: ButtonProps & { variant?: string; size?: string }) {
  const { variant: _v, size: _s, ...rest } = props;
  return <button {...rest} className={cn("inline-flex items-center rounded-md hover:bg-accent disabled:opacity-50", className)} />;
}

const POPUP_ID = "presets";

/** "thread:<id>" for an existing thread, "new:<projectId>" for the new-thread composer. */
function useScope(): string | null {
  const { scope } = useComposer();
  if (scope.kind === "thread" || scope.kind === "queued-message") return `thread:${scope.threadId}`;
  return scope.projectId === null ? null : `new:${scope.projectId}`;
}

function usePresets() {
  const rpc = useRpc<typeof rpcContract>();
  const scope = useScope();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    if (scope === null) return;
    rpc.call("state", { scope }).then(
      (next) => {
        setState(next);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc, scope]);
  useEffect(refetch, [refetch]);
  useRealtime("selection-changed", refetch);
  const select = useCallback(
    (selection: Selection) => {
      if (scope === null) return;
      rpc.call("select", { scope, selection }).then(refetch, (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
    },
    [rpc, scope, refetch],
  );
  return { state, error, select };
}

function PresetButton() {
  const composer = useComposer();
  const { state } = usePresets();
  const active = state !== null && (state.selection.persona !== null || state.selection.skills.length > 0);
  const label =
    state === null
      ? "Presets"
      : [state.selection.persona, ...state.selection.skills].filter((v): v is string => v !== null).join(" + ") ||
        "Presets";
  return (
    <Button
      type="button"
     
      className={cn("h-8 max-w-48 gap-1.5 px-2", active && "text-primary")}
      aria-label={`Presets: ${label}`}
      onClick={() => composer.experimental_openPopup(POPUP_ID)}
    >
      <Icon name={active ? "Sparkles" : "MessageCircle"} className="size-4" />
      {active ? <span className="truncate text-xs">{label}</span> : null}
    </Button>
  );
}

function Row({
  icon,
  name,
  detail,
  checked,
  kind,
  onClick,
}: {
  icon: string;
  name: string;
  detail?: string;
  checked: boolean;
  kind: "radio" | "check";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role={kind === "radio" ? "radio" : "checkbox"}
      aria-checked={checked}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
        checked && "bg-accent/60",
      )}
    >
      <Icon name={icon} className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {detail === undefined ? null : <span className="text-xs text-muted-foreground">{detail}</span>}
      <Icon name={checked ? "Check" : "Minus"} className={cn("size-4 shrink-0", !checked && "opacity-0")} />
    </button>
  );
}

function PresetPopup() {
  const composer = useComposer();
  const { state, error, select } = usePresets();
  if (error !== null) return <p role="alert" className="p-3 text-sm text-destructive">{error}</p>;
  if (state === null) return <p className="p-3 text-sm text-muted-foreground">Lade …</p>;
  const { selection } = state;
  const togglePersona = (id: string) => select({ ...selection, persona: selection.persona === id ? null : id });
  const toggleSkill = (id: string) =>
    select({
      ...selection,
      skills: selection.skills.includes(id) ? selection.skills.filter((s) => s !== id) : [...selection.skills, id],
    });
  const nothing = selection.persona === null && selection.skills.length === 0;
  return (
    <div className="flex max-h-96 w-80 max-w-full flex-col gap-3 overflow-y-auto p-2">
      <section aria-label="Persona">
        <h3 className="px-2 pb-1 text-xs font-medium uppercase text-muted-foreground">Persona (eine)</h3>
        <div role="radiogroup">
          {state.personas.map((p) => (
            <Row key={p.id} icon={p.icon} name={p.name} kind="radio" checked={selection.persona === p.id} onClick={() => togglePersona(p.id)} />
          ))}
          {state.personas.length === 0 ? <p className="px-2 text-sm text-muted-foreground">Keine Personas.</p> : null}
        </div>
      </section>
      <section aria-label="Skills">
        <h3 className="px-2 pb-1 text-xs font-medium uppercase text-muted-foreground">Skills (mehrere)</h3>
        {state.skills.map((p) => {
          const order = selection.skills.indexOf(p.id);
          return (
            <Row key={p.id} icon={p.icon} name={p.name} kind="check" checked={order >= 0} detail={order >= 0 ? `#${order + 1}` : undefined} onClick={() => toggleSkill(p.id)} />
          );
        })}
        {state.skills.length === 0 ? <p className="px-2 text-sm text-muted-foreground">Keine Skills.</p> : null}
      </section>
      {state.warnings.length > 0 || state.problems.length > 0 ? (
        <ul className="space-y-1 px-2 text-xs text-destructive">
          {[...state.warnings, ...state.problems].map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center justify-between px-2 text-xs text-muted-foreground">
        <span>{state.length} / {state.limit} Zeichen</span>
        <span className="flex gap-1">
          <Button type="button" className="px-2 py-1" disabled={nothing} onClick={() => select({ persona: null, skills: [] })}>
            Zurücksetzen
          </Button>
          <Button type="button" className="px-2 py-1" onClick={() => composer.experimental_closePopup()}>
            Fertig
          </Button>
        </span>
      </div>
      <p className="px-2 text-xs text-muted-foreground">Gilt ab der nächsten Session des Threads. Ordner: {state.dir}</p>
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "presets",
    scopes: ["thread", "new-thread"],
    actions: [{ id: "presets-button", component: PresetButton }],
    experimental_popups: [{ id: POPUP_ID, label: "Presets", component: PresetPopup }],
  });
});
