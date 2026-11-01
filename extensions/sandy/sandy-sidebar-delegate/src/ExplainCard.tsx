import { useEffect, useState } from "react";
import { useRpc } from "@sandy-sdk/plugin-sdk/app";
import { type AnchorDraft, closeAnchorDraft } from "./anchor-draft";
import type { sandySidebarRpcContract } from "./contract";

type Answer = { state: "loading" } | { state: "done"; text: string } | { state: "failed"; message: string };

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** An explanation of the selected passage, shown under its message. Not stored unless saved as a note. */
export function ExplainCard({ draft }: { draft: AnchorDraft }) {
  const rpc = useRpc<typeof sandySidebarRpcContract>();
  const [answer, setAnswer] = useState<Answer>({ state: "loading" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let current = true;
    setAnswer({ state: "loading" });
    rpc
      .call("explainSelection", { threadId: draft.threadId, quote: draft.quote })
      .then((result) => current && setAnswer({ state: "done", text: result.text }))
      .catch((cause) => current && setAnswer({ state: "failed", message: messageOf(cause) }));
    return () => {
      current = false;
    };
  }, [rpc, draft.threadId, draft.quote]);

  const saveAsNote = async () => {
    if (answer.state !== "done") return;
    setSaving(true);
    try {
      await rpc.call("saveAnchor", {
        threadId: draft.threadId,
        kind: "note",
        messageId: draft.messageId,
        seq: draft.seq,
        quote: draft.quote,
        body: answer.text,
        tags: [],
      });
      closeAnchorDraft();
    } catch (cause) {
      setSaving(false);
      setAnswer({ state: "failed", message: messageOf(cause) });
    }
  };

  return (
    <div className="sandy-anchor-card" data-kind="explain" data-anchor-draft="" aria-busy={answer.state === "loading"}>
      <div className="sandy-anchor-label">Explanation</div>
      <blockquote className="sandy-anchor-quote">{draft.quote}</blockquote>
      {answer.state === "loading" ? <div className="sandy-anchor-pending">Explaining…</div> : null}
      {answer.state === "done" ? <div className="sandy-anchor-body">{answer.text}</div> : null}
      {answer.state === "failed" ? <div className="sandy-anchor-error">{answer.message}</div> : null}
      <div className="sandy-anchor-actions">
        {answer.state === "done" ? (
          <button type="button" disabled={saving} onClick={() => void saveAsNote()}>
            Save as note
          </button>
        ) : null}
        <button type="button" onClick={closeAnchorDraft}>
          Close
        </button>
      </div>
    </div>
  );
}
