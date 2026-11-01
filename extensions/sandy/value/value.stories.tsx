import type { ReactNode } from "react";
import { StoryCard, StoryRow } from "@sandy-ladle/story-card";
import { HugeiconsIcon } from "@hugeicons/react";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import PanelLeftIcon from "@hugeicons/core-free-icons/PanelLeftIcon";
import PanelRightIcon from "@hugeicons/core-free-icons/PanelRightIcon";

import { ContextMeter } from "./components/context-meter";
import {
  ThreadTokenCount,
  ThreadTokenSummary,
  type InitialHover,
  type ThreadTokens,
} from "./components/thread-token-count";
import { UsageView } from "./components/usage-view";
import type { Limit, TurnDetail } from "./usage/contract";
import { windowFor } from "./usage/series";
import {
  AfterComposerFocus,
  CALM,
  CONVERSATION,
  dataFor,
  HOUR,
  limit,
  LONG,
  LONG_TURNS,
  METER,
  noop,
  NOW,
  ON_PACE,
  Page,
  PRUNED,
  PRUNED_TURNS,
  RUNS_OUT,
  SESSION_SLOTS,
  SHORT,
  SHORT_TURNS,
  ThreadFrame,
  weekly,
  WITH_SUBAGENTS,
} from "./value.fixtures";

export default {
  title: "value/Page",
};

export const PastDay = () => <Page initial="day" />;

/** The past day with a busy hour hovered, so its tooltip shows. */
export const PastDayHovered = () => <Page initial="day" initialHovered={20} />;

/** A session on pace for 95% by its reset: the meter turns amber, and the chart runs on to the reset with hatched bars at the past hour's pace. */
export const LimitOnPace = () => <Page initial="day" limits={ON_PACE} />;

// The plugin's README embeds this one.
/** A session that runs out before it resets: red, with the hatched bars red past the point it runs out. */
export const LimitRunsOut = () => <Page initial="day" limits={RUNS_OUT} />;

/** Right after Value starts reading the limits, before there's a pace to project. */
export const LimitMeasuring = () => (
  <Page
    initial="day"
    limits={[
      limit({ usedPercent: 48, pacePerHour: null, projectedPercent: null, sizeTokens: null }),
      weekly({ usedPercent: 5, pacePerHour: null, projectedPercent: null, sizeTokens: null }),
    ]}
  />
);

/** Two subscriptions: each one's meters sit under its provider's name. */
export const LimitTwoSubscriptions = () => (
  <Page
    initial="day"
    limits={[
      ...ON_PACE,
      limit({ providerId: "codex", accountKey: "acct_gadgets", usedPercent: 4, pacePerHour: 1, projectedPercent: 8 }),
      weekly({ providerId: "codex", accountKey: "acct_gadgets", usedPercent: 12, pacePerHour: 0.1, projectedPercent: 26 }),
    ]}
  />
);

export const PastThreeDays = () => <Page initial="three-days" />;

export const PastWeek = () => <Page initial="week" recordingSince={NOW.getTime() - 4 * 24 * HOUR} />;

/** Over the past week, every thread in one list: active threads first, then the archived ones under their own heading, dimmed. */
export const ArchivedThreads = () => (
  <UsageView
    range="week"
    onRange={() => undefined}
    data={dataFor("week", NOW.getTime() - 7 * 24 * HOUR)}
    error={null}
    onOpenThread={() => undefined}
    now={NOW.getTime()}
  />
);

export const Empty = () => (
  <UsageView
    range="day"
    onRange={() => undefined}
    data={{
      ...dataFor("day"),
      bars: windowFor("day", NOW).bars,
      threads: [],
      turnTime: { turns: 0, split: { model: 0, tools: 0, waiting: 0 }, kinds: [], questions: 0, lengths: [], commands: [] },
    }}
    error={null}
    onOpenThread={() => undefined}
    now={NOW.getTime()}
  />
);

export const HeaderCount = () => (
  <StoryCard>
    <StoryRow label="a long thread" hint="token use over time; click to open the summary">
      <ThreadTokenCount usage={LONG} turns={LONG_TURNS} onOpenPage={() => undefined} now={NOW.getTime()} />
    </StoryRow>
    <StoryRow label="a short thread" hint="one turn, a thin bar at the right">
      <ThreadTokenCount usage={SHORT} turns={SHORT_TURNS} onOpenPage={() => undefined} now={NOW.getTime()} />
    </StoryRow>
    <StoryRow label="compact viewport" hint="the sparkline drops out">
      <ThreadTokenCount usage={LONG} turns={LONG_TURNS} isCompactViewport onOpenPage={() => undefined} now={NOW.getTime()} />
    </StoryRow>
  </StoryCard>
);

function Summary({
  usage,
  turns,
  initialHovered,
}: {
  usage: ThreadTokens;
  turns: TurnDetail[] | null;
  initialHovered?: InitialHover;
}) {
  return (
    <div className="w-[400px] rounded-md border border-border bg-popover p-4">
      <ThreadTokenSummary usage={usage} turns={turns} onOpenPage={() => undefined} initialHovered={initialHovered} />
    </div>
  );
}

/** The popover's contents, drawn open. */
export const HeaderSummary = () => (
  <StoryCard>
    <StoryRow label="a long thread" hint="hover a bar for the messages behind it">
      <Summary usage={LONG} turns={LONG_TURNS} />
    </StoryRow>
    <StoryRow label="the busiest stretch hovered" hint="the readout names the messages behind it">
      <Summary usage={LONG} turns={LONG_TURNS} initialHovered="largest" />
    </StoryRow>
    <StoryRow label="loading the turns" hint="the chart draws the recorded usage until the messages arrive">
      <Summary usage={LONG} turns={null} />
    </StoryRow>
    <StoryRow label="subagents counted" hint="sandy leaves their tokens out; the summary adds them and says so">
      <Summary usage={WITH_SUBAGENTS} turns={LONG_TURNS} />
    </StoryRow>
    <StoryRow label="earlier turns pruned" hint="the provider's running total covers what sandy deleted">
      <Summary usage={PRUNED} turns={PRUNED_TURNS} />
    </StoryRow>
  </StoryCard>
);

// The plugin's README embeds this one.
/**
 * The button where sandy draws it, in a thread header's action row, with its
 * summary open on the busiest stretch.
 */
export const HeaderOpen = () => (
  <ThreadFrame
    headerAction={
      <AfterComposerFocus>
        <ThreadTokenCount usage={LONG} turns={LONG_TURNS} onOpenPage={noop} defaultOpen initialHovered="largest" now={NOW.getTime()} />
      </AfterComposerFocus>
    }
  />
);

/**
 * The meter above a thread's composer once its context passes the warning
 * setting, 300K tokens here, and red past the error setting, 550K, with a
 * button that compacts the thread.
 */
export const ContextMeterStates = () => (
  <StoryCard>
    <StoryRow label="past the warning" hint="amber past 300K; the ticks mark both settings">
      <div className="w-[720px]">
        <ContextMeter {...METER} />
      </div>
    </StoryRow>
    <StoryRow label="past the error" hint="red past 550K">
      <div className="w-[720px]">
        <ContextMeter {...METER} usedTokens={620_000} level="error" />
      </div>
    </StoryRow>
    <StoryRow label="a turn running" hint="sandy compacts only an idle thread">
      <div className="w-[720px]">
        <ContextMeter {...METER} running />
      </div>
    </StoryRow>
    <StoryRow label="compacting" hint="until the smaller context arrives">
      <div className="w-[720px]">
        <ContextMeter {...METER} running compacting />
      </div>
    </StoryRow>
    <StoryRow label="no usable window" hint="the provider reported a window smaller than the context">
      <div className="w-[720px]">
        <ContextMeter {...METER} usedTokens={347_000} contextWindow={200_000} lastTurn={1_430_000} />
      </div>
    </StoryRow>
    <StoryRow label="compaction refused" hint="sandy's reason, under the meter">
      <div className="w-[720px]">
        <ContextMeter {...METER} error="Context can only be compacted while the thread is idle or errored" />
      </div>
    </StoryRow>
    <StoryRow label="narrow composer" hint="the bar and the last turn drop out">
      <div className="w-[320px]">
        <ContextMeter {...METER} compact />
      </div>
    </StoryRow>
  </StoryCard>
);

/**
 * A thread whose context has grown past the error setting: the header's
 * sparkline and total, and the meter above the composer with Compact.
 */
export const ThreadWithMeter = () => (
  <ThreadFrame
    headerAction={<ThreadTokenCount usage={LONG} turns={LONG_TURNS} onOpenPage={noop} now={NOW.getTime()} />}
    stack={<ContextMeter {...METER} usedTokens={620_000} level="error" />}
  />
);

// The README's image for the context meter, and the store's.
/**
 * A thread whose context has passed the warning setting: its last exchange,
 * then the amber meter above the composer, with Compact.
 */
export const ContextMeterInThread = () => (
  <div data-screenshot-frame className="w-[1400px]" style={{ height: 480 }}>
    <ThreadFrame
      height="h-full"
      headerAction={<ThreadTokenCount usage={LONG} turns={LONG_TURNS} onOpenPage={noop} now={NOW.getTime()} />}
      stack={<ContextMeter {...METER} />}
      conversation={CONVERSATION.slice(-3)}
    />
  </div>
);
