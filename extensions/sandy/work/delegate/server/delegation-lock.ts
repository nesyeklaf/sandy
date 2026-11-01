// The per-delegation lock of this process: send, stop, the queue drain's deliveries and reconciliations, and
// the watchdog's active -> idle transition each run their check, SANDY calls and ledger writes for one
// delegation under it, one at a time in arrival order, so none acts on a state another changes meanwhile.
// The ledger's compare-and-set writes remain the guard against everything outside this process's locks.
const tails = new Map<string, Promise<void>>();

export async function withDelegationLock<T>(delegationId: string, run: () => Promise<T>): Promise<T> {
  const previous = tails.get(delegationId) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => done);
  tails.set(delegationId, tail);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (tails.get(delegationId) === tail) tails.delete(delegationId);
  }
}
