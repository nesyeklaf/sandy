import { useEffect, useState } from "react";
import { useComposer, useRpc } from "@sandy-sdk/plugin-sdk/app";
import { FLOW_PROVIDER_ID, type Flow, type rpcContract } from "./contract";
import { INPUT, errorText } from "./shared";

export const FLOW_POPUP_ID = "flows";

export function FlowsPopup() {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("overview", {}).then(
      (overview) => setFlows(overview.flows),
      (cause: unknown) => setError(errorText(cause)),
    );
  }, [rpc]);

  const wanted = query.trim().toLowerCase();
  const visible = (flows ?? []).filter(
    (flow) => wanted === "" || flow.name.toLowerCase().includes(wanted) || flow.description.toLowerCase().includes(wanted),
  );

  function pick(flow: Flow) {
    composer.insert({ provider: FLOW_PROVIDER_ID, id: flow.id, label: flow.name });
    composer.experimental_closePopup();
  }

  return (
    <div className="flex w-80 max-w-full flex-col gap-2 p-2">
      <input
        autoFocus
        className={INPUT}
        placeholder="Search flows"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && visible[0] !== undefined) pick(visible[0]);
        }}
      />
      {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
      {flows !== null && visible.length === 0 ? <p className="text-xs text-muted-foreground">No flows found.</p> : null}
      <div className="flex max-h-72 flex-col overflow-y-auto">
        {visible.map((flow) => (
          <button
            key={flow.id}
            type="button"
            className="flex flex-col items-start rounded px-2 py-1.5 text-left hover:bg-accent"
            onClick={() => pick(flow)}
          >
            <span className="text-sm">{flow.name}</span>
            <span className="text-xs text-muted-foreground">{flow.steps.map((step) => step.skill).join(" > ")}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
