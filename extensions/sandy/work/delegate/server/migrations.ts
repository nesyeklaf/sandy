// Append-only migrations of the delegate plugin DB (sandy.storage.migrate: statement index = migration id,
// the host rejects edited or reordered statements). Never change a shipped statement; append a new one.
//
// delegations: the ledger, the only authority on which thread is a delegated child of which parent.
//   A row is created "reserved" before the spawn; child_thread_id is null until the spawn result binds it.
//   Slots of a root are its rows in reserved|starting|active, and its rows with an open delegation_stops row.
// agent_snapshots: immutable, content-addressed copies of catalog entries a delegation launched with.
// pending_inputs: inputs for idle children that wait for a slot of their root, delivered in seq order.
// questions: child questions; at most one open question per delegation.
// delegation_briefs (#2): the task of a delegation, stored before the spawn and handed out by
//   sandy_delegate_brief only after a valid ack; kept after delivery (a resumed session needs it).
// delegation_acks (#2): one row per nonce the server issued with a policy; acked_at/pi_session_id are
//   set by the ack that echoes it, once; brief_delivered_at by the one brief that ack unlocks.
// delegation_stops (#3): child threads the plugin must stop (no ack within the watchdog window, a spawn
//   whose reservation was released or bound to another thread); the watchdog sweep calls SANDY's stop and
//   retries it until SANDY confirms it (stopped_at), also after a plugin restart. attempts and last_error
//   report the failures. #4 adds next_attempt_at (the retry backoff) and the per-delegation index.
// delegation_markers (#5): when agents.configure first gave a thread the delegate marker.
// delegation_acks.turn (#6): the pi session's turn counter the ack was sent for (the extension acks every
//   turn); null for acks recorded before #6.
// delegation_acks.turn_seq (#7): the turn/started seq of the child's turn this ack satisfied; set once by
//   the watchdog's turn rule, so an ack counts for one turn only. null: not (yet) matched to a turn.
// delegation_turn_cursors (#7): the turn rule's per-delegation progress through its child's turn events:
//   checked_seq (last turn event taken into account), last_at (its time), the open turn (open_seq/open_at,
//   its lower ack bound open_lower_at) and scanned_at (round robin). baseline_pending marks delegations bound
//   before #7: their first scan sets enforce_from_seq to the child's newest turn event seq and starts there,
//   so turns completed before the upgrade are not checked.
// delegations.idle_after_seq (#9): the child's newest turn event seq when an input was last delivered to it;
//   a completed turn counts as "the child went idle" only above it (null: any completed turn).
// delegation_turn_cursors.last_event_type (#9): type (started|completed) of the event at checked_seq; the
//   watchdog moves an active child to idle when its last turn event is a completed one. null: not read yet.
// delegation_deliveries (#10): one row per message the plugin hands to SANDY's thread send, claimed before the
//   call (sending) and settled after it: sent/queued (SANDY's answer), rejected (a definitive 4xx), unknown (no
//   definitive answer: timeout, 5xx, lost response; reconciled from the child's turn events), lost (no turn
//   came of it within the settle window: the input is queued again). generation is the delegation's
//   delivery_generation the claim set; after_seq the child's newest turn event seq before the send;
//   reservation_owner the token of the reservation the delivery took (null: the child held its slot).
// delegations.delivery_generation (#10): bumped by every claim and settlement of a delivery; the watchdog's
//   active -> idle commit is fenced with it. delegations.reservation_owner (#10): the token of the
//   readmission that moved the row to reserved; only that delivery's definitive rejection undoes it.
// pending_inputs.state 'delivering' (#10, table rebuilt for the CHECK): the input's delivery is claimed.
// questions.form_id (#11): the id the plugin gave the form (sandy.ui.requestInput) currently asking the question;
//   a form result with another id is stale and discarded. questions.answer_source (#11): who answered (form,
//   parent_send, rpc). question_json holds {question, options}, answer_json {answer}.
export const migrations: string[] = [
  `CREATE TABLE agents (
     name TEXT PRIMARY KEY,
     version INTEGER NOT NULL,
     entry_json TEXT NOT NULL,
     entry_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE agent_snapshots (
     snapshot_hash TEXT PRIMARY KEY,
     agent_name TEXT NOT NULL,
     agent_version INTEGER NOT NULL,
     entry_json TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE delegations (
     delegation_id TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('delegate', 'workflow-worker')),
     state TEXT NOT NULL CHECK (state IN ('reserved', 'starting', 'active', 'idle', 'error', 'refused', 'stopped')),
     root_thread_id TEXT NOT NULL,
     parent_thread_id TEXT NOT NULL,
     child_thread_id TEXT UNIQUE,
     agent TEXT NOT NULL,
     agent_version INTEGER,
     snapshot_hash TEXT REFERENCES agent_snapshots(snapshot_hash),
     model TEXT,
     thinking TEXT,
     client_request_id TEXT,
     input_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     bound_at INTEGER
   );
   CREATE UNIQUE INDEX delegations_caller_request_idx
     ON delegations(parent_thread_id, client_request_id) WHERE client_request_id IS NOT NULL;
   CREATE INDEX delegations_root_state_idx ON delegations(root_thread_id, state);
   CREATE TABLE pending_inputs (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     input_id TEXT NOT NULL UNIQUE,
     delegation_id TEXT NOT NULL REFERENCES delegations(delegation_id),
     root_thread_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('steer', 'queue', 'continuation', 'answer')),
     payload_json TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('queued', 'admitted', 'delivered', 'cancelled')),
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX pending_inputs_root_state_idx ON pending_inputs(root_thread_id, state, seq);
   CREATE TABLE questions (
     question_id TEXT PRIMARY KEY,
     delegation_id TEXT NOT NULL REFERENCES delegations(delegation_id),
     state TEXT NOT NULL CHECK (state IN ('open', 'answered', 'delivered', 'cancelled', 'expired')),
     question_json TEXT NOT NULL,
     answer_json TEXT,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     answered_at INTEGER,
     delivered_at INTEGER,
     updated_at INTEGER NOT NULL
   );
   CREATE UNIQUE INDEX questions_one_open_idx ON questions(delegation_id) WHERE state = 'open';`,
  `CREATE TABLE delegation_briefs (
     delegation_id TEXT PRIMARY KEY REFERENCES delegations(delegation_id),
     task TEXT NOT NULL,
     title TEXT,
     created_at INTEGER NOT NULL,
     delivered_at INTEGER
   );
   CREATE TABLE delegation_acks (
     nonce TEXT PRIMARY KEY,
     delegation_id TEXT NOT NULL REFERENCES delegations(delegation_id),
     child_thread_id TEXT NOT NULL,
     policy_hash TEXT NOT NULL,
     issued_at INTEGER NOT NULL,
     acked_at INTEGER,
     pi_session_id TEXT,
     brief_delivered_at INTEGER
   );
   CREATE INDEX delegation_acks_delegation_idx ON delegation_acks(delegation_id, acked_at);`,
  `CREATE TABLE delegation_stops (
     child_thread_id TEXT PRIMARY KEY,
     delegation_id TEXT NOT NULL REFERENCES delegations(delegation_id),
     reason TEXT NOT NULL,
     requested_at INTEGER NOT NULL,
     stopped_at INTEGER,
     attempts INTEGER NOT NULL DEFAULT 0,
     last_error TEXT
   );
   CREATE INDEX delegation_stops_open_idx ON delegation_stops(stopped_at, requested_at);`,
  `ALTER TABLE delegation_stops ADD COLUMN next_attempt_at INTEGER;
   CREATE INDEX delegation_stops_delegation_idx ON delegation_stops(delegation_id, stopped_at);`,
  `CREATE TABLE delegation_markers (
     thread_id TEXT PRIMARY KEY,
     granted_at INTEGER NOT NULL
   );`,
  `ALTER TABLE delegation_acks ADD COLUMN turn INTEGER;`,
  `ALTER TABLE delegation_acks ADD COLUMN turn_seq INTEGER;
   CREATE TABLE delegation_turn_cursors (
     delegation_id TEXT PRIMARY KEY REFERENCES delegations(delegation_id),
     child_thread_id TEXT NOT NULL,
     baseline_pending INTEGER NOT NULL DEFAULT 0,
     enforce_from_seq INTEGER,
     checked_seq INTEGER,
     last_at INTEGER,
     open_seq INTEGER,
     open_at INTEGER,
     open_lower_at INTEGER,
     scanned_at INTEGER
   );
   INSERT INTO delegation_turn_cursors (delegation_id, child_thread_id, baseline_pending)
     SELECT delegation_id, child_thread_id, 1 FROM delegations
     WHERE child_thread_id IS NOT NULL AND state NOT IN ('error', 'refused', 'stopped');`,
  `CREATE TABLE delegation_wait_marks (
     delegation_id TEXT PRIMARY KEY REFERENCES delegations(delegation_id),
     marked_at INTEGER NOT NULL,
     last_attempt_at INTEGER
   );`,
  `ALTER TABLE delegations ADD COLUMN idle_after_seq INTEGER;
   ALTER TABLE delegation_turn_cursors ADD COLUMN last_event_type TEXT;`,
  `ALTER TABLE delegations ADD COLUMN delivery_generation INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE delegations ADD COLUMN reservation_owner TEXT;
   CREATE TABLE delegation_deliveries (
     delivery_id TEXT PRIMARY KEY,
     delegation_id TEXT NOT NULL REFERENCES delegations(delegation_id),
     input_id TEXT,
     generation INTEGER NOT NULL,
     reservation_owner TEXT,
     after_seq INTEGER,
     state TEXT NOT NULL CHECK (state IN ('sending', 'sent', 'queued', 'rejected', 'unknown', 'lost')),
     started_at INTEGER NOT NULL,
     settled_at INTEGER
   );
   CREATE INDEX delegation_deliveries_delegation_idx ON delegation_deliveries(delegation_id, generation);
   CREATE INDEX delegation_deliveries_state_idx ON delegation_deliveries(state, started_at);
   CREATE TABLE pending_inputs_v10 (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     input_id TEXT NOT NULL UNIQUE,
     delegation_id TEXT NOT NULL REFERENCES delegations(delegation_id),
     root_thread_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('steer', 'queue', 'continuation', 'answer')),
     payload_json TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('queued', 'admitted', 'delivering', 'delivered', 'cancelled')),
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   INSERT INTO pending_inputs_v10 (seq, input_id, delegation_id, root_thread_id, kind, payload_json, state, created_at, updated_at)
     SELECT seq, input_id, delegation_id, root_thread_id, kind, payload_json, state, created_at, updated_at FROM pending_inputs;
   DROP TABLE pending_inputs;
   ALTER TABLE pending_inputs_v10 RENAME TO pending_inputs;
   CREATE INDEX pending_inputs_root_state_idx ON pending_inputs(root_thread_id, state, seq);`,
  `ALTER TABLE questions ADD COLUMN form_id TEXT;
   ALTER TABLE questions ADD COLUMN answer_source TEXT CHECK (answer_source IN ('form', 'parent_send', 'rpc'));`,
];
