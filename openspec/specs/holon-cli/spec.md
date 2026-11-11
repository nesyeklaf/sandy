# sandy holon CLI

## Purpose
People and agents check, read and prove holons from a shell and from scripts.

This capability is generated from the container holon `holon-cli` (sandy holon CLI).

## Requirements

### Requirement: Contract
The sandy holon CLI SHALL hold its contract: sandy holon check, drift, view, evidence record and confirm print the contract's JSON with --json and short glyph text otherwise, and fail with a coded error.

#### Scenario: Proof passes
- **WHEN** the ci proof `extensions/sandy/holon/cli.e2e.test.ts` runs
- **THEN** it passes

### Requirement: Seam to holon-engine
The sandy holon CLI SHALL keep this contract with the holon serve client: Reads check, drift and views and records evidence and confirmations through the holon serve routes under /v0

#### Scenario: Proof missing
- **WHEN** the contract is checked
- **THEN** no proof is declared, so it is unproven
