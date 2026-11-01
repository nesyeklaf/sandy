import { it } from "vitest";
import { exerciseAppWorkerState } from "./test-app-worker-state";

it("cleans shared app state around the second file", exerciseAppWorkerState);
