import { defineRpcContract } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";

const changedFile = z.object({ status: z.string(), path: z.string() }).strict();

export const branchChangesResult = z
  .object({ branch: z.string(), base: z.string(), commits: z.array(z.string()), files: z.array(changedFile), merged: z.boolean() })
  .strict();

export const mergeResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("merged"), branch: z.string(), into: z.string(), commit: z.string() }).strict(),
  z.object({ status: z.literal("up_to_date"), branch: z.string(), into: z.string() }).strict(),
  z.object({ status: z.literal("dirty"), message: z.string(), files: z.array(z.string()) }).strict(),
  z.object({ status: z.literal("conflict"), message: z.string(), files: z.array(z.string()), clean: z.boolean() }).strict(),
  z.object({ status: z.literal("failed"), message: z.string(), clean: z.boolean() }).strict(),
]);

/** Host RPC: only the host process can run git in a checkout on its machine (host-git.ts). */
export const hostContract = defineRpcContract({
  branchChanges: { input: z.object({ path: z.string().min(1), branch: z.string().min(1) }).strict(), output: branchChangesResult },
  mergeBranch: { input: z.object({ path: z.string().min(1), branch: z.string().min(1), message: z.string().min(1) }).strict(), output: mergeResult },
});
