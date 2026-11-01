/**
 * Types of the sandy fork's experimental_threadTocExtension slot, kept here until
 * the published plugin SDK ships them. A host without the slot ignores it.
 */
export interface TocBand {
  fromSeq: number;
  toSeq: number;
  hue: number;
  label?: string;
  dashed?: boolean;
  active?: boolean;
}

export interface TocSelection {
  fromSeq: number;
  toSeq: number;
}

export interface TocTabProps {
  threadId: string;
  projectId: string;
  jumpToSeq(seq: number): void;
  railSelection: TocSelection | null;
  clearRailSelection(): void;
  /** User-message seq of the rail tick that matches the chat position, or null. */
  activeSeq?: number | null;
  /** The bracket under the pointer on the rail. */
  hoveredBand?: TocSelection | null;
  /** Lights a bracket on the rail from the tab; null clears it. */
  setHoveredRange?(range: TocSelection | null): void;
  /** Selects the tab of another registration in the same popover. */
  openTab?(id: string): void;
}

interface TocExtension {
  id: string;
  title: string;
  useBands(input: { threadId: string; projectId: string }): readonly TocBand[];
  tab?: { label: string; component: (props: TocTabProps) => unknown; experimental_default?: boolean };
}

/** Registers the extension when the host has the slot; returns whether it did. */
export function registerTocExtension(slots: object, extension: TocExtension): boolean {
  const register = (slots as { experimental_threadTocExtension?: (e: TocExtension) => void })
    .experimental_threadTocExtension;
  if (typeof register !== "function") return false;
  register.call(slots, extension);
  return true;
}
