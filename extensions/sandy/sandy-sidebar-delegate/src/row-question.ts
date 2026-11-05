import type { PluginSidebarThread, useSdk } from "@sandy-sdk/plugin-sdk/app";

type Interaction = Awaited<ReturnType<ReturnType<typeof useSdk>["threads"]["interactions"]["list"]>>[number];
type Resolution = Parameters<ReturnType<typeof useSdk>["threads"]["interactions"]["resolve"]>[0]["resolution"];

export type RowQuestionOption = { value: string; label: string };

export type RowQuestion = {
  interactionId: string;
  threadId: string;
  kind: "question" | "approval" | "form";
  prompt: string;
  questionId: string | null;
  options: readonly RowQuestionOption[];
};

const APPROVAL_SUBJECTS: Record<string, string> = {
  command: "Wants to run a command",
  file_change: "Wants to change files",
  permission_grant: "Wants more permissions",
  plan: "Wants approval for a plan",
  tool_use: "Wants to use a tool",
};

export function rowQuestionOf(interactions: readonly Interaction[]): RowQuestion | null {
  const pending = interactions
    .filter((interaction) => interaction.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!pending) return null;
  const base = { interactionId: pending.id, threadId: pending.threadId, questionId: null, options: [] };
  const payload = pending.payload;
  if (payload.kind === "user_question") {
    const [first] = payload.questions;
    if (!first) return null;
    const single = payload.questions.length === 1 && !first.multiSelect;
    const options = single ? (first.options ?? []).map(({ value, label }) => ({ value, label })) : [];
    return {
      ...base,
      kind: "question",
      prompt: payload.questions.length === 1 ? first.prompt : `${first.prompt} (+${payload.questions.length - 1} more)`,
      questionId: options.length > 0 ? first.id : null,
      options,
    };
  }
  if (payload.kind === "approval") {
    return {
      ...base,
      kind: "approval",
      prompt: payload.reason?.trim() || (APPROVAL_SUBJECTS[payload.subject.kind] ?? "Wants approval"),
    };
  }
  return {
    ...base,
    kind: "form",
    prompt: "title" in payload && typeof payload.title === "string" ? payload.title : "Waiting for your input",
  };
}

export function questionAnswer(question: RowQuestion, option: RowQuestionOption): Resolution {
  return { kind: "user_answer", answers: { [question.questionId ?? ""]: { selected: [option.value] } } };
}

export function askingThreadOf(
  thread: PluginSidebarThread,
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>,
): PluginSidebarThread | null {
  if (thread.hasPendingInteraction) return thread;
  for (const child of childrenByParent.get(thread.id) ?? []) {
    if (child.isArchived) continue;
    const asking = askingThreadOf(child, childrenByParent);
    if (asking) return asking;
  }
  return null;
}
