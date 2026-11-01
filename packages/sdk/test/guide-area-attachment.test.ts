import { describe, expect, it } from "vitest";
import { createBrowserSandySdk } from "../src/browser.js";
import { createNodeSandySdk } from "../src/node.js";

describe("guide area attachment", () => {
  it("attaches a working local guide to the Node SDK", () => {
    const sdk = createNodeSandySdk({ baseUrl: "http://server" });

    expect(Object.hasOwn(sdk, "guide")).toBe(true);
    expect(sdk.guide.render({ chapter: "threads" }).content).toContain(
      "thread",
    );
  });

  it("does not attach the guide to the browser SDK", () => {
    const sdk = createBrowserSandySdk({ baseUrl: "http://server" });

    expect(Object.hasOwn(sdk, "guide")).toBe(false);
    expect(typeof sdk.threads.list).toBe("function");
  });
});
