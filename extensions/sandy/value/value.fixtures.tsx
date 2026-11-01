// Invented data and sandy's thread frame, shared by the plugin's stories and the
// explore stories. Not a stories file, so Ladle lists none of these.
import { useEffect, useState, type ReactNode } from "react";
import type { PermissionMode, PromptTextMention } from "@sandy/domain";
import { Markdown } from "@sandy-sdk/plugin-sdk/app";
import { makeExecutionControlsProps, STORY_CLAUDE_CODE_MODELS, STORY_PROVIDER_OPTIONS } from "@sandy-ladle/story-fixtures";
import { AppPageHeader } from "@sandy-app/components/layout/AppPageHeader";
import { SidebarProvider } from "@sandy-app/components/ui/sidebar";
import { FollowUpPromptBox } from "@sandy-app/components/promptbox/FollowUpPromptBox";
import "@sandy-ladle/composer-plugin";
import { makeTypeaheadConfig } from "@sandy-ladle/story-fixtures";
import type { PickerOption } from "@sandy-app/components/pickers/OptionPicker";

import type { ContextMeterProps } from "./components/context-meter";
import type { ThreadTokens } from "./components/thread-token-count";
import { UsageView, type UsageData } from "./components/usage-view";
import type { Limit, ThreadUsage, TurnDetail, TurnTimeBreakdown } from "./usage/contract";
import { fillBars, windowFor, type RangeId } from "./usage/series";

export const NOW = new Date(2026, 8, 24, 14, 20);
export const HOUR = 3_600_000;

/** Invented usage: busy working hours, quiet nights, a deterministic wobble. */
export function fixtureHours(since: number) {
  const hours = [];
  for (let hour = since; hour <= NOW.getTime(); hour += HOUR) {
    const local = new Date(hour).getHours();
    const busy = local >= 9 && local <= 18 ? 1 : local >= 7 && local <= 21 ? 0.3 : 0;
    const wobble = 0.5 + ((hour / HOUR) * 7919 % 97) / 97;
    if (busy === 0) continue;
    const scale = busy * wobble;
    hours.push({
      hour,
      input: Math.round(180_000 * scale),
      cacheRead: Math.round(9_000_000 * scale),
      output: Math.round(60_000 * scale),
    });
  }
  return hours;
}

/** The hour that began `hoursAgo` hours before NOW's. */
export function hourAgo(hoursAgo: number): number {
  const hour = new Date(NOW);
  hour.setMinutes(0, 0, 0);
  return hour.getTime() - hoursAgo * HOUR;
}

export function thread(
  threadId: string,
  title: string | null,
  projectName: string,
  turns: number,
  cacheRead: number,
  /** How many hours before NOW each hour of its use began. */
  busyHoursAgo: number[],
  /** How many hours before NOW it was archived, or null while it is active. */
  archivedHoursAgo: number | null = null,
  /** Its latest context size; past 300K tints its row. */
  context: number | null = null,
): ThreadUsage {
  const input = Math.round(cacheRead * 0.02);
  const output = Math.round(cacheRead * 0.006);
  const total = input + cacheRead + output;
  const weights = busyHoursAgo.map((_, index) => 0.5 + ((index * 7919) % 97) / 97);
  const sum = weights.reduce((a, b) => a + b, 0);
  return {
    threadId,
    title,
    projectId: `prj_${projectName}`,
    projectName,
    providerId: threadId.endsWith("x") ? "codex" : "claude-code",
    archivedAt: archivedHoursAgo === null ? null : hourAgo(archivedHoursAgo),
    turns,
    context,
    // Turn lengths spread from seconds to half an hour, the way real turns do.
    turnTimes: Array.from({ length: Math.min(turns, 40) }, (_, index) => ({
      at: hourAgo(busyHoursAgo[index % busyHoursAgo.length]!) + index * 60_000,
      ms: Math.round(12_000 * 150 ** (((index * 7919 + threadId.length * 31) % 97) / 97)),
    })),
    hours: busyHoursAgo.map((ago, index) => ({ hour: hourAgo(ago), total: Math.round((total * weights[index]!) / sum) })),
    lifetime: total,
    input,
    cacheRead,
    output,
  };
}

export const range = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, index) => from - index);

export const THREADS: ThreadUsage[] = [
  // Busy all day and still going in the latest hour.
  // Its context has grown past the 550K error setting, so its row is red.
  // It also ran the day before, so its lifetime total is larger than the period's.
  { ...thread("thr_a1", "Add a CSV export to the widgets report", "widgets", 42, 58_400_000, [...range(23, 18), ...range(6, 0)], null, 620_000), lifetime: 92_300_000 },
  // Past the 300K warning setting, so its row is amber.
  thread("thr_a2", "Fix the flaky gadgets checkout test", "gadgets", 27, 31_900_000, range(5, 2), null, 340_000),
  thread("thr_a3x", "Review the widgets API pagination change", "widgets", 12, 12_700_000, range(22, 19), 2),
  thread("thr_a4", null, "gadgets", 3, 2_100_000, [3]),
  thread("thr_a5", "Rename the gadget sizes enum", "gadgets", 1, 240_000, [20], 18),
  // Archived four days ago, so only the past week lists it, under Older.
  thread("thr_a6", "Bump the widgets lint config", "widgets", 6, 4_800_000, range(110, 104), 100),
];

export const MIN = 60_000;

// Shaped like a real day: most of the time in long turns, most of that in shell commands.
export const DAY_TIME: TurnTimeBreakdown = {
  turns: 160,
  split: { model: 192 * MIN, tools: 330 * MIN, waiting: 24 * MIN },
  kinds: [
    { kind: "commandExecution", ms: 280 * MIN, count: 1_820 },
    { kind: "toolCall", ms: 40 * MIN, count: 102 },
    { kind: "fileRead", ms: 6 * MIN, count: 211 },
    { kind: "delegation", ms: 4 * MIN, count: 2 },
    { kind: "fileChange", ms: 0.5 * MIN, count: 72 },
  ],
  questions: 9,
  lengths: [
    { turns: 83, split: { model: 22 * MIN, tools: 7 * MIN, waiting: 1 * MIN } },
    { turns: 44, split: { model: 57 * MIN, tools: 45 * MIN, waiting: 5 * MIN } },
    { turns: 27, split: { model: 70 * MIN, tools: 191 * MIN, waiting: 0 } },
    { turns: 6, split: { model: 43 * MIN, tools: 87 * MIN, waiting: 18 * MIN } },
  ],
  commands: [
    { command: "npm run e2e", runs: 12, totalMs: 60 * MIN, medianMs: 8 * MIN, longestMs: 9 * MIN },
    { command: "pnpm test", runs: 41, totalMs: 38 * MIN, medianMs: 50_000, longestMs: 3 * MIN },
    { command: "python3", runs: 231, totalMs: 26 * MIN, medianMs: 1_000, longestMs: 2 * MIN },
  ],
};

// A week with one question left unanswered overnight.
export const WEEK_TIME: TurnTimeBreakdown = {
  turns: 884,
  split: { model: 942 * MIN, tools: 1_134 * MIN, waiting: 750 * MIN },
  kinds: [
    { kind: "commandExecution", ms: 1_010 * MIN, count: 8_735 },
    { kind: "toolCall", ms: 102 * MIN, count: 436 },
    { kind: "fileRead", ms: 12 * MIN, count: 883 },
    { kind: "delegation", ms: 10 * MIN, count: 11 },
  ],
  questions: 36,
  lengths: [
    { turns: 470, split: { model: 120 * MIN, tools: 40 * MIN, waiting: 6 * MIN } },
    { turns: 250, split: { model: 290 * MIN, tools: 230 * MIN, waiting: 20 * MIN } },
    { turns: 130, split: { model: 340 * MIN, tools: 610 * MIN, waiting: 10 * MIN } },
    { turns: 34, split: { model: 192 * MIN, tools: 254 * MIN, waiting: 714 * MIN } },
  ],
  commands: [
    { command: "npm run e2e", runs: 23, totalMs: 132 * MIN, medianMs: 6 * MIN, longestMs: 9 * MIN },
    { command: "pnpm test", runs: 101, totalMs: 96 * MIN, medianMs: 11_000, longestMs: 3 * MIN },
    { command: "python3", runs: 1_033, totalMs: 90 * MIN, medianMs: 1_000, longestMs: 4 * MIN },
  ],
};

export function dataFor(range: RangeId, recordingSince?: number): UsageData {
  const span = windowFor(range, NOW);
  return {
    since: span.since,
    bars: fillBars(span.bars, fixtureHours(span.since)),
    unit: span.unit,
    threads: THREADS.filter((thread) => thread.hours.some(({ hour }) => hour >= span.since)),
    recordingSince: recordingSince ?? span.since - HOUR,
    contextThresholds: { warning: 300_000, error: 550_000 },
    turnTime: range === "day" ? DAY_TIME : WEEK_TIME,
  };
}

export const MINUTE = 60_000;

/** A subscription's limit as the server reports it, from the session that began 90 minutes before NOW. */
export function limit(over: Partial<Limit>): Limit {
  return {
    providerId: "claude-code",
    accountKey: "acct_acme",
    label: "Current session",
    kind: "five-hour",
    usedPercent: 10,
    resetsAt: NOW.getTime() + 210 * MINUTE,
    sampledAt: NOW.getTime() - 2 * MINUTE,
    pacePerHour: 6,
    projectedPercent: 31,
    runsOutAt: null,
    tone: "ok",
    lastHourTokens: 6_000_000,
    sizeTokens: 300_000_000,
    ...over,
  };
}

export function weekly(over: Partial<Limit>): Limit {
  return limit({ label: "Weekly limit", kind: "weekly", resetsAt: NOW.getTime() + 6 * 24 * HOUR, sizeTokens: 2_600_000_000, ...over });
}

export const CALM = [limit({}), weekly({ usedPercent: 1, pacePerHour: 0.2, projectedPercent: 34 })];
export const ON_PACE = [
  limit({ usedPercent: 28, pacePerHour: 19, projectedPercent: 94.5, tone: "warning", lastHourTokens: 12_000_000 }),
  weekly({ usedPercent: 3, pacePerHour: 0.43, projectedPercent: 75 }),
];
export const RUNS_OUT = [
  limit({ usedPercent: 52, pacePerHour: 30, projectedPercent: 157, runsOutAt: NOW.getTime() + 96 * MINUTE, tone: "error", lastHourTokens: 19_000_000 }),
  weekly({ usedPercent: 6, pacePerHour: 0.5, projectedPercent: 78 }),
];

export function Page({
  initial,
  recordingSince,
  initialHovered,
  limits = CALM,
}: {
  initial: RangeId;
  recordingSince?: number;
  initialHovered?: number;
  limits?: Limit[];
}) {
  const [range, setRange] = useState<RangeId>(initial);
  return (
    <UsageView
      range={range}
      onRange={setRange}
      data={dataFor(range, recordingSince)}
      error={null}
      onOpenThread={() => undefined}
      initialHovered={initialHovered}
      now={NOW.getTime()}
      limits={limits}
      providerName={(id) => (id === "codex" ? "Codex" : "Claude Code")}
    />
  );
}
/** Invented messages, one per turn, for the summary's hover and biggest turns. */
export const PROMPTS = [
  "Add a CSV export to the widgets report",
  "Run the whole test suite and fix whatever fails",
  "Why is the export slow on big reports?",
  "Rename exportRows to buildExportRows everywhere",
  "Read every file under src/ and summarize the architecture",
  "Looks good, commit it",
  "2 images",
  "Now do the same for the gadgets report",
];

/** Invented turns: a quick start, one heavy stretch after a lunch gap, a quick finish. */
export function fixtureTurns(count: number, start: number): TurnDetail[] {
  let at = start;
  return Array.from({ length: count }, (_, index) => {
    const wobble = 0.35 + ((index * 7919) % 97) / 97;
    const heavy = index === Math.floor(count * 0.6) ? 5 : index > count * 0.4 && index < count * 0.8 ? 2 : 1;
    const minutes = heavy >= 2 ? 14 : 4;
    const startedAt = at;
    at += (minutes + (index === Math.floor(count / 3) ? 55 : 3)) * 60_000;
    const cacheRead = Math.round(1_200_000 * wobble * heavy);
    // Heavy turns spend most of their time in tools; one stops to ask a question.
    const length = minutes * 60_000;
    const waiting = index === Math.floor(count * 0.7) ? 3 * 60_000 : 0;
    const tools = Math.round((length - waiting) * (heavy >= 2 ? 0.6 : 0.3) * wobble);
    return {
      turnId: `t${index + 1}`,
      startedAt,
      endedAt: startedAt + minutes * 60_000,
      usageAt: startedAt + minutes * 60_000,
      prompt: index === count - 2 ? null : PROMPTS[index % PROMPTS.length]!,
      time: { model: length - waiting - tools, tools, waiting },
      input: Math.round(cacheRead * 0.013),
      cacheRead,
      output: Math.round(cacheRead * 0.0037),
    };
  });
}

export function usageOf(turns: TurnDetail[], pruned = 0): ThreadTokens {
  const sum = turns.reduce(
    (acc, turn) => ({
      input: acc.input + turn.input,
      cacheRead: acc.cacheRead + turn.cacheRead,
      output: acc.output + turn.output,
    }),
    { input: 0, cacheRead: 0, output: 0 },
  );
  return {
    ...sum,
    total: sum.input + sum.cacheRead + sum.output + pruned,
    turns: turns.length,
    recent: turns.map((turn) => ({ at: turn.usageAt, input: turn.input, cacheRead: turn.cacheRead, output: turn.output })),
  };
}

export const LONG_TURNS = fixtureTurns(18, NOW.getTime() - 5 * HOUR);
export const LONG = usageOf(LONG_TURNS);
// Three subagents whose 9.4M sandy never reported; the totals include them.
export const WITH_SUBAGENTS: ThreadTokens = {
  ...LONG,
  input: LONG.input + 180_000,
  cacheRead: LONG.cacheRead + 9_180_000,
  output: LONG.output + 40_000,
  total: LONG.total + 9_400_000,
  subagents: { count: 3, tokens: 9_400_000 },
};
export const PRUNED_TURNS = fixtureTurns(6, NOW.getTime() - 2 * HOUR);
export const PRUNED = usageOf(PRUNED_TURNS, 12_480_000);
export const SHORT_TURNS = fixtureTurns(1, NOW.getTime() - 5 * 60_000);
export const SHORT = usageOf(SHORT_TURNS);
// sandy's composer takes focus as it mounts, and focus leaving an open popover
// closes it. Mounting the popover a moment later keeps it open.
export function AfterComposerFocus({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 100);
    return () => clearTimeout(timer);
  }, []);
  return ready ? children : null;
}

export const METER: ContextMeterProps = {
  usedTokens: 510_000,
  contextWindow: 1_000_000,
  thresholds: { warning: 300_000, error: 550_000 },
  level: "warning",
  lastTurn: 22_400_000,
  running: false,
  compacting: false,
  error: null,
  onCompact: () => undefined,
};
export const noop = () => {};
export const PERMISSION_OPTIONS: readonly PickerOption<PermissionMode>[] = [
  { value: "accept-edits", label: "Accept Edits" },
  { value: "auto", label: "Approve for me" },
  { value: "full", label: "Full Access", tone: "warning" },
];
export const BASE_EXECUTION = makeExecutionControlsProps();
export const EXECUTION = makeExecutionControlsProps({
  provider: { ...BASE_EXECUTION.provider, options: STORY_PROVIDER_OPTIONS, selectedId: "claude-code" },
  model: { ...BASE_EXECUTION.model, active: { model: "claude-sonnet-5" }, selected: "claude-sonnet-5", options: STORY_CLAUDE_CODE_MODELS },
});

// The messages match the summary's PROMPTS, so the popover names turns that are
// on screen behind it.
export const CONVERSATION: { from: "user" | "agent" | "work"; text: string }[] = [
  { from: "user", text: "Run the whole test suite and fix whatever fails" },
  { from: "work", text: "Read 31 files, edited 6, ran 18 commands" },
  {
    from: "agent",
    text: "Three tests failed. Two expected the old column order in the widgets report, and one timed out waiting on a fixture server that never started. All 412 pass now.",
  },
  { from: "user", text: "Why is the export slow on big reports?" },
  { from: "work", text: "Read 22 files, ran 41 commands" },
  {
    from: "agent",
    text: "It runs one query per row to look up each widget's owner. Joining owners into the main query takes a 10,000-row export from **4 minutes to 9 seconds**.",
  },
  { from: "user", text: "Rename exportRows to buildExportRows everywhere" },
  { from: "work", text: "Edited 9 files, ran 4 commands" },
  { from: "agent", text: "Renamed in 9 files, including two tests and the report docs. Type checks and tests pass." },
];

/** A thread in sandy's own header and composer, with the plugin's surfaces in place. */
export function ThreadFrame({
  headerAction,
  stack,
  height = "h-[900px]",
  conversation = CONVERSATION,
}: {
  headerAction: ReactNode;
  stack?: ReactNode;
  height?: string;
  conversation?: typeof CONVERSATION;
}) {
  const [draft, setDraft] = useState("");
  const [mentions, setMentions] = useState<PromptTextMention[]>([]);
  return (
    <SidebarProvider>
    <div className={`flex ${height} w-full flex-col overflow-hidden border border-border bg-background`}>
      <AppPageHeader
        ownsWindowTopLeft={false}
        center={<p className="sandy-thread-title relative min-w-0 text-sm font-normal">Add a CSV export to the widgets report</p>}
        actions={headerAction}
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-6 py-6">
          {conversation.map((turn, index) =>
            turn.from === "work" ? (
              <div key={index} className="text-sm text-muted-foreground">
                {turn.text}
              </div>
            ) : turn.from === "user" ? (
              <div key={index} className="ml-auto max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-sm text-foreground">
                {turn.text}
              </div>
            ) : (
              <div key={index} className="text-sm leading-relaxed text-foreground">
                <Markdown content={turn.text} />
              </div>
            ),
          )}
        </div>
      </div>
      <div className="chat-prompt-box mx-auto w-full max-w-[760px] px-6 pb-4">
        <FollowUpPromptBox
          attachments={{ items: [], projectId: "proj_demo", isAttaching: false, error: null, onAttachFiles: noop, onRemove: noop }}
          stack={stack}
          composer={{
            history: { currentDraft: { text: draft, mentions, attachments: [] }, entries: [], onSelectEntry: noop },
            isFollowUpSubmitting: false,
            message: draft,
            mentionRanges: mentions,
            onChangeMessage: (text: string, next: PromptTextMention[]) => {
              setDraft(text);
              setMentions(next);
            },
            onModifierSubmit: noop,
            onSubmit: () => setDraft(""),
            compactPromptPlaceholder: "Ask for a follow-up",
            promptPlaceholder: "Ask for a follow-up. @ to mention files, folders, sections, or threads",
            canModifierSubmit: false,
            steerActiveThreadOnEnter: false,
            submitMode: { kind: "ready" },
            threadRuntimeDisplayStatus: "idle",
          }}
          environmentSummary={null}
          contextWindowUsage={null}
          execution={EXECUTION}
          permission={{ value: "full", options: PERMISSION_OPTIONS, onChange: noop, supported: true }}
          promptActions={[]}
          typeahead={makeTypeaheadConfig()}
          collapseResetKey="thr_story"
        />
      </div>
    </div>
    </SidebarProvider>
  );
}
/** Tokens per 15 minutes since the session began 90 minutes before NOW: quiet stretches and spikes. */
export const SESSION_SLOTS = [2, 9, 4, 0, 12, 7].map((m) => m * 1_000_000);
