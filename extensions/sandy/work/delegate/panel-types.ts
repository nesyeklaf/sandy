// What the Delegates panel (app.tsx) gets from the panel RPCs (server/panel.ts). Kept free of server
// imports so the app bundle carries types only.
export type PanelQuestion = { questionId: string; state: "open" | "answered"; question: string; options: string[]; askedAt: number; expiresAt: number };

export type PanelRow = {
  delegationId: string;
  threadId: string | null;
  parentThreadId: string;
  agent: string;
  agentVersion: number | null;
  role: "reader" | "writer" | null;
  title: string | null;
  // The ledger state and the one-word summary of sandy_delegate_status (running, completed, failed ...).
  state: string;
  status: string;
  model: string | null;
  reasoningLevel: string | null;
  tokens: { total: number | null; context: number | null; contextWindow: number | null };
  runtime: { sinceBoundMs: number | null; lastTurnMs: number | null; lastTurnRunning: boolean };
  stale: boolean;
  error: string | null;
  question: PanelQuestion | null;
  // SANDY's visibility of the child thread; null while unbound or unknown.
  hidden: boolean | null;
  // The owner acknowledged this failure (ackFailures); only ever true while the row still fails that way.
  acknowledged: boolean;
  createdAt: number;
  sandyError?: string;
};

export type PanelList = {
  // The root the panel shows: the viewed thread itself, or the root of the viewed delegate child.
  rootThreadId: string;
  viewedIsChild: boolean;
  rows: PanelRow[];
  truncated: boolean;
};

export type AckRecord = { turn: number | null; issuedAt: number; ackedAt: number | null; turnSeq: number | null; briefDeliveredAt: number | null };

export type PromptAudit = {
  delegationId: string;
  agent: string;
  agentVersion: number | null;
  snapshotHash: string | null;
  role: "reader" | "writer" | null;
  model: string | null;
  thinking: string | null;
  // The catalog entry's allowlist vs. the policy the gate enforces (allowlist + protocol tools) and its transport tools.
  requestedTools: string[];
  activeTools: string[];
  transportTools: string[];
  policyHash: string | null;
  bootstrapPrompt: string;
  brief: { title: string | null; body: string | null; task: string; deliveredAt: number | null } | null;
  // Acks grouped by pi session, oldest session first; a nonce issued but never acked has piSessionId null.
  sessions: { piSessionId: string | null; acks: AckRecord[] }[];
};

export type WriterDetails = {
  branch: string;
  // The parent checkout's branch the Merge button merges into, and its path on the host.
  base: string;
  checkoutPath: string;
  commits: string[];
  files: { status: string; path: string }[];
  merged: boolean;
};
