# Holon extension

## Purpose
Holons are files in Git that Sandy shows and checks through the Rust holon binary.

This capability is generated from the system holon `holon-extension` (Holon extension).

## Requirements

### Requirement: Contract
The Holon extension SHALL hold its contract: Shows the lights, drift and holon-view/v0 views of holon/v0 files and records evidence and confirmations by asking a holon serve process, and computes nothing itself.

#### Scenario: Proof missing
- **WHEN** the contract is checked
- **THEN** no proof is declared, so it is unproven
