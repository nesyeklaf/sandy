# Holons in genui

## Purpose
People see a holon in chat as a card with its neighbourhood.

This capability is generated from the system holon `holon-genui` (Holons in genui).

## Requirements

### Requirement: Contract
The Holons in genui SHALL hold its contract: Renders any holon-view/v0 view and computes nothing.

#### Scenario: Proof passes
- **WHEN** the ci proof `extensions/sandy/genui/gallery.test.ts` runs
- **THEN** it passes

### Requirement: Seam to holon-extension
The Holons in genui SHALL keep this contract with the Holon extension: Reads holon-view/v0 views the extension computed

The seam is read-only.

#### Scenario: Proof missing
- **WHEN** the contract is checked
- **THEN** no proof is declared, so it is unproven
