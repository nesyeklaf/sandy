import { formatTokens } from "./TopicHeader";
import type { topicStats } from "./topic-messages";

/** Name the range you just picked; stays on top while the list scrolls. */
export function TopicDraftForm({
  from,
  to,
  open,
  editing,
  stats,
  title,
  onTitle,
  onSave,
  onCancel,
}: {
  from: number;
  to: number;
  open: boolean;
  editing: boolean;
  stats: ReturnType<typeof topicStats>;
  title: string;
  onTitle: (title: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="sticky top-0 z-10 flex flex-col gap-1 rounded-md border border-border bg-background p-2 shadow-sm"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="text-2xs text-muted-foreground">
        {open ? "Start set. Tap the last turn of the topic, or just name this one. " : null}#{from}–{to}: {stats.user}{" "}
        user · {stats.assistant} agent · {stats.lines} lines · {stats.words} words · {formatTokens(stats.tokens)} Tokens
      </div>
      <div className="flex gap-1">
        <input
          value={title}
          aria-label="Topic title"
          placeholder="Topic title"
          maxLength={120}
          className="h-6 min-w-0 flex-1 rounded border border-border bg-transparent px-1.5 outline-none focus:ring-1 focus:ring-ring"
          onChange={(event) => onTitle(event.target.value)}
        />
        <button
          type="submit"
          className="rounded bg-primary px-2 text-primary-foreground disabled:opacity-50"
          disabled={title.trim() === ""}
        >
          {editing ? "Save" : "Create topic"}
        </button>
        <button type="button" className="rounded px-2 text-muted-foreground hover:text-foreground" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
