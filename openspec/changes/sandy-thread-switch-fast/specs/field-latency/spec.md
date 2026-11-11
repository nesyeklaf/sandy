## ADDED Requirements

### Requirement: Contract
The Field latency SHALL hold its contract: Records menu, dialog and thread-switch latency in the owner's browsers per device, including when the thread view stopped changing after a switch, and reports percentiles per device and release.

#### Scenario: Proof passes
- **WHEN** the ci proof `extensions/sandy/field-latency/contentdone.test.ts` runs
- **THEN** it passes

### Requirement: Seam to sandy-thread-view
The Field latency SHALL keep this contract with the Thread view: Times a switch until the thread view is painted and until its content stopped changing

The seam is read-only.

#### Scenario: Proof missing
- **WHEN** the contract is checked
- **THEN** no proof is declared, so it is unproven

### Requirement: Last content writer is named
For each thread switch with a content-done mark, the collector SHALL record which plugin made the last content change after the ready paint, named by the data-sandy-plugin of its nearest plugin root, or host when no plugin root encloses it, and how many content changes followed the ready paint, and the report SHALL show per device each last writer's share of switches and content p50, so the field gap between painted and really done is attributed.

#### Scenario: Plugin writes last
- **WHEN** a switch is ready and 300 ms later a content change happens inside a plugin root of the plugin genui, after a host change at 100 ms
- **THEN** the sample's contentSource is genui and its contentWrites is 2
- **TEST** `ci extensions/sandy/field-latency/collector.test.ts::the plugin that writes last after ready is the sample's content source`

#### Scenario: Host ticker capped
- **WHEN** after the ready paint a host element in the content changes every 900 ms until the 5 s cap
- **THEN** the sample has contentDone capped, contentSource host and contentWrites of at least 4
- **TEST** `ci extensions/sandy/field-latency/collector.test.ts::a host ticker after ready is named as the content source of a capped switch`

#### Scenario: Nothing after ready
- **WHEN** a switch is ready and no content change follows before it settles
- **THEN** the sample has contentSource null and contentWrites 0
- **TEST** `ci extensions/sandy/field-latency/collector.test.ts::a switch with no content change after ready has no content source`

#### Scenario: Report per writer
- **WHEN** the report runs over switch samples of two devices whose last writers are genui, host and none
- **THEN** each device lists every last writer with its share of that device's switches and its content p50, none for samples without a writer
- **TEST** `ci extensions/sandy/field-latency/server.test.ts::the switch report shows per device the share and content p50 of each last writer`

#### Scenario: Old samples unknown
- **WHEN** the report runs over switch samples stored before contentSource existed
- **THEN** they report under the writer unknown and their ready and content numbers are unchanged
- **TEST** `ci extensions/sandy/field-latency/server.test.ts::samples stored without a content source report under the unknown writer`
