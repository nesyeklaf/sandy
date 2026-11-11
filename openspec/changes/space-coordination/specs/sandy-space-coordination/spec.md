# sandy-space-coordination

## ADDED Requirements

### Requirement: Orchestrators of a Space
The plugin SHALL let the owner make any number of member sessions of a Space orchestrators of that Space, and SHALL clear a session's role when it leaves the Space or is deleted.

#### Scenario: Two orchestrators
- **WHEN** the owner makes sessions A and B of Space S orchestrators
- **THEN** space_context of S lists both A and B as orchestrators

#### Scenario: Orchestrator leaves the Space
- **WHEN** an orchestrator session of Space S is moved to another Space or to Unassigned
- **THEN** it is not an orchestrator of S on the next read and has no orchestrator tools

#### Scenario: Unassigned session
- **WHEN** the owner tries to make a session without a Space an orchestrator
- **THEN** the request fails with an error that names the missing Space

### Requirement: Coordination mode per member
Every member session SHALL have a coordination mode, independent by default and managed when the owner says so or when an orchestrator started it, and only the owner SHALL change it.

#### Scenario: Default mode
- **WHEN** a session is created in or moved into a Space
- **THEN** its coordination mode is independent and the orchestrators' management tools refuse it

#### Scenario: Owner marks a session managed
- **WHEN** the owner switches a member's Managed toggle on
- **THEN** every orchestrator of the Space may message, stop and archive it

### Requirement: Orchestrator messages reach managed members only
The plugin SHALL refuse, before it reaches the provider, any message that carries a sender and whose sender is an orchestrator and whose target is an independent session or a session outside that orchestrator's Space. Messages without a sender SHALL never be refused by this rule.

#### Scenario: Message to an independent member through the CLI
- **WHEN** an orchestrator of S runs `sandy thread tell` to an independent member of S
- **THEN** the dispatch is refused with a reason that names the independent mode

#### Scenario: Owner message
- **WHEN** the owner types a message into an independent member
- **THEN** the message is dispatched normally

### Requirement: Sessions an orchestrator started are restricted like it
The plugin SHALL record the Space of a session started with space_start_session and SHALL refuse a message from that session to an independent session or a session outside that Space exactly as it refuses one from an orchestrator. The record SHALL survive the starter being archived or losing its role, SHALL be cleared when the session is deleted, and SHALL end when the session is observed in another Space.

#### Scenario: Started session messages an independent member
- **WHEN** a session started by an orchestrator of S messages an independent member of S
- **THEN** the dispatch is refused with a reason that names the independent mode

#### Scenario: Started session reports to its orchestrator
- **WHEN** a session started by an orchestrator of S messages an orchestrator of S
- **THEN** the dispatch proceeds

#### Scenario: Descendant of a started session
- **WHEN** a session created with a restricted session or an orchestrator as parent messages an independent member
- **THEN** the dispatch is refused, also when the descendant is outside any Space

#### Scenario: Started session messages a managed member
- **WHEN** a session started by an orchestrator of S messages a managed member of S
- **THEN** the dispatch proceeds

### Requirement: The protection is cooperative
The plugin SHALL document that its protection binds agents using the Space tools and the normal sandy CLI, and that clearing SANDY_THREAD_ID, spoofing a sender, or running sandy thread stop or archive is not prevented.

#### Scenario: Documentation
- **WHEN** a reader opens the design risks, the plugin README or the Spaces skill
- **THEN** each states the cooperative boundary and what a hard boundary would need

### Requirement: Orchestrator starts flat member sessions
An orchestrator SHALL be able to start a session in its Space through an agent tool, and the new session SHALL have the Space as its section, no parent thread and no lifecycle owner.

#### Scenario: Start a session for an idea
- **WHEN** the orchestrator calls space_start_session with a project, an environment, a title, a prompt and an idea id
- **THEN** a managed member exists in the Space with no parent thread and no lifecycle owner, linked to the idea, and the idea status is in-progress

#### Scenario: Archiving the orchestrator
- **WHEN** the owner archives the orchestrator session
- **THEN** the sessions it started stay unarchived

### Requirement: Space context
Any member of a Space SHALL be able to read the Space context: members with status, project, environment host, path, worktree flag, branch, pull request state and coordination mode, the orchestrator, the ideas and the scratchpad revision.

#### Scenario: Context names real branches
- **WHEN** a member runs in a worktree environment on branch B
- **THEN** space_context reports that member's environment with isWorktree true and branchName B

### Requirement: Ideas are Space entries
The plugin SHALL store ideas as entries of a Space with title, body, status (open, planned, in-progress, done, dropped), author and linked sessions, editable by the owner and by members, and deletable by the owner and the orchestrator, within the limits in design.md.

#### Scenario: Member records an idea
- **WHEN** a member session calls space_idea_create with a title and body
- **THEN** the idea appears as open in the Space panel and in space_context, authored by that session

#### Scenario: Limit
- **WHEN** a Space already holds the maximum number of ideas
- **THEN** creating another idea fails with an error that names the limit

### Requirement: Shared scratchpad
Each Space SHALL have one Markdown scratchpad that the owner, the orchestrator and members can read and write, and a write SHALL succeed only when its base revision equals the current revision.

#### Scenario: Concurrent write
- **WHEN** two writers read revision 4 and both write with base revision 4
- **THEN** the first write produces revision 5 and the second fails with a conflict that returns revision 5 and its text

### Requirement: Space side-panel tab
The thread side panel SHALL offer a fixed "Space" tab for threads that belong to a Space, showing the orchestrators, the members with their Managed switch, the ideas and the scratchpad.

#### Scenario: Thread without a Space
- **WHEN** the open thread has no section
- **THEN** the Space tab is not shown

#### Scenario: Scratchpad conflict in the panel
- **WHEN** the owner saves the scratchpad after another writer changed it
- **THEN** the panel shows the current text and keeps the owner's draft

### Requirement: Wake digest for the orchestrator
When wake-ups are enabled for a Space, the plugin SHALL send each orchestrator of the Space at most one digest message per interval listing managed members whose turn ended failed, with a pending question or finished, capped in entries.

#### Scenario: Burst of outcomes
- **WHEN** 70 managed members finish within one interval
- **THEN** each orchestrator receives one digest with the newest 50 entries and a count of 20 omitted

### Requirement: Shelves without the Ideas shelf
Space and Flow shelves SHALL be Needs you, Failed, Working, In review, Merged, Orchestrators, Idle, Dormant, Snoozed and Archived, with the Orchestrators shelf kept at its current priority and no Ideas shelf.

#### Scenario: Idle orchestrator
- **WHEN** an orchestrator has no question, failure, work or PR
- **THEN** it is on the Orchestrators shelf

#### Scenario: Former Ready shelf
- **WHEN** a session matches no other shelf
- **THEN** it is on the shelf labeled Idle

### Requirement: Sort mode inside shelves
The owner SHALL be able to choose how sessions are sorted inside every Space shelf, from the Flow modes (manual, recent activity, date created, repository), persisted separately from Flow.

#### Scenario: Recent activity
- **WHEN** the sort mode is recent activity
- **THEN** sessions inside each shelf are ordered by their latest activity, newest first

### Requirement: Old session roles are discarded
The plugin SHALL discard the global orchestrator and idea marks once, drop their tables, and retire the session_roles tool and the idea session instructions.

#### Scenario: Previously marked sessions
- **WHEN** the plugin starts after the migration with sessions that carried orchestrator or idea marks
- **THEN** no Space has orchestrators or ideas from those marks and the sessions show no role badge

### Requirement: Space data survives Space deletion
Deleting a Space SHALL keep its ideas and scratchpad, list them as orphans, and let the owner move them into a live Space.

#### Scenario: Adopt orphaned data
- **WHEN** the owner runs `sandy spaces adopt <deleted-space-id> <space>`
- **THEN** the ideas belong to the target Space and the old scratchpad text is appended to the target scratchpad under a heading

### Requirement: English-only plugin text
All user-visible and agent-visible text of the plugin SHALL be English, guarded by a test.

#### Scenario: German word introduced
- **WHEN** a source file outside tests contains "Orchestratoren"
- **THEN** the English-only test fails naming the file and line

### Requirement: CLI and RPC parity
Every coordination action available in the UI SHALL be available through plugin RPC and the `sandy spaces` CLI with JSON output.

#### Scenario: Set a member independent from the CLI
- **WHEN** the owner runs `sandy spaces member mode <thread> managed --json`
- **THEN** the command reports the new mode and the Space tab shows the Managed switch on
