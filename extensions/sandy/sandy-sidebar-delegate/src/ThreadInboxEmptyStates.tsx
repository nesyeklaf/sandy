import { useEffect, useState } from "react";
import { Icon } from "./components/Icon";
import { pickWorkingEmptyLine } from "./working-empty-lines";
import "./working-empty-state.css";

/**
 * How long the initial load may run before the indicator shows. Most loads
 * finish well inside this, and a spinner that appears only to vanish at once
 * reads as a flicker, not as progress.
 */
const LOADING_INDICATOR_DELAY_MS = 200;

/**
 * The list's placeholder while sandy is still loading threads. The paragraph
 * mounts empty at the size it will have with text, so the layout does not
 * jump when the text arrives. Because the live region already exists before
 * its text is added, a screen reader announces "Loading threads…" once, and
 * says nothing when a load finishes before the delay. Unmounting on any new
 * status cancels the timer.
 */
export function ThreadListLoading() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), LOADING_INDICATOR_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <p role="status" className="px-2 py-6 text-center text-xs text-muted-foreground">
      <span className="flex h-4 items-center justify-center gap-1.5">
        {visible ? (
          <>
            <Icon
              name="Loading"
              aria-hidden="true"
              className="size-3.5 shrink-0 animate-spin opacity-75 motion-reduce:animate-none"
            />
            Loading threads…
          </>
        ) : null}
      </span>
    </p>
  );
}

export function ActiveEmptyState() {
  return (
    <div role="status" className="flex flex-col items-center px-5 pb-7 pt-8 text-center text-muted-foreground">
      <svg viewBox="0 0 180 104" className="mb-3 h-auto w-36" aria-hidden="true">
        <circle cx="132" cy="24" r="11" fill="currentColor" opacity="0.12" />
        <path d="M16 77c18-18 36-24 55-17 14 5 23 5 36-3 18-11 36-7 57 20" fill="currentColor" opacity="0.08" />
        <path
          d="M12 78c22-13 43-14 64-3 16 8 31 8 45 0 16-9 31-8 47 3"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.5"
          opacity="0.38"
        />
        <g
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          opacity="0.55"
        >
          <path d="M51 76c0-13-2-22-8-30M51 66c-6-3-10-7-13-12M51 61c5-5 8-10 9-16" />
          <path d="M104 77c1-12 5-21 12-28M107 66c6-2 11-6 15-11M108 62c-2-6-2-11-1-16" />
          <path d="M76 75c0-8-2-14-6-20M77 69c4-3 7-6 9-11" />
        </g>
      </svg>
      <p className="text-xs font-medium text-foreground/75">All clear. Time to touch some grass.</p>
    </div>
  );
}

/**
 * Active's placeholder while every thread is working: a small creature typing
 * away behind a laptop. The motion lives in working-empty-state.css.
 */
export function WorkingEmptyState() {
  // Drawn on mount, so the line changes between appearances, never while shown.
  const [line] = useState(() => pickWorkingEmptyLine());
  return (
    <div role="status" className="flex flex-col items-center px-5 pb-6 pt-7 text-center text-muted-foreground">
      <svg viewBox="40 14 110 80" className="mb-2 h-auto w-28" aria-hidden="true">
        <ellipse cx="90" cy="88" rx="38" ry="2.5" fill="currentColor" opacity="0.08" />
        <g className="sandy-sidebar-working-head">
          <path
            d="M70 66v-6c0-14 9-24 20-24s20 10 20 24v6z"
            fill="currentColor"
            fillOpacity="0.1"
            stroke="currentColor"
            strokeOpacity="0.55"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <g
            className="sandy-sidebar-working-sprout"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            opacity="0.55"
          >
            <path d="M90 36c0-4 1-7 3-9" />
            <path d="M93 27c3-3 7-3 9-1-2 3-6 4-9 1z" fill="currentColor" fillOpacity="0.3" />
          </g>
          <g fill="currentColor" opacity="0.7">
            <circle className="sandy-sidebar-working-eye" cx="84" cy="50" r="1.8" />
            <circle className="sandy-sidebar-working-eye" cx="96" cy="50" r="1.8" />
          </g>
          <g fill="currentColor" opacity="0.15">
            <ellipse cx="79.5" cy="54.5" rx="2.5" ry="1.2" />
            <ellipse cx="100.5" cy="54.5" rx="2.5" ry="1.2" />
          </g>
        </g>
        {/* Opaque so the bobbing head tucks behind the lid. */}
        <rect x="65" y="60" width="50" height="26" rx="3" style={{ fill: "var(--sidebar)" }} />
        <rect
          x="65"
          y="60"
          width="50"
          height="26"
          rx="3"
          fill="currentColor"
          fillOpacity="0.05"
          stroke="currentColor"
          strokeOpacity="0.55"
          strokeWidth="1.5"
        />
        <circle cx="90" cy="73" r="2" fill="currentColor" opacity="0.25" />
        <path d="M59 86h62" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" opacity="0.55" />
        <rect
          x="114"
          y="24"
          width="26"
          height="13"
          rx="6.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          opacity="0.35"
        />
        <g fill="currentColor">
          <circle className="sandy-sidebar-working-dot" cx="121" cy="30.5" r="1.4" opacity="0.25" />
          <circle className="sandy-sidebar-working-dot" cx="127" cy="30.5" r="1.4" opacity="0.25" />
          <circle className="sandy-sidebar-working-dot" cx="133" cy="30.5" r="1.4" opacity="0.25" />
        </g>
      </svg>
      <p className="text-xs font-medium text-foreground/75">{line}</p>
    </div>
  );
}
