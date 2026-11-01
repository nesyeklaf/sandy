import { expect } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { ProjectFavicon } from "./ProjectFavicon";
import { beginTitleGeneration, useTitleGenerating } from "./title-generation-state";
import { pickWorkingEmptyLine, WORKING_EMPTY_LINES } from "./working-empty-lines";

function TitleProgress() {
  return <span>{String(useTitleGenerating("worker-state"))}</span>;
}

// Both files use the same keys, leave state dirty, and never reset it themselves.
// Running them together on one worker exercises file boundaries in either order.
export function exerciseAppWorkerState() {
  expect(beginTitleGeneration("worker-state")).toBe(true);
  expect(beginTitleGeneration("worker-state")).toBe(false);
  const progress = render(<TitleProgress />);
  expect(progress.container.textContent).toBe("true");

  for (const [src, event] of [
    ["/worker-state-loaded", fireEvent.load],
    ["/worker-state-failed", fireEvent.error],
  ] as const) {
    const view = render(<ProjectFavicon src={src} name="Worker" />);
    const image = view.container.querySelector("img")!;
    expect(image.className).toBe("hidden");
    expect(image.getAttribute("src")).toBe(src);
    event(image);
    if (event === fireEvent.load) expect(view.container.querySelector("img.object-contain")).not.toBeNull();
    else expect(view.container.querySelector("img")).toBeNull();
  }

  expect(pickWorkingEmptyLine(() => 0)).toBe(WORKING_EMPTY_LINES[0]);
  expect(pickWorkingEmptyLine(() => 0)).toBe(WORKING_EMPTY_LINES[1]);
}
