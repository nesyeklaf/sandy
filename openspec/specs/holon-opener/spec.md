# Holon file opener

## Purpose
Opening a .holon file in Sandy should show its lights and neighbourhood, not raw JSON.

This capability is generated from the container holon `holon-opener` (Holon file opener).

## Requirements

### Requirement: Contract
The Holon file opener SHALL hold its contract: Opens .holon files as the computed view with parent, parts and seams to click through, and falls back to the raw file when the holon cannot be computed.

#### Scenario: Proof passes
- **WHEN** the ci proof `extensions/sandy/holon/app.test.tsx` runs
- **THEN** it passes

### Requirement: Seam to holon-cli
The Holon file opener SHALL keep this contract with the sandy holon CLI: Reads views through the view RPC

The seam is read-only.

#### Scenario: Proof missing
- **WHEN** the contract is checked
- **THEN** no proof is declared, so it is unproven
