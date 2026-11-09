import { useEffect, useMemo, useState } from "react";
import { useRpc, type PluginFileOpenerProps } from "@sandy-sdk/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { MapOutput, ViewOutput } from "../core/outputs";
import { HolonMap } from "./HolonMap";
import { HolonView } from "./HolonView";
import { buildModel, holonForFile } from "./holon-map-graph";

type ViewState = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; view: ViewOutput };
type MapState = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; map: MapOutput };

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function HolonOpener({ path, source, Original }: PluginFileOpenerProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [focus, setFocus] = useState<string | undefined>(undefined);
  const [viewState, setViewState] = useState<ViewState>({ status: "loading" });
  const [mapState, setMapState] = useState<MapState>({ status: "loading" });
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    setFocus(undefined);
  }, [path]);

  useEffect(() => {
    let current = true;
    setMapState({ status: "loading" });
    rpc
      .call("map", { source: { kind: source.kind, threadId: source.threadId, environmentId: source.environmentId }, path })
      .then((result) => {
        if (current) setMapState(result.ok ? { status: "ready", map: result.map } : { status: "error", error: result.error });
      })
      .catch((cause: unknown) => {
        if (current) setMapState({ status: "error", error: message(cause) });
      });
    return () => {
      current = false;
    };
  }, [rpc, path, source.kind, source.threadId, source.environmentId]);

  useEffect(() => {
    let current = true;
    rpc
      .call("view", {
        source: { kind: source.kind, threadId: source.threadId, environmentId: source.environmentId },
        path,
        ...(focus === undefined ? {} : { id: focus }),
      })
      .then((result) => {
        if (current) setViewState(result.ok ? { status: "ready", view: result.view } : { status: "error", error: result.error });
      })
      .catch((cause: unknown) => {
        if (current) setViewState({ status: "error", error: message(cause) });
      });
    return () => {
      current = false;
    };
  }, [rpc, path, source.kind, source.threadId, source.environmentId, focus]);

  const model = useMemo(() => (mapState.status === "ready" ? buildModel(mapState.map) : null), [mapState]);

  const toggle = (
    <button
      type="button"
      className="absolute right-3 top-3 z-10 inline-flex h-7 items-center rounded-md border border-border bg-background px-2 text-xs text-foreground hover:bg-state-hover"
      onClick={() => setRaw((value) => !value)}
    >
      {raw ? "Holon view" : "File"}
    </button>
  );

  if (raw || viewState.status === "error") {
    return (
      <div className="relative flex h-full min-h-0 flex-col">
        {viewState.status === "error" ? <p className="border-b border-border px-3 py-2 text-xs text-destructive" role="alert">{viewState.error}</p> : toggle}
        <div className="min-h-0 flex-1">
          <Original />
        </div>
      </div>
    );
  }
  if (viewState.status === "loading") {
    return <div className="flex h-full min-h-0 items-center justify-center text-sm text-muted-foreground">Computing the holon…</div>;
  }
  const selected = focus ?? (model === null ? null : (holonForFile(model, path) ?? viewState.view.focus.id));
  return (
    <div className="relative h-full min-h-0 overflow-auto bg-background">
      {toggle}
      <div className="mx-auto max-w-5xl space-y-4 p-4 pt-12">
        {model !== null && selected !== null ? <HolonMap key={path} model={model} selected={selected} onSelect={setFocus} /> : null}
        {mapState.status === "loading" ? <p className="text-sm text-muted-foreground">Computing the map…</p> : null}
        {mapState.status === "error" ? <p className="text-xs text-destructive" role="alert">Map unavailable: {mapState.error}</p> : null}
        <HolonView view={viewState.view} onOpen={setFocus} />
      </div>
    </div>
  );
}
