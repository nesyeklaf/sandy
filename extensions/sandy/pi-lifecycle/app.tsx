// Composer button + popup for the current session, and a page with every session per SANDY host.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, experimental_Icon as Icon, useComposer, useRealtime, useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { HostView, OneView, SessionView, rpcContract } from "./contract.ts";
import { ago, bytes } from "./format.ts";

const POPUP_ID = "pi-lifecycle";
const POLL_MS = 5000;

const join = (...names: Array<string | false>) => names.filter(Boolean).join(" ");
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const busy = (status: string | null) => status !== null && status !== "idle";

/** Fetches on mount, on a timer and whenever the server reports a change; actions report their error. */
function useLive<T>(load: (rpc: ReturnType<typeof useRpc<typeof rpcContract>>) => Promise<T>, key: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    load(rpc).then((next) => { setData(next); setError(null); }, (cause) => setError(message(cause)));
  }, [rpc, key]);
  useEffect(() => {
    refetch();
    const timer = setInterval(refetch, POLL_MS);
    return () => clearInterval(timer);
  }, [refetch]);
  useRealtime("changed", refetch);
  const act = useCallback(async (run: () => Promise<unknown>) => {
    try { await run(); setError(null); } catch (cause) { setError(message(cause)); }
    refetch();
  }, [refetch]);
  return { data, error, act, rpc };
}

function Facts({ session }: { session: SessionView }) {
  const hook = session.hook;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
      <dt className="text-muted-foreground">Started</dt><dd>{ago(session.startedAt)}</dd>
      <dt className="text-muted-foreground">Last reload</dt><dd>{hook === null ? "unknown (extension not loaded)" : `${ago(hook.lastReloadAt)}${hook.reloadCount > 0 ? ` · ${hook.reloadCount}×` : ""}${hook.reloadPending ? " · pending" : ""}`}</dd>
      <dt className="text-muted-foreground">CPU</dt><dd>{session.cpuPercent}%</dd>
      <dt className="text-muted-foreground">Memory</dt><dd>{bytes(session.rssBytes)}{session.children > 0 ? ` · ${session.children} sub-processes` : ""}</dd>
    </dl>
  );
}

function ActionButton(props: { label: string; icon: string; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className="inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs hover:bg-accent disabled:opacity-50"
    >
      <Icon name={props.icon} className="size-3.5" />
      {props.label}
    </button>
  );
}

function threadIdOf(composer: ReturnType<typeof useComposer>): string | null {
  const scope = composer.scope;
  return scope.kind === "thread" || scope.kind === "queued-message" ? scope.threadId : null;
}

function LifecycleButton() {
  const composer = useComposer();
  const threadId = threadIdOf(composer);
  const { data } = useLive((rpc) => (threadId === null ? Promise.resolve(null) : rpc.call("session", { threadId })), threadId ?? "");
  if (threadId === null) return null;
  const loaded = data?.session != null;
  return (
    <button
      type="button"
      className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 hover:bg-accent"
      aria-label={`pi: ${data === null ? "loading" : loaded ? "loaded" : "not loaded"}`}
      onClick={() => composer.experimental_openPopup(POPUP_ID)}
    >
      <Icon name="RotateCcw" className={join("size-4", !loaded && "opacity-50")} />
      <span className="text-xs">{data === null ? "…" : loaded ? bytes(data.session!.rssBytes) : "pi off"}</span>
    </button>
  );
}

function LifecyclePopup() {
  const composer = useComposer();
  const threadId = threadIdOf(composer);
  const { data, error, act, rpc } = useLive<OneView | null>((r) => (threadId === null ? Promise.resolve(null) : r.call("session", { threadId })), threadId ?? "");
  if (threadId === null) return <p className="p-3 text-sm text-muted-foreground">Open a session first.</p>;
  if (data === null) {
    return error !== null ? <p role="alert" className="p-3 text-sm text-destructive">{error}</p> : <p className="p-3 text-sm text-muted-foreground">Loading …</p>;
  }
  const session = data.session;
  const running = session !== null && busy(session.status);
  const restart = () => {
    if (running && !window.confirm("This session is running. Restarting interrupts it. Restart anyway?")) return;
    return act(() => rpc.call("restart", { threadId, force: running }));
  };
  return (
    <div className="flex w-80 max-w-full flex-col gap-3 p-3">
      <h3 className="text-xs font-medium uppercase text-muted-foreground">pi in this session</h3>
      {session === null ? (
        <p className="text-sm">pi is not loaded. The next message starts it fresh.</p>
      ) : (
        <>
          <p className="flex items-center gap-2 text-sm">
            <span className={join("size-2 rounded-full", running ? "bg-amber-500" : "bg-emerald-500")} />
            {running ? "Loaded · working" : "Loaded · idle"}
          </p>
          <Facts session={session} />
          <div className="flex gap-2">
            <ActionButton label="Reload" icon="RotateCcw" disabled={session.hook === null} title="Reload extensions, skills and settings when idle" onClick={() => act(() => rpc.call("reload", { threadId }))} />
            <ActionButton label="Restart" icon="Power" onClick={restart} title="Release pi; the next message starts a fresh process" />
          </div>
          {session.hook === null ? <p className="text-xs text-muted-foreground">Reload needs the lifecycle extension in this pi. Install it on the overview page, then restart once.</p> : null}
        </>
      )}
      {error !== null ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <div className="flex justify-end">
        <button type="button" className="rounded-md px-2 py-1 text-xs hover:bg-accent" onClick={() => composer.experimental_closePopup()}>Done</button>
      </div>
    </div>
  );
}

function HostSection({ host, act, rpc }: { host: HostView; act: (run: () => Promise<unknown>) => Promise<void>; rpc: ReturnType<typeof useRpc<typeof rpcContract>> }) {
  const [note, setNote] = useState<string | null>(null);
  const withNote = (run: () => Promise<{ count: number }>, verb: string) =>
    act(async () => { const { count } = await run(); setNote(`${verb} ${count} session(s)`); });
  const restartAll = () => {
    const running = host.sessions.filter((s) => busy(s.status)).length;
    if (!window.confirm(`Restart pi in ${host.sessions.length - running} idle session(s)?`)) return;
    const includeRunning = running > 0 && window.confirm(`${running} session(s) are running. Interrupt them too?`);
    return withNote(() => rpc.call("restartHost", { hostId: host.hostId, includeRunning }), "Restarted");
  };
  return (
    <section className="flex flex-col gap-2 rounded-lg border p-3" aria-label={host.name}>
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">{host.name}</h2>
        <span className="text-xs text-muted-foreground">{host.sessions.length} loaded</span>
        <span className="flex-1" />
        {!host.extensionInstalled ? <ActionButton label="Install extension" icon="Download" onClick={() => act(async () => { const { path } = await rpc.call("install", { hostId: host.hostId }); setNote(`Installed ${path}. Restart sessions once to load it.`); })} /> : null}
        <ActionButton label="Reload all" icon="RotateCcw" disabled={host.sessions.every((s) => s.hook === null)} onClick={() => withNote(() => rpc.call("reloadHost", { hostId: host.hostId }), "Reload requested for")} />
        <ActionButton label="Restart all" icon="Power" disabled={host.sessions.length === 0} onClick={restartAll} />
      </header>
      {host.error !== null ? <p role="alert" className="text-xs text-destructive">{host.error}</p> : null}
      {note !== null ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {host.sessions.length === 0 ? <p className="text-sm text-muted-foreground">No pi process is loaded.</p> : (
        <table className="w-full text-left text-xs">
          <thead className="text-muted-foreground"><tr><th className="py-1">Session</th><th>Started</th><th>Last reload</th><th>CPU</th><th>Memory</th><th /></tr></thead>
          <tbody>
            {host.sessions.map((s) => (
              <tr key={s.threadId} className="border-t">
                <td className="max-w-64 truncate py-1.5" title={s.threadId}>
                  <span className={join("mr-2 inline-block size-2 rounded-full", busy(s.status) ? "bg-amber-500" : "bg-emerald-500")} />
                  {s.title ?? s.threadId}
                </td>
                <td>{ago(s.startedAt)}</td>
                <td>{s.hook === null ? "?" : ago(s.hook.lastReloadAt)}</td>
                <td>{s.cpuPercent}%</td>
                <td>{bytes(s.rssBytes)}</td>
                <td className="flex justify-end gap-1 py-1">
                  <ActionButton label="Reload" icon="RotateCcw" disabled={s.hook === null} onClick={() => act(() => rpc.call("reload", { threadId: s.threadId }))} />
                  <ActionButton label="Restart" icon="Power" onClick={() => {
                    const running = busy(s.status);
                    if (running && !window.confirm("This session is running. Restart anyway?")) return;
                    return act(() => rpc.call("restart", { threadId: s.threadId, force: running }));
                  }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function OverviewPage() {
  const { data, error, act, rpc } = useLive((r) => r.call("hosts", {}), "hosts");
  return (
    <div className="flex flex-col gap-3 p-4">
      <h1 className="text-base font-medium">pi processes</h1>
      {error !== null ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {data === null ? <p className="text-sm text-muted-foreground">Loading …</p> : data.hosts.map((host) => <HostSection key={host.hostId} host={host} act={act} rpc={rpc} />)}
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "pi-lifecycle",
    scopes: ["thread"],
    actions: [{ id: "pi-lifecycle-button", component: LifecycleButton }],
    experimental_popups: [{ id: POPUP_ID, label: "pi lifecycle", component: LifecyclePopup }],
  });
  app.slots.navPanel({ id: "pi-lifecycle", title: "pi processes", icon: "RotateCcw", path: "pi-lifecycle", component: OverviewPage });
});
