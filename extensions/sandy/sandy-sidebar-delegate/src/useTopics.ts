import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { sandySidebarRpcContract } from "./contract";
import { TOPICS_CHANNEL } from "./realtime-channels";
import { getSuggestions, setSuggestions, useSuggestions } from "./useSuggestions";
import type { TopicSuggestion } from "./topic-layout";
import type { TopicMessage, TopicSegment } from "./topics-contract";

const REFRESH_MS = 20_000;

interface TopicsState {
  messages: TopicMessage[];
  segments: TopicSegment[];
  threadTags: string[];
  loaded: boolean;
  error: string | null;
}

const EMPTY: TopicsState = { messages: [], segments: [], threadTags: [], loaded: false, error: null };

/** Messages and topic ranges of one session, refreshed on change and while the tab is open. */
export function useTopics(threadId: string) {
  const rpc = useRpc<typeof sandySidebarRpcContract>();
  const [state, setState] = useState<TopicsState>(EMPTY);
  const suggestions = useSuggestions(threadId);
  const [suggesting, setSuggesting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [messages, topics] = await Promise.all([
        rpc.call("getThreadMessages", { threadId }),
        rpc.call("listTopics", { threadId }),
      ]);
      setState({
        messages: messages.messages,
        segments: topics.segments,
        threadTags: topics.threadTags,
        loaded: true,
        error: null,
      });
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }));
    }
  }, [rpc, threadId]);

  useEffect(() => {
    setState(EMPTY);
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useRealtime(TOPICS_CHANNEL, () => void refresh());

  const actions = {
    save: async (input: { id?: string; fromSeq: number; toSeq: number; title: string }) => {
      const segment = await rpc.call("saveTopic", { threadId, ...input });
      await refresh();
      return segment;
    },
    /** Asks the model for topics; nothing is stored until a suggestion is accepted. */
    suggest: async () => {
      setSuggesting(true);
      try {
        const result = await rpc.call("suggestTopics", { threadId });
        setSuggestions(threadId, result.suggestions);
        return result.suggestions.length;
      } finally {
        setSuggesting(false);
      }
    },
    discard: (fromSeq: number, toSeq: number) =>
      setSuggestions(
        threadId,
        suggestions.filter((s) => s.fromSeq !== fromSeq || s.toSeq !== toSeq),
      ),
    discardAll: () => setSuggestions(threadId, []),
    /** Saves a suggestion as a topic with its tags. */
    accept: async (suggestion: TopicSuggestion) => {
      const segment = await rpc.call("saveTopic", {
        threadId,
        fromSeq: suggestion.fromSeq,
        toSeq: suggestion.toSeq,
        title: suggestion.title,
      });
      if (suggestion.tags.length > 0) {
        await rpc.call("setTopicTags", { kind: "segment", ownerId: segment.id, tags: suggestion.tags });
      }
      setSuggestions(
        threadId,
        getSuggestions(threadId).filter((s) => s.fromSeq !== suggestion.fromSeq || s.toSeq !== suggestion.toSeq),
      );
      await refresh();
    },
    remove: async (id: string) => {
      await rpc.call("deleteTopic", { id });
      await refresh();
    },
    setTags: async (kind: "thread" | "segment", ownerId: string, tags: string[]) => {
      await rpc.call("setTopicTags", { kind, ownerId, tags });
      await refresh();
    },
  };
  return { ...state, suggestions, suggesting, refresh, ...actions };
}
