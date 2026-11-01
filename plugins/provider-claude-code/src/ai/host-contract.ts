import { defineRpcContract } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";

const claudeAiTextResultSchema = z.union([
  z.object({ ok: z.literal(true), text: z.string() }).strict(),
  z.object({ ok: z.literal(false), message: z.string().min(1) }).strict(),
]);
export type ClaudeAiTextResult = z.infer<typeof claudeAiTextResultSchema>;

export const claudeAiCompleteInputSchema = z
  .object({
    model: z.string().min(1),
    prompt: z.string().min(1),
    timeoutMs: z.number().int().positive(),
  })
  .strict();
export type ClaudeAiCompleteInput = z.infer<typeof claudeAiCompleteInputSchema>;

export const claudeAiStatusSchema = z.discriminatedUnion("ready", [
  z.object({ ready: z.literal(true) }).strict(),
  z.object({ ready: z.literal(false), message: z.string().min(1) }).strict(),
]);
export type ClaudeAiStatus = z.infer<typeof claudeAiStatusSchema>;

export const claudeAiHostContract = defineRpcContract({
  "claude.ai.complete": {
    input: claudeAiCompleteInputSchema,
    output: claudeAiTextResultSchema,
  },
  "claude.ai.status": {
    input: z.object({}).strict(),
    output: claudeAiStatusSchema,
  },
});
