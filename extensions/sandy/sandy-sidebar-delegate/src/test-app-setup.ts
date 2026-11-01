import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { resetProjectFaviconsForTests } from "./ProjectFavicon";
import { resetTitleGenerationForTests } from "./title-generation-state";
import { resetWorkingEmptyLineForTests } from "./working-empty-lines";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

function resetAppState() {
  resetProjectFaviconsForTests();
  resetTitleGenerationForTests();
  resetWorkingEmptyLineForTests();
  localStorage.clear();
  sessionStorage.clear();
}

// Setup files run for every file, even when imported helpers are cached.
beforeEach(resetAppState);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetAppState();
});
