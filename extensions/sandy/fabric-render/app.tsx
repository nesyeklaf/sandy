// Thread panel tab: the session's fabric_exec calls as cards, newest first.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { Exec, ExecAudit, rpcContract } from "./contract.ts";
import { FabricRows } from "./fabric-rows.tsx";

const POLL_MS = 4000;
const DOT: Record<Exec["status"], string> = { running: "bg-amber-400", completed: "bg-emerald-500", failed: "bg-red-500" };
const clock = (at: number) => new Date(at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const took = (a: ExecAudit) => (a.startedAt !== undefined && a.endedAt !== undefined ? `${Math.max(0, a.endedAt - a.startedAt)} ms` : "");

function Audit({ audit }: { audit: ExecAudit }) {
  const args = Object.entries(audit.args ?? {});
  return (
    <li className="py-1">
      <div className="flex items-center gap-2 text-xs">
        <span className={`size-1.5 rounded-full ${audit.success === false ? "bg-red-500" : "bg-emerald-500"}`} />
        <code className="font-medium">{audit.tool ?? audit.ref}</code>
        <span className="ml-auto text-muted-foreground">{took(audit)}</span>
      </div>
      {args.length > 0 ? (
        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{args.map(([k, v]) => `${k}: ${v}`).join(" · ")}</div>
      ) : null}
      {audit.error ? <div className="mt-0.5 text-[11px] text-red-500">{audit.error}</div> : null}
      {audit.result ? <pre className="mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">{audit.result}</pre> : null}
    </li>
  );
}

function ExecCard({ exec }: { exec: Exec }) {
  const title = exec.name ?? exec.codeHead.split("\n")[0] ?? exec.itemId;
  return (
    <details className="rounded-md border border-border bg-card p-2" open={exec.status === "running"}>
      <summary className="flex cursor-pointer items-center gap-2 text-sm">
        <span className={`size-2 rounded-full ${DOT[exec.status]}`} />
        <span className="truncate font-medium">{title}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {exec.source === "entry" ? `${exec.auditCount} Aufrufe` : "ohne Details"} · {clock(exec.at)}
        </span>
      </summary>
      {exec.description ? <p className="mt-1 text-xs text-muted-foreground">{exec.description}</p> : null}
      {exec.audits.length > 0 ? (
        <ul className="mt-1 divide-y divide-border">{exec.audits.map((a, i) => <Audit key={`${a.ref}-${i}`} audit={a} />)}</ul>
      ) : (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">{exec.codeHead}</pre>
      )}
      {exec.truncated ? <p className="mt-1 text-[11px] text-amber-500">Gekürzt: nur die letzten {exec.audits.length} von {exec.auditCount} Aufrufen.</p> : null}
      {exec.resultText ? <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap border-t border-border pt-1 text-[11px]">{exec.resultText}</pre> : null}
    </details>
  );
}

function FabricPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [execs, setExecs] = useState<Exec[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    rpc.call("execs", { threadId }).then(
      (res) => { setExecs(res.execs); setError(null); },
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc, threadId]);
  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  return (
    <div className="flex flex-col gap-2 p-3">
      {error ? <div className="text-xs text-red-500">{error}</div> : null}
      {execs === null ? <div className="text-xs text-muted-foreground">Lade …</div> : null}
      {execs?.length === 0 ? <div className="text-xs text-muted-foreground">Keine fabric_exec-Aufrufe in dieser Session.</div> : null}
      {execs?.map((exec) => <ExecCard key={exec.itemId} exec={exec} />)}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "fabric-rows", component: FabricRows });
  app.slots.threadPanelAction({
    id: "fabric-render",
    title: "Fabric exec",
    icon: "Layers",
    layout: "padded",
    component: ({ threadId }) => <FabricPanel threadId={threadId} />,
  });
});
