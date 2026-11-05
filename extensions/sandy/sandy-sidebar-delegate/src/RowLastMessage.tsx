import { useLastMessage } from "./useLastMessages";

export function RowLastMessage({ threadId }: { threadId: string }) {
  const text = useLastMessage(threadId);
  if (text === null) return null;
  return (
    <p
      data-settle-fade=""
      className="pointer-events-none relative col-span-full min-w-0 truncate text-2xs text-muted-foreground/80"
    >
      {text}
    </p>
  );
}
