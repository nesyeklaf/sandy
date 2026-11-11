# Holon card

## Purpose
People read a holon's Why, Contract, four sides and drift at a glance in chat.

This capability is generated from the component holon `holon-genui-card` (Holon card).

## Requirements

### Requirement: Contract
The Holon card SHALL hold its contract: Draws a read holon view as a card with one glyph and tone per light, and shows every field as given.

#### Scenario: Proof passes
- **WHEN** the ci proof `extensions/sandy/genui/ui/components/Holon.test.tsx` runs
- **THEN** it passes

### Requirement: Seam to holon-genui-view-reader
The Holon card SHALL keep this contract with the Holon view reader: Draws only what the reader returned

The seam is read-only.

#### Scenario: Proof missing
- **WHEN** the contract is checked
- **THEN** no proof is declared, so it is unproven
