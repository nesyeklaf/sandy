// Composer button + popup: choose pi's permission mode. The mode is global for pi
// on the host, so every composer shows and changes the same value.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, experimental_Icon as Icon, useComposer, useRealtime, useRpc } from "@sandy-sdk/plugin-sdk/app";
import { MODES, type PermissionView, type rpcContract } from "./contract.ts";

const POPUP_ID = "permissions";

const LABEL: Record<(typeof MODES)[number], { name: string; detail: string }> = {
  ask: { name: "Ask", detail: "confirm and ask rules prompt" },
  auto: { name: "Auto", detail: "only confirm rules prompt" },
  yolo: { name: "Yolo", detail: "no prompts; blocked commands stay blocked" },
};

const join = (...names: Array<string | false>) => names.filter(Boolean).join(" ");

function usePermissions() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<PermissionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  const refetch = useCallback(() => {
    rpc.call("state", {}).then((next) => { setState(next); setError(null); }, fail);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("changed", refetch);
  const setMode = useCallback((mode: (typeof MODES)[number]) => {
    rpc.call("setMode", { mode }).then((next) => { setState(next); setError(null); }, fail);
  }, [rpc]);
  const setReadOnly = useCallback((readOnly: boolean) => {
    rpc.call("setReadOnly", { readOnly }).then((next) => { setState(next); setError(null); }, fail);
  }, [rpc]);
  return { state, error, setMode, setReadOnly };
}

function PermissionButton() {
  const composer = useComposer();
  const { state } = usePermissions();
  const risky = state?.mode === "yolo";
  return (
    <button
      type="button"
      className={join("inline-flex h-8 items-center gap-1.5 rounded-md px-2 hover:bg-accent", risky && "text-destructive")}
      aria-label={`pi permissions: ${state === null ? "loading" : LABEL[state.mode].name}`}
      onClick={() => composer.experimental_openPopup(POPUP_ID)}
    >
      <Icon name={risky ? "ShieldAlert" : "Lock"} className="size-4" />
      <span className="text-xs">{state === null ? "…" : LABEL[state.mode].name + (state.readOnly ? " · read-only" : "")}</span>
    </button>
  );
}

function PermissionPopup() {
  const composer = useComposer();
  const { state, error, setMode, setReadOnly } = usePermissions();
  if (state === null) {
    return error !== null
      ? <p role="alert" className="p-3 text-sm text-destructive">{error}</p>
      : <p className="p-3 text-sm text-muted-foreground">Loading …</p>;
  }
  return (
    <div className="flex w-80 max-w-full flex-col gap-3 p-2">
      <section aria-label="Permission mode">
        <h3 className="px-2 pb-1 text-xs font-medium uppercase text-muted-foreground">pi permission mode</h3>
        <div role="radiogroup">
          {MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={state.mode === mode}
              onClick={() => setMode(mode)}
              className={join("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent", state.mode === mode && "bg-accent/60")}
            >
              <span className="min-w-0 flex-1">
                <span className="block">{LABEL[mode].name}</span>
                <span className="block text-xs text-muted-foreground">{LABEL[mode].detail}</span>
              </span>
              <Icon name="Check" className={join("size-4 shrink-0", state.mode !== mode && "opacity-0")} />
            </button>
          ))}
        </div>
      </section>
      <label className="flex items-center gap-2 px-2 text-sm">
        <input type="checkbox" checked={state.readOnly} onChange={(event) => setReadOnly(event.target.checked)} />
        Read-only (no file changes)
      </label>
      <p className="px-2 text-xs text-muted-foreground">
        Blocked: {state.programs.join(", ") || "nothing"}
        {state.allow.length > 0 ? ` · except ${state.allow.join(", ")}` : ""}
      </p>
      {error !== null ? <p role="alert" className="px-2 text-xs text-destructive">{error}</p> : null}
      <div className="flex justify-between px-2 text-xs text-muted-foreground">
        <span>Applies to pi on the next tool call.</span>
        <button type="button" className="rounded-md px-2 py-1 hover:bg-accent" onClick={() => composer.experimental_closePopup()}>Done</button>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "permissions",
    scopes: ["thread", "new-thread"],
    actions: [{ id: "permissions-button", component: PermissionButton }],
    experimental_popups: [{ id: POPUP_ID, label: "Permissions", component: PermissionPopup }],
  });
});
