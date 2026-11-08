import { describe, expect, it } from "vitest";
import { Model } from "./model.ts";
import { expected, fixtureEnv, SHOP, shopEvidence, withoutText } from "../test/fixture.ts";

describe("core model on the shop fixture", () => {
  const model = Model.load(SHOP, shopEvidence());

  it("checks like expected/check.json", () => {
    expect(withoutText(model.check())).toEqual(withoutText(expected("check.json")));
  });

  it("lists drift like expected/drift.json", () => {
    expect(withoutText(model.drift(fixtureEnv))).toEqual(withoutText(expected("drift.json")));
  });

  it.each(["password-reset", "account", "sign-in"])("views %s like expected/view-%s.json", (slug) => {
    expect(withoutText(model.view(slug, fixtureEnv))).toEqual(withoutText(expected(`view-${slug}.json`)));
  });

  it("matches the expected detail texts too", () => {
    expect(model.drift(fixtureEnv)).toEqual(expected("drift.json"));
    for (const slug of ["password-reset", "account", "sign-in"]) expect(model.view(slug, fixtureEnv)).toEqual(expected(`view-${slug}.json`));
    expect(model.check()).toEqual(expected("check.json"));
  });
});
