# holon serve client

## Purpose
Holon lights must come from one implementation, the Rust holon binary, not from a second copy in TypeScript.

This capability is generated from the container holon `holon-engine` (holon serve client).

## Requirements

### Requirement: Contract
The holon serve client SHALL hold its contract: Starts one holon serve process per model root on demand with a random bearer token, restarts it once when it dies, stops it after 15 idle minutes and when the plugin unloads, and fails with a coded error and an install hint when the binary is missing.

#### Scenario: Proof passes
- **WHEN** the ci proof `extensions/sandy/holon/engine.test.ts` runs
- **THEN** it passes
