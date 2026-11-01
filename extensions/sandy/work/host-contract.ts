// The plugin's one host entry serves every part's host methods. A part's server keeps calling with
// its own contract (SANDY checks the method against the contract of the call), so only the entry and
// this union need to know all of them.
import { defineRpcContract } from "@sandy-sdk/plugin-sdk";
import { hostContract as delegate } from "./delegate/host-contract.ts";
import { hostContract as goals } from "./goals/contract.ts";
import { hostContract as track } from "./track/contract.ts";

const parts = [delegate, track, goals] as const;
const names = parts.flatMap((part) => Object.keys(part));
const clash = names.find((name, index) => names.indexOf(name) !== index);
if (clash !== undefined) throw new Error(`host method "${clash}" is defined by two parts`);

export const hostContract = defineRpcContract({ ...delegate, ...track, ...goals });
