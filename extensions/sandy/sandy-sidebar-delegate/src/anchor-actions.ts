import { openAnchorDraft } from "./anchor-draft";
import { registerSelectionAction } from "./anchors-extension";
import type { Anchor } from "./anchors-contract";

const PILL: { kind: Anchor["kind"] | "explain"; title: string; icon: string }[] = [
  { kind: "explain", title: "Explain", icon: "MessageQuestion" },
  { kind: "note", title: "Note", icon: "Edit" },
  { kind: "comment", title: "Comment", icon: "MessageSquare" },
  { kind: "tag", title: "Tag", icon: "Filter" },
  { kind: "link", title: "Link", icon: "Workflow" },
  { kind: "bookmark", title: "Bookmark", icon: "Target" },
];

/** The pill on selected chat text: one selection-only action per kind of mark. */
export function registerAnchorActions(slots: object): void {
  for (const { kind, title, icon } of PILL) {
    registerSelectionAction(slots, {
      id: "anchor-" + kind,
      title,
      icon,
      surfaces: ["selection"],
      run: ({ threadId, message, selectedText }) =>
        openAnchorDraft({
          threadId,
          messageId: message.id,
          seq: message.experimental_messageSeq ?? null,
          quote: selectedText ?? "",
          kind,
        }),
    });
  }
}
