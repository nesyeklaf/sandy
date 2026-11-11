# Holon view reader

## Purpose
A wrong or half-filled view must show one clear error line, never crash the card.

This capability is generated from the component holon `holon-genui-view-reader` (Holon view reader).

## Requirements

### Requirement: Contract
The Holon view reader SHALL hold its contract: Turns a holon-view/v0 value into a typed view, or says which field is wrong; changes no value and computes nothing.

#### Scenario: Proof passes
- **WHEN** the ci proof `extensions/sandy/genui/core/holon.test.ts` runs
- **THEN** it passes
