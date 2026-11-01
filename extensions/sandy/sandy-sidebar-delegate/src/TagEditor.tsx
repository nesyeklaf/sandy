import { useState } from "react";
import type { CSSProperties } from "react";
import { cn } from "./lib/utils";
import { hueOf } from "./topic-layout";
import "./topics.css";

/** Chips with an inline field: Enter adds, the cross removes. */
export function TagEditor({
  tags,
  label,
  onChange,
}: {
  tags: readonly string[];
  label: string;
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const next = draft.trim().toLowerCase();
    setDraft("");
    if (next && !tags.includes(next)) onChange([...tags, next]);
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.map((tag) => (
        <span key={tag} className="sandy-topics-chip" style={{ "--h": hueOf(tag) } as CSSProperties}>
          {tag}
          <button
            type="button"
            aria-label={`Tag ${tag} entfernen`}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onChange(tags.filter((existing) => existing !== tag))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        aria-label={label}
        placeholder="+ Tag"
        maxLength={40}
        className={cn(
          "h-5 w-16 rounded bg-transparent px-1 text-2xs outline-none placeholder:text-muted-foreground",
          "focus:w-24 focus:ring-1 focus:ring-ring",
        )}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
    </div>
  );
}
