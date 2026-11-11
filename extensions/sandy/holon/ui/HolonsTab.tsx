import { useCallback, useEffect, useMemo, useState } from "react";
import { experimental_useCodeTheme, useRpc, type ExperimentalThreadTabProps } from "@sandy-sdk/plugin-sdk/app";
import type { rpcContract } from "../server";
import { HolonEditor, createHttpApi, distAssets, type Api } from "../vendor/holon-ui/holon-editor.js";
import "../vendor/holon-ui/holon-editor.css";
import { rpcFetch } from "./rpc-fetch";

export const EDITOR_ASSET_BASE = "/api/v1/plugins/holon/http/editor/";
const ASSETS = distAssets(EDITOR_ASSET_BASE, { mermaid: false });

type Probe = { state: "loading" } | { state: "ready" } | { state: "failed"; message: string };

function singleRoot(api: Api): Api {
  const { workspace: _workspace, project: _project, ...rest } = api;
  return rest;
}

export function HolonsTab({ threadId, environment }: ExperimentalThreadTabProps) {
  const rpc = useRpc<typeof rpcContract>();
  const { mode } = experimental_useCodeTheme();
  const api = useMemo(() => singleRoot(createHttpApi("", rpcFetch(rpc, threadId))), [rpc, threadId]);
  const [probe, setProbe] = useState<Probe>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const hasEnvironment = environment !== null;

  useEffect(() => {
    if (!hasEnvironment) return;
    let current = true;
    setProbe({ state: "loading" });
    rpc
      .call("forward", { threadId, method: "GET", path: "/v0/health" })
      .then((reply) => {
        if (!current) return;
        if (!reply.ok) setProbe({ state: "failed", message: reply.error });
        else if (reply.status >= 400) setProbe({ state: "failed", message: `holon serve answered ${reply.status}` });
        else setProbe({ state: "ready" });
      })
      .catch((cause: unknown) => {
        if (current) setProbe({ state: "failed", message: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      current = false;
    };
  }, [rpc, threadId, hasEnvironment, attempt]);

  if (!hasEnvironment) return <Notice>This thread has no workspace, so there are no holons to show.</Notice>;
  if (probe.state === "loading") return <Notice>Starting holon serve…</Notice>;
  if (probe.state === "failed") {
    return (
      <Notice>
        <span className="text-destructive">{probe.message}</span>
        <button type="button" className="rounded-md border border-border px-3 py-1 text-sm hover:bg-accent" onClick={retry}>
          Retry
        </button>
      </Notice>
    );
  }
  return (
    <div className="h-full min-h-0">
      <HolonEditor api={api} assets={ASSETS} theme={mode} style={{ height: "100%" }} />
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div role="status" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">{children}</div>;
}
