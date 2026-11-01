// The chief-of-staff loop: dispatch backlog items to worker threads, route
// their questions through one chief thread, and escalate to the user.
import type { Item, ItemAction, Overview, Question } from "../contract";
import { parseBacklog } from "./backlog";
import { renderBrief } from "./brief";
import {
  answerMessage,
  chiefIntro,
  chiefQuestion,
  oneLine,
  workerPrompt,
} from "./prompts";
import { ACTIVE_STATUSES, CLOSED_STATUSES, type Store } from "./store";

export type Role = "worker" | "chief";

/** What the engine needs from sandy threads; server.ts adapts sandy.sdk.threads. */
export interface ThreadPort {
  spawn(args: {
    projectId: string;
    title: string;
    prompt: string;
    metadata: { role: Role; itemId?: number };
    /** Omitted fields fall back to the project's defaults. */
    execution?: ChiefExecution;
  }): Promise<string>;
  send(threadId: string, text: string): Promise<void>;
  stop(threadId: string): Promise<void>;
  retry(threadId: string): Promise<void>;
  /** "gone" covers deleted, archived, and unknown threads. */
  status(threadId: string): Promise<"idle" | "busy" | "gone">;
}

/** Provider, model and reasoning level of the chief thread. */
export interface ChiefExecution {
  providerId: string;
  model: string;
  reasoningLevel: string;
}

export interface EngineOptions {
  settings: () => { maxConcurrent: number; maxNudges: number; chief: ChiefExecution };
  notify: () => void;
  warn: (message: string) => void;
  now?: () => number;
}

/** A chief turn that stays this long on one question counts as stalled. */
const CHIEF_STALL_MS = 10 * 60_000;
const PRECEDENT_COUNT = 8;

const S = {
  paused: "paused",
  guidance: "guidance",
  chief: "chiefThreadId",
  inFlight: "inFlightQuestionId",
  inFlightAt: "inFlightAt",
  lastProject: "lastProjectId",
} as const;

export class ToolError extends Error {}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export class Engine {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(
    private readonly store: Store,
    private readonly threads: ThreadPort,
    private readonly options: EngineOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  // Serialize every state change, then publish one change signal.
  private locked<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(
      () => this.options.notify(),
      () => this.options.notify(),
    );
    return run;
  }

  // Reads

  chiefThreadId(): string | null {
    return this.store.getState(S.chief);
  }

  overview(): Overview {
    return {
      items: this.store.items(),
      decisions: this.store.questionsWithStatus("user"),
      answeredByChief: this.store.countAnsweredBy("chief"),
      activity: this.store.activity(40),
      paused: this.store.getState(S.paused) === "1",
      guidance: this.store.getState(S.guidance) ?? "",
      chiefThreadId: this.chiefThreadId(),
      lastProjectId: this.store.getState(S.lastProject),
      maxConcurrent: this.options.settings().maxConcurrent,
    };
  }

  brief(): string {
    const view = this.overview();
    return renderBrief({ ...view, activity: view.activity });
  }

  // User commands

  addBacklog(text: string, projectId: string): Promise<Item[]> {
    return this.locked(async () => {
      const entries = parseBacklog(text);
      if (entries.length === 0) throw new Error("No backlog items found in that text.");
      const items = this.store.addItems(entries, projectId);
      this.store.setState(S.lastProject, projectId);
      this.store.log(null, `Added ${items.length} backlog item${items.length === 1 ? "" : "s"}`);
      await this.pump();
      return items;
    });
  }

  decide(questionId: number, answer: string): Promise<void> {
    return this.locked(async () => {
      const question = this.store.question(questionId);
      if (question === null || question.status !== "user") {
        throw new Error(`Question ${questionId} is not waiting on you.`);
      }
      const answered = this.store.answer(questionId, answer, "user");
      this.store.log(question.itemId, `You decided Q${questionId}: ${oneLine(answer, 80)}`);
      if (question.kind !== "prompt") await this.deliver(answered, answer, "user");
      this.resumeIfClear(question.itemId);
      await this.pump();
    });
  }

  itemAction(itemId: number, action: ItemAction): Promise<void> {
    return this.locked(async () => {
      const item = this.store.item(itemId);
      if (item === null) throw new Error(`No backlog item ${itemId}.`);
      const active = ACTIVE_STATUSES.includes(item.status);
      if ((action === "cancel" || action === "remove") && active && item.threadId !== null) {
        await this.threads.stop(item.threadId).catch((cause) => {
          this.options.warn(`stop ${item.threadId} failed: ${message(cause)}`);
        });
      }
      if (action === "remove") {
        this.store.removeItem(itemId);
        this.store.log(null, `Removed item #${itemId} ${item.title}`);
      } else if (action === "cancel") {
        if (!CLOSED_STATUSES.includes(item.status)) {
          this.store.dropOpenQuestions(itemId);
          this.store.updateItem(itemId, { status: "cancelled" });
          this.store.log(itemId, `Cancelled #${itemId} ${item.title}`);
        }
      } else if (item.status === "failed" && item.threadId !== null) {
        await this.threads.retry(item.threadId);
        this.store.updateItem(itemId, { status: "running" });
        this.store.log(itemId, `Retried #${itemId} ${item.title}`);
      } else if (item.status === "failed" || item.status === "cancelled") {
        this.store.updateItem(itemId, { status: "queued", threadId: null, nudges: 0, summary: null });
        this.store.log(itemId, `Requeued #${itemId} ${item.title}`);
      } else {
        throw new Error(`Item #${itemId} is ${item.status}; only failed or cancelled items can be retried.`);
      }
      this.clearInFlightIfGone();
      await this.pump();
    });
  }

  setPaused(paused: boolean): Promise<void> {
    return this.locked(async () => {
      this.store.setState(S.paused, paused ? "1" : null);
      this.store.log(null, paused ? "Paused dispatch" : "Resumed dispatch");
      await this.pump();
    });
  }

  setGuidance(text: string): Promise<void> {
    return this.locked(() => {
      this.store.setState(S.guidance, text.trim() === "" ? null : text);
    });
  }

  /** Periodic reconciliation: recover a stalled chief and fill free slots. */
  tick(): Promise<void> {
    return this.locked(async () => {
      const since = Number(this.store.getState(S.inFlightAt) ?? "0");
      const chief = this.chiefThreadId();
      if (this.inFlight() !== null && chief !== null && this.now() - since > CHIEF_STALL_MS) {
        if ((await this.threads.status(chief)) !== "busy") {
          this.escalateInFlight("The chief of staff did not decide this question.");
        }
      }
      await this.pump();
    });
  }

  // Worker tools

  workerAsk(
    threadId: string,
    input: { question: string; context?: string; options?: string[] },
  ): Promise<string> {
    return this.locked(async () => {
      const item = this.openItemForThread(threadId);
      const question = this.store.addQuestion({
        itemId: item.id,
        kind: "ask",
        question: input.question,
        context: input.context,
        options: input.options,
        status: "chief",
      });
      this.store.updateItem(item.id, { status: "waiting_chief" });
      this.store.log(item.id, `#${item.id} asked Q${question.id}: ${oneLine(input.question, 80)}`);
      await this.pump();
      return `Question Q${question.id} is filed with the chief of staff. End your turn now; the answer arrives as a new message.`;
    });
  }

  workerReport(threadId: string, input: { status: "progress" | "done"; summary: string }): Promise<string> {
    return this.locked(async () => {
      const item = this.openItemForThread(threadId);
      if (input.status === "done") {
        this.store.dropOpenQuestions(item.id);
        this.store.updateItem(item.id, { status: "done", summary: input.summary });
        this.store.log(item.id, `#${item.id} done: ${oneLine(input.summary, 100)}`);
        this.clearInFlightIfGone();
        await this.pump();
        return "Recorded as done. End your turn.";
      }
      this.store.updateItem(item.id, { lastUpdate: input.summary });
      this.store.log(item.id, `#${item.id}: ${oneLine(input.summary, 100)}`);
      return "Progress recorded. Keep going.";
    });
  }

  // Chief tools

  chiefAnswer(threadId: string, input: { questionId: number; answer: string }): Promise<string> {
    return this.locked(async () => {
      const question = this.chiefOwnedQuestion(threadId, input.questionId);
      const answered = this.store.answer(question.id, input.answer, "chief");
      this.store.log(question.itemId, `Chief answered Q${question.id}: ${oneLine(input.answer, 80)}`);
      await this.deliver(answered, input.answer, "chief");
      this.resumeIfClear(question.itemId);
      this.clearInFlightIfGone();
      return `Sent your answer to the worker for item #${question.itemId}. End your turn.`;
    });
  }

  chiefEscalate(
    threadId: string,
    input: { questionId: number; why: string; options?: string[]; recommendation?: string },
  ): Promise<string> {
    return this.locked(() => {
      const question = this.chiefOwnedQuestion(threadId, input.questionId);
      this.store.escalate(question.id, input.why, input.recommendation ?? null, input.options);
      this.store.updateItem(question.itemId, { status: "waiting_user" });
      this.store.log(question.itemId, `Escalated Q${question.id} to you: ${oneLine(input.why, 80)}`);
      this.clearInFlightIfGone();
      return `Escalated Q${question.id} to the user. End your turn.`;
    });
  }

  chiefClose(threadId: string, input: { itemId: number; summary: string }): Promise<string> {
    return this.locked(async () => {
      this.assertChief(threadId);
      const item = this.store.item(input.itemId);
      if (item === null || CLOSED_STATUSES.includes(item.status)) {
        throw new ToolError(`Item #${input.itemId} is not open.`);
      }
      this.store.dropOpenQuestions(item.id);
      this.store.updateItem(item.id, { status: "done", summary: input.summary });
      this.store.log(item.id, `Chief closed #${item.id}: ${oneLine(input.summary, 100)}`);
      this.clearInFlightIfGone();
      await this.pump();
      return `Closed item #${item.id}. End your turn.`;
    });
  }

  // Thread events

  onIdle(threadId: string, lastAssistantText: string | null): Promise<void> {
    return this.locked(async () => {
      if (threadId === this.chiefThreadId()) {
        if (this.inFlight() !== null) {
          this.escalateInFlight(
            "The chief of staff ended its turn without deciding." +
              (lastAssistantText ? ` It said: ${oneLine(lastAssistantText, 300)}` : ""),
          );
        }
        await this.pump();
        return;
      }
      const item = this.store.itemByThread(threadId);
      if (item === null || item.status !== "running") return;
      if (this.store.openQuestions(item.id).length > 0) return;
      const lastText = (lastAssistantText ?? "").slice(0, 4000);
      if (lastText !== "") this.store.updateItem(item.id, { lastUpdate: lastText });
      const { maxNudges } = this.options.settings();
      const toUser = item.nudges >= maxNudges;
      const question = this.store.addQuestion({
        itemId: item.id,
        kind: "checkin",
        question: `The worker stopped without finishing: ${oneLine(lastText || "(no text)", 300)}`,
        context: lastText,
        status: toUser ? "user" : "chief",
        why: toUser ? `The worker stopped ${item.nudges + 1} times without finishing.` : null,
      });
      this.store.updateItem(item.id, { status: toUser ? "waiting_user" : "waiting_chief" });
      this.store.log(item.id, `#${item.id} stopped; check-in Q${question.id} ${toUser ? "needs you" : "sent to chief"}`);
      await this.pump();
    });
  }

  onActive(threadId: string): Promise<void> {
    return this.locked(() => {
      const item = this.store.itemByThread(threadId);
      if (item === null) return;
      if (this.store.dropOpenQuestions(item.id, "prompt") > 0) this.resumeIfClear(item.id);
    });
  }

  onInteraction(threadId: string): Promise<void> {
    return this.locked(() => {
      const item = this.store.itemByThread(threadId);
      if (item === null || !ACTIVE_STATUSES.includes(item.status)) return;
      if (this.store.openQuestions(item.id).some((q) => q.kind === "prompt")) return;
      const question = this.store.addQuestion({
        itemId: item.id,
        kind: "prompt",
        question: "The agent is waiting on an approval or question inside its thread.",
        status: "user",
        why: "Prompts inside a thread can only be answered there.",
      });
      this.store.updateItem(item.id, { status: "waiting_user" });
      this.store.log(item.id, `#${item.id} waits on a prompt in its thread (Q${question.id})`);
    });
  }

  onFailed(threadId: string, error: string | null): Promise<void> {
    return this.locked(async () => {
      if (threadId === this.chiefThreadId()) {
        if (this.inFlight() !== null) {
          this.escalateInFlight(`The chief of staff's turn failed: ${error ?? "unknown error"}`);
        }
        await this.pump();
        return;
      }
      const item = this.store.itemByThread(threadId);
      if (item === null || CLOSED_STATUSES.includes(item.status)) return;
      this.store.dropOpenQuestions(item.id);
      this.store.updateItem(item.id, { status: "failed", summary: error });
      this.store.log(item.id, `#${item.id} failed: ${oneLine(error ?? "unknown error", 100)}`);
      this.clearInFlightIfGone();
      await this.pump();
    });
  }

  onGone(threadId: string): Promise<void> {
    return this.locked(async () => {
      if (threadId === this.chiefThreadId()) {
        // The open question stays with the chief and goes to a fresh thread.
        this.store.setState(S.chief, null);
        this.store.setState(S.inFlight, null);
        this.store.log(null, "Chief of staff thread was removed; a new one starts on the next question");
        await this.pump();
        return;
      }
      const item = this.store.itemByThread(threadId);
      if (item === null || CLOSED_STATUSES.includes(item.status)) return;
      this.store.dropOpenQuestions(item.id);
      this.store.updateItem(item.id, { status: "cancelled" });
      this.store.log(item.id, `#${item.id} thread was removed; item cancelled`);
      this.clearInFlightIfGone();
      await this.pump();
    });
  }

  // Internals (always called inside `locked`)

  private async pump(): Promise<void> {
    await this.dispatchWorkers();
    await this.feedChief();
  }

  private async dispatchWorkers(): Promise<void> {
    if (this.store.getState(S.paused) === "1") return;
    const { maxConcurrent } = this.options.settings();
    while (this.store.activeCount() < maxConcurrent) {
      const item = this.store.nextQueued();
      if (item === null) return;
      this.store.updateItem(item.id, { status: "starting" });
      try {
        const threadId = await this.threads.spawn({
          projectId: item.projectId,
          title: item.title,
          prompt: workerPrompt(item),
          metadata: { role: "worker", itemId: item.id },
        });
        this.store.updateItem(item.id, { status: "running", threadId });
        this.store.log(item.id, `Started #${item.id} ${item.title}`);
      } catch (cause) {
        this.store.updateItem(item.id, { status: "failed", summary: `Could not start: ${message(cause)}` });
        this.store.log(item.id, `Could not start #${item.id}: ${oneLine(message(cause), 100)}`);
      }
    }
  }

  /** Send the oldest chief-owned question, one at a time, to an idle chief. */
  private async feedChief(): Promise<void> {
    this.clearInFlightIfGone();
    if (this.inFlight() !== null) return;
    const question = this.store.questionsWithStatus("chief")[0];
    if (question === undefined) return;
    const item = this.store.item(question.itemId)!;
    const text = chiefQuestion(
      question,
      item,
      this.store.getState(S.guidance) ?? "",
      this.store.recentUserDecisions(PRECEDENT_COUNT),
    );
    let chief = this.chiefThreadId();
    const status = chief === null ? "gone" : await this.threads.status(chief);
    if (status === "busy") return; // its idle event feeds the next question
    try {
      if (status === "gone") {
        chief = await this.threads.spawn({
          projectId: item.projectId,
          title: "Chief of staff",
          prompt: `${chiefIntro()}\n\n---\n\n${text}`,
          metadata: { role: "chief" },
          execution: this.options.settings().chief,
        });
        this.store.setState(S.chief, chief);
        this.store.log(null, "Started the chief of staff thread");
      } else {
        await this.threads.send(chief!, text);
      }
      this.store.setState(S.inFlight, String(question.id));
      this.store.setState(S.inFlightAt, String(this.now()));
    } catch (cause) {
      this.store.escalate(question.id, `The chief of staff is unavailable: ${message(cause)}`, null);
      this.store.updateItem(question.itemId, { status: "waiting_user" });
      this.store.log(question.itemId, `Chief unavailable; Q${question.id} needs you`);
    }
  }

  private inFlight(): Question | null {
    const id = this.store.getState(S.inFlight);
    return id === null ? null : this.store.question(Number(id));
  }

  /** Forget the in-flight marker once its question left the chief. */
  private clearInFlightIfGone(): void {
    const id = this.store.getState(S.inFlight);
    if (id === null) return;
    if (this.store.question(Number(id))?.status !== "chief") {
      this.store.setState(S.inFlight, null);
      this.store.setState(S.inFlightAt, null);
    }
  }

  private escalateInFlight(why: string): void {
    const question = this.inFlight();
    this.store.setState(S.inFlight, null);
    this.store.setState(S.inFlightAt, null);
    if (question === null || question.status !== "chief") return;
    this.store.escalate(question.id, why, null);
    this.store.updateItem(question.itemId, { status: "waiting_user" });
    this.store.log(question.itemId, `Q${question.id} needs you: ${oneLine(why, 80)}`);
  }

  private async deliver(question: Question, answer: string, by: "chief" | "user"): Promise<void> {
    const item = this.store.item(question.itemId);
    if (item === null || item.threadId === null || CLOSED_STATUSES.includes(item.status)) return;
    if (question.kind === "checkin") this.store.updateItem(item.id, { nudges: item.nudges + 1 });
    try {
      await this.threads.send(item.threadId, answerMessage(question, answer, by));
    } catch (cause) {
      this.store.log(item.id, `Could not message #${item.id}: ${oneLine(message(cause), 100)}`);
    }
  }

  /** Back to running once nothing is open; closed items stay closed. */
  private resumeIfClear(itemId: number): void {
    const item = this.store.item(itemId);
    if (item === null || CLOSED_STATUSES.includes(item.status)) return;
    if (this.store.openQuestions(itemId).length === 0 && item.status !== "running") {
      this.store.updateItem(itemId, { status: "running" });
    }
  }

  private openItemForThread(threadId: string): Item {
    const item = this.store.itemByThread(threadId);
    if (item === null || CLOSED_STATUSES.includes(item.status)) {
      throw new ToolError("This thread is not working on an open chief-of-staff backlog item.");
    }
    return item;
  }

  private assertChief(threadId: string): void {
    if (threadId !== this.chiefThreadId()) {
      throw new ToolError("Only the chief of staff thread can use this tool.");
    }
  }

  private chiefOwnedQuestion(threadId: string, questionId: number): Question {
    this.assertChief(threadId);
    const question = this.store.question(questionId);
    if (question === null || question.status !== "chief") {
      throw new ToolError(`Question ${questionId} is not waiting on the chief of staff.`);
    }
    return question;
  }
}
