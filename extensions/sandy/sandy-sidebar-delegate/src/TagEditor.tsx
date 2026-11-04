import { useState } from "react";
import type { CSSProperties } from "react";
import { cn } from "./lib/utils";
import { hueOf } from "./topic-layout";
import "./topics.css";

const KIND_TEXT = {
  tag: { noun: "Tag", placeholder: "+ Tag", lowercase: true },
  topic: { noun: "Thema", placeholder: "+ Thema", lowercase: false },
} as const;

export function TagEditor({
  tags,
  label,
  kind = "tag",
  onChange,
}: {
  tags: readonly string[];
  label: string;
  kind?: keyof typeof KIND_TEXT;
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const text = KIND_TEXT[kind];
  const add = () => {
    const trimmed = draft.trim();
    const next = text.lowercase ? trimmed.toLowerCase() : trimmed;
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
            aria-label={`${text.noun} ${tag} entfernen`}
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
        placeholder={text.placeholder}
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
