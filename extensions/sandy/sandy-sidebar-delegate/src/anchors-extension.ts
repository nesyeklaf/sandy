/**
 * Types of the sandy fork's selection-only message actions and "below" message
 * metadata, kept here until the published plugin SDK ships them. A host
 * without them ignores the registration.
 */
interface SelectionAction {
  id: string;
  title: string;
  icon: string;
  surfaces: readonly ["selection"];
  run(context: {
    threadId: string;
    message: { id: string; experimental_messageSeq?: number | null };
    selectedText?: string;
  }): void;
}

interface BelowMetadata {
  id: string;
  placement: "below";
  component: (props: { message: { id: string; threadId: string } }) => unknown;
}

type Slots = {
  messageAction?: (registration: SelectionAction) => void;
  experimental_messageMetadata?: (registration: BelowMetadata) => void;
};

export function registerSelectionAction(slots: object, action: SelectionAction): boolean {
  const register = (slots as Slots).messageAction;
  if (typeof register !== "function") return false;
  register.call(slots, action);
  return true;
}

export function registerBelowMetadata(slots: object, metadata: BelowMetadata): boolean {
  const register = (slots as Slots).experimental_messageMetadata;
  if (typeof register !== "function") return false;
  try {
    register.call(slots, metadata);
    return true;
  } catch {
    // An SDK that does not know the placement rejects it; the cards just stay off.
    return false;
  }
}
