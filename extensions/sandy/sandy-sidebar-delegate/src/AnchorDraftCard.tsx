import { useEffect, useRef, useState } from "react";
import { useRpc } from "@sandy-sdk/plugin-sdk/app";
import { closeAnchorDraft, type AnchorDraft } from "./anchor-draft";
import type { Anchor } from "./anchors-contract";
import type { sandySidebarRpcContract } from "./contract";
import "./anchors.css";

const KIND_LABEL: Record<Anchor["kind"], string> = {
  note: "Note for you",
  comment: "Comment for agents",
  tag: "Tag",
  link: "Link",
  bookmark: "Bookmark",
};

const PLACEHOLDER: Partial<Record<Anchor["kind"], string>> = {
  note: "What do you want to remember?",
  comment: "What should agents know about this?",
  tag: "Tags, separated by commas",
  link: "Where does this point? A thread id, URL or anchor",
};

/** The editor under a message while a mark is being written. */
export function AnchorDraftCard({ draft }: { draft: AnchorDraft & { kind: Anchor["kind"] } }) {
  const rpc = useRpc<typeof sandySidebarRpcContract>();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saved = useRef(false);

  const save = async () => {
    if (saved.current) return;
    saved.current = true;
    setSaving(true);
    try {
      const tags =
        draft.kind === "tag"
          ? text
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean)
          : [];
      await rpc.call("saveAnchor", {
        threadId: draft.threadId,
        kind: draft.kind,
        messageId: draft.messageId,
        seq: draft.seq,
        quote: draft.quote,
        body: draft.kind === "tag" ? "" : text.trim(),
        tags,
      });
      closeAnchorDraft();
    } catch (cause) {
      saved.current = false;
      setSaving(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // A bookmark has nothing to type: it saves as soon as it opens.
  useEffect(() => {
    if (draft.kind === "bookmark") void save();
  }, []);

  if (draft.kind === "bookmark") return null;
  return (
    <form
      className="sandy-anchor-card"
      data-kind={draft.kind}
      data-anchor-draft=""
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim() !== "") void save();
      }}
    >
      <div className="sandy-anchor-label">{KIND_LABEL[draft.kind]}</div>
      {draft.quote !== "" ? <blockquote className="sandy-anchor-quote">{draft.quote}</blockquote> : null}
      <textarea
        autoFocus
        rows={draft.kind === "tag" || draft.kind === "link" ? 1 : 3}
        className="sandy-anchor-input"
        placeholder={PLACEHOLDER[draft.kind]}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") closeAnchorDraft();
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && text.trim() !== "") void save();
        }}
      />
      {error === null ? null : <div className="sandy-anchor-error">{error}</div>}
      <div className="sandy-anchor-actions">
        <button type="submit" disabled={saving || text.trim() === ""}>
          Save
        </button>
        <button type="button" onClick={closeAnchorDraft}>
          Cancel
        </button>
      </div>
    </form>
  );
}
