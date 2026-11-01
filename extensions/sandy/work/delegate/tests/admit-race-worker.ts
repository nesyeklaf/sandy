// One side of the admission race in ledger.test.ts: opens its own connection to the shared DB file,
// waits at the barrier, then admits one child.
import { parentPort, workerData } from "node:worker_threads";
import { admit } from "../server/ledger.ts";
import { openDb } from "./db-fixture.ts";

const { file, barrier, rootThreadId, callerThreadId } = workerData as {
  file: string;
  barrier: SharedArrayBuffer;
  rootThreadId: string;
  callerThreadId: string;
};
const db = openDb(file, { migrate: false });
const gate = new Int32Array(barrier);
parentPort!.postMessage({ ready: true });
Atomics.wait(gate, 0, 0);
const result = admit(db, { rootThreadId, callerThreadId, kind: "delegate", agent: "scout", inputHash: callerThreadId }, { maxConcurrentChildren: 4 });
db.close();
parentPort!.postMessage({ ok: result.ok, code: result.ok ? null : result.refusal.code });
