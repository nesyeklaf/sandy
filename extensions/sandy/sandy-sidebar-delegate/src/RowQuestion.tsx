import { useEffect, useState } from "react";
import { useSdk, type PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { Icon } from "./components/Icon";
import { cn } from "./lib/utils";
import { toast } from "./lib/toast";
import { threadDisplayTitle } from "./inbox";
import { ANSWER_HOLD_MS } from "./answer-hold";
import { useAnswerHold, useHeldAnswer } from "./AnswerHoldHost";
import { questionAnswer, rowQuestionOf, type RowQuestion as Question, type RowQuestionOption } from "./row-question";
import { statusToneClass } from "./StatusSlot";

const BUTTON =
  "pointer-events-auto h-6 min-w-0 max-w-full truncate rounded-md border px-2 text-xs font-medium outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none";

function usePendingQuestion(asker: PluginSidebarThread): Question | null {
  const sdk = useSdk();
  const [loaded, setLoaded] = useState<{ threadId: string; question: Question | null } | null>(null);
  const revision = `${asker.latestAttentionAt}:${asker.updatedAt}`;
  useEffect(() => {
    const controller = new AbortController();
    void sdk.threads.interactions.list({ threadId: asker.id, signal: controller.signal }).then(
      (interactions) => {
        if (!controller.signal.aborted) setLoaded({ threadId: asker.id, question: rowQuestionOf(interactions) });
      },
      () => {
        if (!controller.signal.aborted) setLoaded({ threadId: asker.id, question: null });
      },
    );
    return () => controller.abort();
  }, [sdk, asker.id, revision]);
  return loaded?.threadId === asker.id ? loaded.question : null;
}

export function RowQuestion({
  thread,
  asker,
  onOpen,
  onLater,
}: {
  thread: PluginSidebarThread;
  asker: PluginSidebarThread;
  onOpen: () => void;
  onLater: () => void;
}) {
  const sdk = useSdk();
  const hold = useAnswerHold();
  const question = usePendingQuestion(asker);
  const held = useHeldAnswer(hold, question?.interactionId ?? null);
  if (!question) return null;
  const who = asker.id === thread.id ? null : threadDisplayTitle(asker).split(":")[0];
  const answer = (option: RowQuestionOption) => {
    const { interactionId, threadId } = question;
    hold.hold(interactionId, { label: option.label }, () => {
      sdk.threads.interactions
        .resolve({ threadId, interactionId, resolution: questionAnswer(question, option) })
        .catch((error: unknown) =>
          toast.error("Could not send the answer", {
            description: error instanceof Error ? error.message : String(error),
          }),
        );
    });
    toast.success(`Answered “${option.label}”`, {
      description: threadDisplayTitle(thread),
      duration: ANSWER_HOLD_MS,
      action: { label: "Undo", onClick: () => hold.cancel(interactionId) },
    });
  };
  return (
    <div data-row-question="" className="pointer-events-none relative mt-1.5 min-w-0">
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-foreground">
        <Icon
          name={question.kind === "approval" ? "Alert" : "CircleQuestion"}
          aria-hidden
          className={cn("size-3 shrink-0", statusToneClass("waiting-for-input"))}
        />
        <span className="min-w-0 truncate">
          {who ? <span className="text-muted-foreground">{who}: </span> : null}
          {question.prompt}
        </span>
      </div>
      <div
        role="group"
        aria-label={`Answer ${threadDisplayTitle(asker)}`}
        className="mt-1.5 flex min-w-0 items-center gap-1.5"
      >
        {held ? (
          <>
            <span className="min-w-0 truncate text-xs text-muted-foreground">Answered “{held.label}”</span>
            <button
              type="button"
              className={cn(BUTTON, "shrink-0 border-transparent text-muted-foreground hover:text-foreground")}
              onClick={() => hold.cancel(question.interactionId)}
            >
              Undo
            </button>
          </>
        ) : (
          <>
            {question.options.length > 0 ? (
              question.options.map((option, index) => (
                <button
                  key={option.value}
                  type="button"
                  className={cn(
                    BUTTON,
                    "bg-secondary text-foreground hover:bg-sidebar-accent",
                    index === 0
                      ? "border-[color:color-mix(in_oklab,var(--sandy-sidebar-tone-pending)_45%,var(--border))]"
                      : "border-border",
                  )}
                  onClick={() => answer(option)}
                >
                  {option.label}
                </button>
              ))
            ) : (
              <button
                type="button"
                className={cn(BUTTON, "border-border bg-secondary text-foreground hover:bg-sidebar-accent")}
                onClick={onOpen}
              >
                Open
              </button>
            )}
            <button
              type="button"
              className={cn(
                BUTTON,
                "ml-auto shrink-0 border-transparent px-1.5 text-muted-foreground hover:text-foreground",
              )}
              onClick={onLater}
            >
              Later
            </button>
          </>
        )}
      </div>
    </div>
  );
}
