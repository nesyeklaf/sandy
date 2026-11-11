# Holon text fallback

## Purpose
Clients that cannot run the card (phone, notification, CLI) still need the holon in words.

This capability is generated from the component holon `holon-genui-markdown` (Holon text fallback).

## Requirements

### Requirement: Contract
The Holon text fallback SHALL hold its contract: Writes a read holon view as markdown with the same glyphs, lights and drift as the card.

#### Scenario: Proof passes
- **WHEN** the ci proof `extensions/sandy/genui/core/holon.test.ts` runs
- **THEN** it passes

### Requirement: Seam to holon-genui-view-reader
The Holon text fallback SHALL keep this contract with the Holon view reader: Writes only what the reader returned

The seam is read-only.

#### Scenario: Proof missing
- **WHEN** the contract is checked
- **THEN** no proof is declared, so it is unproven
