import type { CSSProperties } from "react";
import { hueOf } from "./topic-layout";
import "./topics.css";

/** All tags of the session's topics; pressing one dims everything without it. */
export function TopicTagBar({
  tags,
  active,
  onToggle,
}: {
  tags: readonly string[];
  active: string | null;
  onToggle: (tag: string) => void;
}) {
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by tag">
      {tags.map((tag) => (
        <button
          key={tag}
          type="button"
          className="sandy-topics-chip"
          style={{ "--h": hueOf(tag) } as CSSProperties}
          aria-pressed={active === tag}
          onClick={() => onToggle(tag)}
        >
          {tag}
        </button>
      ))}
    </div>
  );
}
