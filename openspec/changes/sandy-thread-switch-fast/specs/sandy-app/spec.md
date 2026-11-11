## ADDED Requirements

### Requirement: Contract
The Sandy app SHALL hold its contract: The web client renders the sidebar, the thread view and plugin slots from server data and switches threads without a page load.

#### Scenario: Proof passes
- **WHEN** the ci proof `apps/app/vitest.config.ts` runs
- **THEN** it passes
