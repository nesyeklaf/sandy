# Holon map

## Purpose
A holon is only understood in its neighbourhood, so the opener opens on a zoomable map of nested holons and their seams instead of a single card.

This capability is generated from the container holon `holon-map` (Holon map).

## Requirements

### Requirement: Contract
The Holon map SHALL hold its contract: Draws the holons as nested boxes with their four sides, the seams as labelled arrows bundled to the nearest visible box, and lets the reader open, close, pan, zoom and recolour by side before the card of the selected holon below.

#### Scenario: Proof passes
- **WHEN** the ci proof `extensions/sandy/holon/ui/holon-map.test.tsx` runs
- **THEN** it passes

### Requirement: Seam to holon-cli
The Holon map SHALL keep this contract with the sandy holon CLI: Reads the whole model through the map RPC

The seam is read-only.

#### Scenario: Proof missing
- **WHEN** the contract is checked
- **THEN** no proof is declared, so it is unproven
