// The progress briefing, as markdown for the CLI and the panel's copy action.
import type { Activity, Item, Question } from "../contract";
import { oneLine } from "./prompts";

const LABELS: Record<Item["status"], string> = {
  queued: "Queued",
  starting: "Starting",
  running: "Working",
  waiting_chief: "With chief of staff",
  waiting_user: "Waiting on you",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function statusLabel(status: Item["status"]): string {
  return LABELS[status];
}

export interface BriefInput {
  items: Item[];
  decisions: Question[];
  answeredByChief: number;
  activity: Activity[];
  paused: boolean;
}

export function renderBrief({ items, decisions, answeredByChief, activity, paused }: BriefInput): string {
  const count = (statuses: Item["status"][]) =>
    items.filter((item) => statuses.includes(item.status)).length;
  const lines = ["# Chief of staff briefing", ""];
  if (items.length === 0) return [...lines, "The backlog is empty."].join("\n");
  lines.push(
    `${count(["done"])} of ${items.length} items done, ` +
      `${count(["starting", "running", "waiting_chief"])} in progress, ` +
      `${count(["queued"])} queued, ${count(["failed"])} failed. ` +
      `The chief of staff answered ${answeredByChief} questions so far.` +
      (paused ? " Dispatch is paused." : ""),
  );
  lines.push("", `## Decisions for you (${decisions.length})`, "");
  if (decisions.length === 0) lines.push("Nothing needs you right now.");
  for (const d of decisions) {
    lines.push(`- **Q${d.id}** · item #${d.itemId} ${d.itemTitle}: ${oneLine(d.question, 240)}`);
    if (d.why) lines.push(`  - Why you: ${oneLine(d.why, 240)}`);
    if (d.recommendation) lines.push(`  - Recommendation: ${oneLine(d.recommendation, 240)}`);
    if (d.options.length > 0) lines.push(`  - Options: ${d.options.join(" | ")}`);
  }
  lines.push("", "## Items", "");
  for (const item of items) {
    const note = item.summary ?? item.lastUpdate;
    lines.push(
      `- #${item.id} **${item.title}** — ${LABELS[item.status]}` +
        (note ? `: ${oneLine(note, 200)}` : ""),
    );
  }
  if (activity.length > 0) {
    lines.push("", "## Recent activity", "");
    for (const entry of activity.slice(0, 10)) {
      lines.push(`- ${new Date(entry.at).toISOString().slice(0, 16).replace("T", " ")} ${entry.text}`);
    }
  }
  return lines.join("\n");
}
