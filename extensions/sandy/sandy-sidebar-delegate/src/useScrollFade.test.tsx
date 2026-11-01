// @vitest-environment jsdom
import { expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useScrollFade } from "./useScrollFade";

function Scroller({ loaded }: { loaded: boolean }) {
  const ref = useScrollFade<HTMLDivElement>();
  return (
    <div data-testid="scroller" ref={ref}>
      {loaded ? <div>Loaded rows</div> : null}
    </div>
  );
}

it("updates the edge fade when loading replaces the scroller contents", async () => {
  const view = render(<Scroller loaded={false} />);
  const node = screen.getByTestId("scroller");
  Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => (node.children.length ? 200 : 100) });
  Object.defineProperty(node, "clientHeight", { configurable: true, value: 100 });
  view.rerender(<Scroller loaded={true} />);
  await waitFor(() => expect(node.style.getPropertyValue("--scroll-fade-bottom")).toBe("12px"));
});
