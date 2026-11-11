## Why

Owner target: a thread switch, first visit and revisit, is really done (field-latency contentDone) in a median of 100 ms. Field p50 revisit today: painted 204-536 ms, really done 715-1651 ms per device. Sandy has no holons for the parts this touches yet; this change set adds them and the requirement the first change must meet.

Change set `sandy-thread-switch-fast`, proposed by agent:orchestrator on 2026-11-11.

## What Changes

- Create context `sandy` (Sandy), proposed
- Create container `sandy-app` (Sandy app), proposed under `sandy`
- Create component `sandy-thread-view` (Thread view), proposed under `sandy-app`
- Create component `field-latency` (Field latency), proposed under `sandy`
- Put requirement `content-last-writer` (Last content writer is named) of `field-latency`
- Ask question `ship-attribution-first` of `field-latency`: The lab explains only 7-54 ms of the 0.5-1.1 s field gap between painted and really done. Ship this attribution and collect a day of field data per device before the first speed change to the thread view?
- Ask question `ship-attribution-first` of `field-latency`: The lab explains only 7-54 ms of the 0.5-1.1 s field gap between painted and really done. Ship this attribution and collect a day of field data per device before the first speed change to the thread view?

## Capabilities

### New Capabilities

- `field-latency`: Field latency
- `sandy`: Sandy
- `sandy-app`: Sandy app
- `sandy-thread-view`: Thread view

### Modified Capabilities

- None

## Impact

- `apps/` (sandy)
- `apps/app/` (sandy-app)
- `apps/app/src/components/thread/` (sandy-thread-view)
- `extensions/sandy/` (sandy)
- `extensions/sandy/field-latency/` (field-latency)

## Open questions

- None
