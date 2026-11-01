// A thread's tokens as the page's list and its header both show them: the
// period's in bold, and its lifetime total under them, small and muted, after
// Value' coin stack. Display only.
import { cn } from "@/lib/utils";
import { formatTokens } from "@/usage/series";

/** Value' own coin stack, the sidebar's icon, marking a lifetime total. */
export function CoinsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <path
        d="M14 18C18.4183 18 22 14.4183 22 10C22 5.58172 18.4183 2 14 2C9.58172 2 6 5.58172 6 10C6 14.4183 9.58172 18 14 18Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
      <path
        d="M13.1669 20.9689C12.063 21.6239 10.7742 22 9.3975 22C5.31197 22 2 18.688 2 14.6025C2 13.2258 2.37607 11.937 3.03107 10.8331"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

/**
 * The period's tokens over the lifetime total. `header` is the smaller size
 * that keeps two lines about as tall as the header's 16px icons.
 */
export function TokenPair({
  period,
  total,
  header = false,
  muted = false,
}: {
  period: number;
  total: number;
  header?: boolean;
  /** For an archived thread's row, dimmed as the rest of it is. */
  muted?: boolean;
}) {
  return (
    <span className={cn("flex flex-col items-start whitespace-nowrap leading-none tabular-nums", header ? "gap-px" : "gap-0.5")}>
      <span className={cn("font-semibold", header ? "text-[10px]" : "text-[13px]", muted && "text-muted-foreground")}>
        {formatTokens(period)}
      </span>
      <span className={cn("inline-flex items-center gap-0.5 text-muted-foreground", header ? "text-[8px]" : "text-[11px]")}>
        <CoinsIcon className={header ? "size-2" : "size-2.5"} />
        {formatTokens(total)}
      </span>
    </span>
  );
}
