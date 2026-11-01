import type { CSSProperties } from "react";
import { TagEditor } from "./TagEditor";
import { Icon } from "./components/Icon";
import { hueOf, type TopicEntry } from "./topic-layout";
import { topicStats } from "./topic-messages";
import type { TopicMessage } from "./topics-contract";
import "./topics.css";

export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k` : `~${tokens}`;
}

interface HeaderProps {
  entry: TopicEntry;
  messages: readonly TopicMessage[];
  threadId: string;
  onJump: () => void;
  onOpenChat: () => void;
  onUseRange: () => void;
  onDelete: () => void;
  onTags: (tags: string[]) => void;
  onAccept: () => void;
  onDiscard: () => void;
}

const action = "rounded px-1 hover:text-foreground";

/** Where a topic starts: title, counts and length, tags and actions. A suggestion offers accept and discard instead. */
export function TopicHeader({
  entry,
  messages,
  threadId,
  onJump,
  onOpenChat,
  onUseRange,
  onDelete,
  onTags,
  onAccept,
  onDiscard,
}: HeaderProps) {
  const stats = topicStats(messages, entry.fromSeq, entry.toSeq);
  const copyLink = () => {
    void navigator.clipboard?.writeText(`@thread:${threadId}#msg=${entry.fromSeq}`);
  };
  return (
    <div
      className="sandy-topics-header"
      style={{ "--h": entry.hue } as CSSProperties}
      data-suggested={entry.suggested ? "" : undefined}
    >
      <div className="flex items-start gap-2">
        {entry.suggested ? (
          <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-2xs font-bold uppercase tracking-wide text-violet-500">
            <Icon name="AiMagic" className="size-3" aria-hidden />
            AI suggestion
          </span>
        ) : null}
        <button type="button" className="min-w-0 flex-1 text-left text-sm font-bold" onClick={onJump}>
          {entry.title}
        </button>
        <span className="shrink-0 text-2xs text-muted-foreground">
          #{entry.fromSeq}–{entry.toSeq}
        </span>
      </div>
      <div className="text-2xs text-muted-foreground">
        {stats.user} user · {stats.assistant} agent · {stats.lines} lines · {stats.words} words ·{" "}
        {formatTokens(stats.tokens)} Tokens
      </div>
      {entry.suggested ? (
        <>
          <div className="flex flex-wrap gap-1">
            {entry.tags.map((tag) => (
              <span
                key={tag}
                className="sandy-topics-chip"
                data-suggested=""
                style={{ "--h": hueOf(tag) } as CSSProperties}
              >
                {tag}
              </span>
            ))}
          </div>
          <div className="flex gap-2 text-2xs">
            <button type="button" className="rounded-full bg-foreground px-3 py-1 text-background" onClick={onAccept}>
              Accept
            </button>
            <button type="button" className="px-2 text-muted-foreground hover:text-foreground" onClick={onDiscard}>
              Discard
            </button>
          </div>
        </>
      ) : (
        <>
          <TagEditor tags={entry.tags} label={`Tags for ${entry.title}`} onChange={onTags} />
          <div className="flex flex-wrap gap-2 text-2xs text-muted-foreground">
            <button type="button" className={action} onClick={onJump}>
              Show
            </button>
            <button type="button" className={action} onClick={onOpenChat}>
              In chat
            </button>
            <button type="button" className={action} onClick={onUseRange}>
              Change range
            </button>
            <button type="button" className={action} onClick={copyLink}>
              Copy link
            </button>
            <button type="button" className="ml-auto rounded px-1 hover:text-destructive" onClick={onDelete}>
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}
