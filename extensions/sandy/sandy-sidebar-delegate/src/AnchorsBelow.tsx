import { AnchorCard } from "./AnchorCard";
import { AnchorDraftCard } from "./AnchorDraftCard";
import { ExplainCard } from "./ExplainCard";
import { useAnchorDraft } from "./useAnchorDraft";
import { useAnchors } from "./useAnchors";

/** Everything the plugin shows under one message: its saved marks, then a draft. */
export function AnchorsBelow({ message }: { message: { id: string; threadId: string } }) {
  const draft = useAnchorDraft(message.id);
  const anchors = useAnchors(message.threadId).filter((anchor) => anchor.messageId === message.id);
  if (draft === null && anchors.length === 0) return null;
  return (
    <div className="sandy-anchors-below">
      {anchors.map((anchor) => (
        <AnchorCard key={anchor.id} anchor={anchor} />
      ))}
      {draft === null ? null : draft.kind === "explain" ? (
        <ExplainCard draft={draft} />
      ) : (
        <AnchorDraftCard draft={{ ...draft, kind: draft.kind }} />
      )}
    </div>
  );
}
