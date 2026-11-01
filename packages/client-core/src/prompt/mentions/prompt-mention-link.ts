import type { PromptMentionResource } from "@sandy/domain";

export type PromptMentionLinkResolver = (
  resource: PromptMentionResource,
) => (() => void) | null;
