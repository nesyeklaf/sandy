// Replaces SANDY's plain "Ran tool fabric_exec { code … }" rows with a pi-style card (title, description,
// one line per nested call, diffs for edit/write) and hides the redundant "Ran N tools" headers.
// SANDY has no slot for a core provider's tool rows, so this works on the timeline DOM: rows are found by
// `data-timeline-row-id="<thread>:tool:<itemId>"`, the card is portalled into the row and the native row
// content is hidden by CSS. A row without a render entry stays native.
import "./fabric-rows.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { experimental_Diff as Diff, experimental_SourceCode as SourceCode, useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { Exec, ExecAudit, rpcContract } from "./contract.ts";
import { toUnifiedPatch } from "./diff-patch.ts";

const POLL_MS = 3000;
const TOOL_MARK = ":tool:";

interface RowHost {
  key: string;
  threadId: string;
  itemId: string;
  host: HTMLElement;
}

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1).replace(".", ",")} s` : `${ms} ms`);

const took = (a: ExecAudit) => (a.startedAt !== undefined && a.endedAt !== undefined ? fmtMs(Math.max(0, a.endedAt - a.startedAt)) : "");

const oneLine = (text: string | undefined) => (text ?? "").split("\n")[0] ?? "";

const lineCount = (text: string) => text.replace(/\n+$/, "").split("\n").length;

/** The part of a nested call that identifies it, like pi's call line. */
const summary = (a: ExecAudit): string => {
  const args = a.args ?? {};
  switch (a.tool) {
    case "bash":
      return `$ ${oneLine(args.command)}`;
    case "powershell":
      return `PS> ${oneLine(args.command)}`;
    case "read":
    case "write":
    case "edit":
    case "ls":
      return args.path ?? "";
    case "grep":
    case "find":
      return [args.pattern, args.path].filter(Boolean).join(" in ");
    default:
      return Object.entries(args).map(([k, v]) => `${k}: ${v}`).join(" · ").slice(0, 160);
  }
};

const failed = (a: ExecAudit) => a.success === false || (a.exitCode !== undefined && a.exitCode !== 0);

/** The short badge after the call line: what the call produced, in a few characters. */
const badge = (a: ExecAudit): { text: string; bad: boolean } | null => {
  if (a.exitCode) return { text: `exit ${a.exitCode}`, bad: true };
  if (a.success === false) return { text: "Fehler", bad: true };
  if (a.diff) {
    const lines = a.diff.split("\n");
    const add = lines.filter((l) => l.startsWith("+")).length;
    const del = lines.filter((l) => l.startsWith("-")).length;
    return { text: `+${add} −${del}`, bad: false };
  }
  if (a.content) return { text: a.tool === "read" ? `${a.lines ?? lineCount(a.content)} Z.` : `neu · ${lineCount(a.content)} Z.`, bad: false };
  const text = a.output ?? (a.tool === "read" ? a.result : undefined);
  return text ? { text: `${lineCount(text)} Z.`, bad: false } : null;
};

function Call({ audit }: { audit: ExecAudit }) {
  const path = audit.args?.path ?? "file";
  const patch = useMemo(() => (audit.diff ? toUnifiedPatch(audit.diff, path) : null), [audit.diff, path]);
  const longCommand = audit.command !== undefined && (audit.command.includes("\n") || audit.command.length > 100);
  const raw = audit.output === undefined && audit.content === undefined && audit.tool !== "edit" && audit.tool !== "write" ? audit.result : undefined;
  const pretty = Boolean(patch || (audit.content && audit.tool !== "read"));
  const hasBody = pretty || Boolean(audit.content) || longCommand || Boolean(audit.error || audit.output || raw);
  // Only the pretty output and failures start open; successful bash output and raw results start closed.
  const [open, setOpen] = useState(pretty || failed(audit));
  const pill = badge(audit);
  return (
    <li className={`fr-call${open && hasBody ? " fr-open" : ""}`}>
      <div className={`fr-line${hasBody ? " fr-x" : ""}`} onClick={hasBody ? () => setOpen(!open) : undefined}>
        <span className="fr-chev">{hasBody ? "▶" : ""}</span>
        <span className="fr-tool">{audit.tool ?? audit.ref}</span>
        <span className="fr-text">{summary(audit)}</span>
        {pill ? <span className={`fr-pill${pill.bad ? " fr-pill-bad" : ""}`}>{pill.text}</span> : null}
        <span className="fr-took">{took(audit)}</span>
      </div>
      {open && hasBody ? (
        <div className="fr-body">
          {audit.error ? <div className="fr-error">{audit.error}</div> : null}
          {longCommand ? <div className="fr-diff"><SourceCode content={audit.command!} path="command.sh" overflow="wrap" /></div> : null}
          {patch ? <div className="fr-diff"><Diff patch={patch} path={path} overflow="scroll" /></div> : null}
          {!patch && audit.content ? <div className="fr-diff"><SourceCode content={audit.content} path={path} overflow="scroll" /></div> : null}
          {audit.output ? <pre className={`fr-out${audit.exitCode ? " fr-out-bad" : ""}`}>{audit.output}</pre> : null}
          {raw ? <pre className="fr-out">{raw}</pre> : null}
        </div>
      ) : null}
    </li>
  );
}

function ExecView({ exec }: { exec: Exec }) {
  const title = exec.name ?? oneLine(exec.codeHead);
  const calls = exec.audits.length;
  const [open, setOpen] = useState(true);
  const [original, setOriginal] = useState(false);
  const starts = exec.audits.map((a) => a.startedAt).filter((t): t is number => t !== undefined);
  const ends = exec.audits.map((a) => a.endedAt).filter((t): t is number => t !== undefined);
  const total = starts.length > 0 && ends.length > 0 ? fmtMs(Math.max(...ends) - Math.min(...starts)) : "";
  const meta = [`${exec.auditCount} ${exec.auditCount === 1 ? "Aufruf" : "Aufrufe"}`, total].filter(Boolean).join(" · ");
  return (
    <div className={`fr-card${open ? " fr-open" : ""}`}>
      <div className="fr-head" title={exec.description ?? undefined} onClick={() => setOpen(!open)}>
        <span className="fr-chev">▶</span>
        <span className={`fr-dot ${exec.status === "failed" ? "fr-bad" : exec.status === "running" ? "fr-run" : "fr-ok"}`} />
        <span className="fr-title">{title}</span>
        <span className="fr-took">{meta}</span>
      </div>
      {exec.description ? <div className="fr-desc">{exec.description}</div> : null}
      {open ? (
        <>
          {calls > 0 ? <ul className="fr-calls">{exec.audits.map((a, i) => <Call key={`${a.ref}-${i}`} audit={a} />)}</ul> : null}
          {exec.truncated ? <div className="fr-note">Gekürzt: nur die letzten {calls} von {exec.auditCount} Aufrufen.</div> : null}
          <div className={`fr-orig${original ? " fr-open" : ""}`}>
            <div className="fr-head fr-orig-head" onClick={() => setOriginal(!original)}>
              <span className="fr-chev">▶</span>
              <span>Original (Code und Rohergebnis)</span>
            </div>
            {original ? <pre className="fr-out fr-orig-body">{[exec.code, exec.resultText ? `→ ${exec.resultText}` : ""].filter(Boolean).join("\n\n")}</pre> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

const rowText = (row: Element) => row.querySelector(":scope > div button")?.textContent ?? "";

/** Opens collapsed "Ran N tools" groups (their rows only exist while open) and finds the fabric_exec rows. */
function scan(): RowHost[] {
  const found: RowHost[] = [];
  document.querySelectorAll<HTMLElement>('[data-timeline-row-id*=":work-summary:"]').forEach((row) => {
    row.setAttribute("data-fr-summary", "");
    const button = row.querySelector<HTMLButtonElement>(":scope > div > .group\\/timeline-row > button");
    if (button?.getAttribute("aria-expanded") === "false") button.click();
  });
  document.querySelectorAll<HTMLElement>(`[data-timeline-row-id*="${TOOL_MARK}"]`).forEach((row) => {
    if (!rowText(row).includes("fabric_exec")) return;
    const id = row.getAttribute("data-timeline-row-id") ?? "";
    const at = id.indexOf(TOOL_MARK);
    let host = row.querySelector<HTMLElement>(":scope > [data-fr-host]");
    if (!host) {
      host = document.createElement("div");
      host.setAttribute("data-fr-host", "");
      row.appendChild(host);
    }
    found.push({ key: id, threadId: id.slice(0, at), itemId: id.slice(at + TOOL_MARK.length), host });
  });
  return found;
}

export function FabricRows() {
  const rpc = useRpc<typeof rpcContract>();
  const [hosts, setHosts] = useState<RowHost[]>([]);
  const [execs, setExecs] = useState<Map<string, Exec>>(new Map());
  const hostsRef = useRef<RowHost[]>([]);

  useEffect(() => {
    let frame = 0;
    const run = () => {
      frame = 0;
      const next = scan();
      const prev = hostsRef.current;
      if (next.length === prev.length && next.every((h, i) => h.key === prev[i]!.key && h.host === prev[i]!.host)) return;
      hostsRef.current = next;
      setHosts(next);
    };
    const observer = new MutationObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(run);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    run();
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  const threads = useMemo(() => Array.from(new Set(hosts.map((h) => h.threadId))).sort().join(","), [hosts]);
  const unresolved = hosts.some((h) => !execs.has(`${h.threadId}\u0000${h.itemId}`));
  useEffect(() => {
    if (threads === "") return;
    let live = true;
    const load = () => {
      for (const threadId of threads.split(",")) {
        rpc.call("execs", { threadId, limit: 200 }).then(
          (res) => {
            if (!live) return;
            setExecs((old) => {
              const next = new Map(old);
              for (const e of res.execs) next.set(`${threadId}\u0000${e.itemId}`, e);
              return next;
            });
          },
          () => undefined,
        );
      }
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [rpc, threads, unresolved]);

  const cards: React.ReactNode[] = [];
  for (const h of hosts) {
    const exec = execs.get(`${h.threadId}\u0000${h.itemId}`);
    const row = h.host.parentElement;
    if (exec?.source === "entry") {
      row?.setAttribute("data-fr-row", "");
      cards.push(createPortal(<ExecView exec={exec} />, h.host, h.key));
    } else {
      row?.removeAttribute("data-fr-row");
    }
  }
  return <>{cards}</>;
}
