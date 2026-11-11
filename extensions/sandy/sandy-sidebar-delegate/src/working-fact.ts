export interface OwnAttention {
  hasPendingInteraction: boolean;
  waitingForInput: boolean;
  unreadError: boolean;
  queuedWork: string;
}

export function blocksWorking(own: OwnAttention): boolean {
  return own.hasPendingInteraction || own.waitingForInput || own.unreadError || own.queuedWork === "failed";
}
