import { useSyncExternalStore } from "react";
import { type AnchorDraft, currentAnchorDraft, subscribeAnchorDraft } from "./anchor-draft";

/** The draft that belongs to one message, or null. */
export function useAnchorDraft(messageId: string): AnchorDraft | null {
  const draft = useSyncExternalStore(subscribeAnchorDraft, currentAnchorDraft);
  return draft !== null && draft.messageId === messageId ? draft : null;
}
