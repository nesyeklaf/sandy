import { isInvalidInput, isUnknownKeyRejection, toClientWire, toLegacyWire, toWire, type Client, type RecordInput, type Sample } from "./contract.ts";

export type RecordCall = (input: RecordInput) => Promise<unknown>;

export type RecordOutcome = "sent" | "dropped";

export interface RecordSender {
  send(call: RecordCall, client: Client, batch: readonly Sample[]): Promise<RecordOutcome>;
  readonly legacy: boolean;
}

export function createRecordSender(): RecordSender {
  let legacy = false;
  return {
    get legacy() {
      return legacy;
    },
    async send(call, client, batch) {
      if (!legacy) {
        try {
          await call({ client: toClientWire(client), samples: batch.map(toWire) });
          return "sent";
        } catch (error) {
          if (!isUnknownKeyRejection(error)) throw error;
          legacy = true;
        }
      }
      try {
        await call(toLegacyWire(client, batch));
        return "sent";
      } catch (error) {
        if (isInvalidInput(error)) return "dropped";
        throw error;
      }
    },
  };
}
