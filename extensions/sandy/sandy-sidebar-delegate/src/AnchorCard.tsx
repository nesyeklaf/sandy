import { useState } from "react";
import { useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { Anchor } from "./anchors-contract";
import type { sandySidebarRpcContract } from "./contract";

const LABEL: Record<Anchor["kind"], string> = {
  note: "Note",
  comment: "Comment",
  tag: "Tag",
  link: "Link",
  bookmark: "Bookmark",
};

/** One saved mark under its message; the body can be edited in place. */
export function AnchorCard({ anchor }: { anchor: Anchor }) {
  const rpc = useRpc<typeof sandySidebarRpcContract>();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(anchor.body);
  const fromAgent = anchor.author === "agent";
  const editable = anchor.kind === "note" || anchor.kind === "comment";

  const save = async () => {
    await rpc.call("saveAnchor", {
      id: anchor.id,
      threadId: anchor.threadId,
      kind: anchor.kind,
      messageId: anchor.messageId,
      seq: anchor.seq,
      quote: anchor.quote,
      body: text.trim(),
      tags: anchor.tags,
    });
    setEditing(false);
  };

  return (
    <div className="sandy-anchor-card" data-kind={anchor.kind} data-author={anchor.author} data-anchor-id={anchor.id}>
      <div className="sandy-anchor-label">
        {fromAgent ? "Agent " + LABEL[anchor.kind].toLowerCase() : LABEL[anchor.kind]}
        <span className="sandy-anchor-tools">
          {editable && !editing ? (
            <button type="button" aria-label="Edit" onClick={() => setEditing(true)}>
              Edit
            </button>
          ) : null}
          <button type="button" aria-label="Delete" onClick={() => void rpc.call("deleteAnchor", { id: anchor.id })}>
            Delete
          </button>
        </span>
      </div>
      {anchor.quote !== "" ? <blockquote className="sandy-anchor-quote">{anchor.quote}</blockquote> : null}
      {editing ? (
        <>
          <textarea
            className="sandy-anchor-input"
            rows={3}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="sandy-anchor-actions">
            <button type="submit" disabled={text.trim() === ""} onClick={() => void save()}>
              Save
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : anchor.body !== "" ? (
        <div className="sandy-anchor-body">{anchor.body}</div>
      ) : null}
      {anchor.tags.length > 0 ? (
        <div className="sandy-anchor-tags">
          {anchor.tags.map((tag) => (
            <span key={tag} className="sandy-anchor-tag">
              #{tag}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
