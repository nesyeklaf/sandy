import { defineRpcContract } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";
import type { PanelList, PromptAudit, WriterDetails } from "./panel-types.ts";
import type { MergeResult } from "./host-git.ts";

// UI <-> server. answerQuestion answers the named open question of a delegated child (the Delegates panel);
// a replay after that question was answered is refused. A plugin caller is refused; any client may call it
// (accepted residual, see server/index.ts). Delivery as in server/control.ts answerQuestion:
// delivered, or queued until a slot of the root frees, or retrying after a failed delivery.
//
// The panel methods take the thread the panel is open on (threadId) and act only on that thread's own
// delegations, or on the viewed child itself (server/panel.ts authorizePanel); a refusal is a thrown error
// with its message. Outputs are built by the server; their types live in panel-types.ts.
const panelTarget = { threadId: z.string().min(1), delegationId: z.string().min(1) };

const sendOutcome = z.object({ status: z.enum(["delivered", "queued", "answered"]), delegationId: z.string(), detail: z.string() }).strict();
const stopEntry = z.object({ delegationId: z.string(), state: z.string(), stopConfirmed: z.boolean(), error: z.string().optional() }).strict();

export const rpcContract = defineRpcContract({
  answerQuestion: {
    input: z.object({ delegationId: z.string().min(1), questionId: z.string().min(1), answer: z.string().min(1).max(20_000) }).strict(),
    output: z.object({ questionId: z.string(), delivery: z.enum(["delivered", "queued", "retrying"]) }).strict(),
  },
  listDelegates: { input: z.object({ threadId: z.string().min(1) }).strict(), output: z.custom<PanelList>() },
  promptAudit: { input: z.object(panelTarget).strict(), output: z.custom<PromptAudit>() },
  sendToDelegate: {
    input: z.object({ ...panelTarget, message: z.string().min(1).max(20_000), mode: z.enum(["steer", "queue"]) }).strict(),
    output: sendOutcome,
  },
  // delegationId absent: every not ended delegation of the thread (Stop all).
  stopDelegates: {
    input: z.object({ threadId: z.string().min(1), delegationId: z.string().min(1).optional() }).strict(),
    output: z.object({ stopped: z.array(stopEntry), skipped: z.array(z.object({ delegationId: z.string(), reason: z.string() }).strict()) }).strict(),
  },
  // delegationId absent: every failed delegation of the thread (Acknowledge all). Returns the acknowledged ids.
  ackFailures: {
    input: z.object({ threadId: z.string().min(1), delegationId: z.string().min(1).optional() }).strict(),
    output: z.object({ acknowledged: z.array(z.string()) }).strict(),
  },
  setDelegateHidden: { input: z.object({ ...panelTarget, hidden: z.boolean() }).strict(), output: z.object({ hidden: z.boolean() }).strict() },
  writerDetails: { input: z.object(panelTarget).strict(), output: z.custom<WriterDetails>() },
  // A conflict, a dirty checkout or a failed merge is a result (status), not a thrown error.
  mergeDelegate: { input: z.object(panelTarget).strict(), output: z.custom<MergeResult>() },
});
