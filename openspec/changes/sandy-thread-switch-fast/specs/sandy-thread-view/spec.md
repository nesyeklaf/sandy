## ADDED Requirements

### Requirement: Contract
The Thread view SHALL hold its contract: Shows a thread's timeline, composer and status for the thread in the route, and after a switch shows its content without later changes.

#### Scenario: Proof passes
- **WHEN** the ci proof `apps/app/src/components/thread/timeline/ThreadTimelineRows.presentation.test.tsx` runs
- **THEN** it passes
