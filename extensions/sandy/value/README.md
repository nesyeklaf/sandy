# Value

See what your threads cost in tokens and time, and whether your subscription's session and weekly limits will last until they reset.

![The sandy window with Value' title bar button open: the current session 52% of about 300M tokens and on pace to run out at 3:56 PM, 1h 54m before it resets, and the past day's tokens per hour running on to the reset with hatched bars. Below it, a thread with a sparkline and 28M tokens in its header, and a red meter above its composer reading 620K context with a Compact button](screenshots/page--window-with-limits.png)

## Key features

### Tokens in each thread's header

![A thread header with its summary open: 28M tokens over 18 turns, tokens per 15 minutes with the busiest stretch and the message behind it, minutes per turn split into the model's time, tools, and waiting on you, and the three biggest turns](screenshots/page--header-open.png)

Each thread's header shows a sparkline of its tokens over time, its tokens in
the past day in bold, and its lifetime total under them. Click it to see which
of your messages used the most tokens and time, and the thread's three
biggest turns.

### A context meter above the composer

![A thread's last exchange, then an amber meter above its composer: 510K context against a 1M window, with ticks at 300K and 550K, 22.4M tokens in the last turn, and a Compact button](screenshots/page--context-meter-in-thread.png)

Every model call reads the whole context again, so a large context makes
every turn expensive. Once a thread's context passes 300K tokens, a meter
shows above the composer, amber and then red past 550K. Click **Compact** to
have sandy compact the thread. The sidebar counts these threads in amber and red.

### Your session in the title bar

![sandy's title bar across the full window: the window controls, back and forward, and the sidebar toggle, then Value' spark chart and rings in amber at the right edge of the sidebar, with its limits open below: the current session 28% of about 300M tokens and on pace for 95% by 5:50 PM, the weekly limit, and the past day's tokens per hour running on to the reset with hatched bars](screenshots/page--title-bar-in-window.png)

sandy's title bar shows your session as a spark chart of its tokens per 15
minutes from its start to its reset, with a dot for each 15 minutes still to
come, and two rings for the percent used, the session outside and the week
inside. It sits at the right edge of the sidebar column while the sidebar
is open. When the sidebar is too narrow for the chart, only the rings show.
While the sidebar is closed, it is hidden. It turns amber or red once either is
headed for its limit. Hover it for the limits and the past day's tokens per hour, or click it
to open the page.

### The Value page

![The Value page for the past day: 110M tokens, a red session meter on pace to run out before it resets, an hourly chart running on to the reset with hatched bars, Where turn time goes, and five threads ranked by tokens](screenshots/page--limit-runs-out.png)

Open **Value** in the sidebar. Meters for each usage limit show the
percent used of about how many tokens the limit holds, and where it lands at
the current pace, such as "On pace to run out at 3:56 PM, 1h 54m before it
resets". Switch between **Past day**, **Past 3 days**, and **Past week** to
chart tokens split into new input, cache reads, and output. **Where turn time
goes** splits turns into the model's time, tools, and waiting on you, and
names the slowest shell commands. The thread list ranks threads by tokens,
with each one's context size and a dot per turn for its length.

## For agents

`sandy value` prints the same numbers, so an agent can find expensive
threads without reading their transcripts.

```sh
sandy value threads [--days N] [--sort tokens|time|context] [--limit N] [--active] [--json]   # tokens, turns, context, and turn times per thread
sandy value commands [--days N] [--limit N] [--json]                                         # the shell commands that took the most time
```

The [self-improve](https://github.com/danielbachhuber/skills/tree/main/skills/self-improve)
Claude Code skill uses `sandy value threads` to pick which of the past
week's threads to review.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `contextWarningAt` | `300K` | Shows the context meter in amber once a thread's context passes this many tokens. Empty turns it off. |
| `contextErrorAt` | `550K` | Turns the meter and the page's row red past this many tokens. Empty leaves only the warning. |

## Requirements

sandy 0.43 or later, and a provider that reports token usage to sandy. Usage limits
need a provider that reports them, such as Claude Code or Codex. No account or
outside service.

- Value counts tokens, not dollars.
- sandy deletes a thread's older usage events, so Value keeps its own copy,
  starting when you install it.
- Claude Code subagents report no usage to sandy, so Value reads their
  transcripts from disk. It counts them only for threads that ran on the
  machine sandy runs on. It reads them when the parent thread records usage,
  and every 15 seconds while they are still writing, which is a directory
  listing with no request to sandy.
- It reads the usage limits from sandy every five minutes, one request that sandy
  passes to each provider. Opening a thread's summary reads that thread's
  turn events from sandy. The page, title bar, and meter read the plugin's own
  database.

## Related plugins

_As of October 21, 2026_

- **Burn** (`burn`): shows what each thread costs in dollars, per prompt and
  across threads, with budgets. Value counts tokens rather than dollars,
  and adds turn time, context size, and usage limits.
- **Usage Meter** (`usage-meter`): shows Claude subscription limits as two
  rings in the sidebar footer and reads Claude Code transcripts to explain
  where they went. Value reads sandy's usage events, so it covers any
  provider that reports usage to sandy, and breaks usage down by thread and by
  hour.
- **Receipts** (`receipts`): breaks token use and estimated cost down by
  model, project, and day. Value breaks it down by thread and by hour,
  with no cost estimates.
- **Provider usage** (`provider-usage`), bundled with sandy, **Usage Bar**
  (`usage-bar`), and **Usage Limits** (`usage-limits`): show each provider's
  quota windows and when they reset. **Usage Pace** (`usage-pace`) adds
  whether your current rate lasts until each reset. Value reads the same
  limits, estimates how many tokens each holds, and draws where each is
  headed on its token chart.
- **Auto Compact** (`auto-compact`): compacts a thread on its own once its
  context reaches a share of the window. Value warns at a token count you
  set and leaves compacting to you.
- **Context Meter** (`context-meter`) and **Context Katamari**
  (`context-katamari`): show how full one thread's context is. **[Context
  Health](https://getbb.app/marketplace/context-health)** (`context-health`) shows what makes it up. Value shows each
  thread's context size beside its token use over time, across all threads.

## Develop

```sh
npm install
npx tsc --noEmit
npm test
node ../scripts/link-workspace-deps.mjs && sandy plugin build . && sandy plugin reload value
```
