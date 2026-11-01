// Every text the plugin sends to an agent lives here.
import type { Item, Question } from "../contract";

export const WORKER_TOOL_INSTRUCTIONS =
  "You work on one item from the user's backlog for their chief of staff. " +
  "Need a decision or information? Call cos_ask instead of asking in chat or using any " +
  "ask-the-user tool, then end your turn; the answer arrives as a new message. " +
  "Report milestones with cos_report status progress. When the item is finished, " +
  "call cos_report with status done and a short summary of the outcome.";

export const CHIEF_TOOL_INSTRUCTIONS =
  "You are the user's chief of staff. Answer routine questions from worker threads with " +
  "cos_answer. Escalate with cos_escalate only what the user must decide: spending money, " +
  "scope or priority changes, irreversible or destructive actions, anything published or " +
  "sent outside, credentials, and matters of taste the guidance does not settle. Use " +
  "cos_close_item when a stopped worker has clearly finished.";

const quote = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

export function workerPrompt(item: Item): string {
  return [
    `Backlog item #${item.id}: ${item.title}`,
    item.details === "" ? null : `\nDetails:\n${item.details}`,
    "",
    "Work on this item on your own until it is done. Make reasonable assumptions for " +
      "small choices and note them. When you need a decision you cannot make, call " +
      "cos_ask with the question, the context, and the options you see, then end your " +
      "turn. Post progress at milestones with cos_report (status progress). When you " +
      "finish, call cos_report with status done and a 2–4 sentence summary of what " +
      "changed and anything the user should check.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function chiefIntro(): string {
  return [
    "You are my chief of staff. Worker threads are working through my backlog, and " +
      "the chief-of-staff plugin sends you their questions one at a time.",
    "",
    "For each question either decide it yourself with cos_answer (a clear, actionable " +
      "answer the worker can act on) or call cos_escalate with why it needs me, the " +
      "options, and your recommendation. Decide routine engineering and product " +
      "choices yourself and keep escalations rare. When a worker stopped without asking " +
      "anything (a check-in), nudge it with cos_answer, or call cos_close_item if it " +
      "is finished. Do the work for exactly the question you are given, then end your turn.",
    "",
    "You may read the worker's thread with `sandy thread output <thread-id>` when the " +
      "question lacks context.",
  ].join("\n");
}

export function chiefQuestion(
  question: Question,
  item: Item,
  guidance: string,
  precedent: Question[],
): string {
  const header =
    question.kind === "checkin"
      ? `Check-in ${question.id}: the worker for item #${item.id} "${item.title}" stopped without asking or finishing.`
      : `Question ${question.id} from the worker for item #${item.id} "${item.title}".`;
  const lines = [header, `Worker thread: ${item.threadId ?? "none"}`, ""];
  if (question.kind === "checkin") {
    lines.push("Its last message:", quote(question.context || "(no text)"));
    lines.push(
      "",
      `Nudges so far: ${item.nudges}. Reply with cos_answer to tell it how to proceed, ` +
        "cos_close_item if it is done, or cos_escalate if it needs me.",
    );
  } else {
    lines.push("Question:", quote(question.question));
    if (question.context !== "") lines.push("", "Context:", quote(question.context));
    if (question.options.length > 0) {
      lines.push("", "Options the worker sees:", ...question.options.map((o) => `- ${o}`));
    }
  }
  if (guidance.trim() !== "") lines.push("", "My standing guidance:", quote(guidance));
  if (precedent.length > 0) {
    lines.push("", "Decisions I made recently (precedent):");
    for (const p of precedent) {
      lines.push(`- "${oneLine(p.question)}" → ${oneLine(p.answer ?? "")}`);
    }
  }
  lines.push("", `Handle question ${question.id} with one tool call, then end your turn.`);
  return lines.join("\n");
}

export function answerMessage(question: Question, answer: string, by: "chief" | "user"): string {
  const from = by === "user" ? "the user" : "the chief of staff";
  if (question.kind === "checkin") {
    return `Message from ${from}:\n\n${answer}\n\nContinue the item. Call cos_report with status done when it is finished.`;
  }
  return [
    `Answer from ${from} to your question:`,
    quote(question.question),
    "",
    answer,
    "",
    "Continue the item.",
  ].join("\n");
}

export function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
