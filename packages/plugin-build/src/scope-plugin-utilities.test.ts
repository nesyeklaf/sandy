import { describe, expect, it } from "vitest";
import {
  dropHostDuplicateUtilities,
  dropHostProvidedTailwind,
  pluginScopeRoots,
  scopePluginUtilities,
} from "./scope-plugin-utilities.js";

const ROOTS = pluginScopeRoots("demo");
const OWNED = ':where([data-sandy-plugin="demo"])';
const PORTAL = ":where([data-sandy-plugin-root]:not([data-sandy-plugin]))";

function both(selector: string): string {
  return `${OWNED} ${selector},${OWNED}${selector},${PORTAL} ${selector},${PORTAL}${selector}`;
}

function each(selector: string, body: string): string {
  return both(selector)
    .split(",")
    .map((arm) => `${arm}{${body}}`)
    .join("");
}

function scopeUtilities(utilities: string): string {
  return scopePluginUtilities(`@layer utilities{${utilities}}`, ROOTS);
}

describe("scopePluginUtilities", () => {
  it("preserves owned and anonymous portal roots", () => {
    expect(pluginScopeRoots("demo")).toEqual([
      '[data-sandy-plugin="demo"]',
      "[data-sandy-plugin-root]:not([data-sandy-plugin])",
    ]);
  });

  it("gives every root its own selector so no selector carries a root list", () => {
    const scoped = scopeUtilities(".a{color:red}");
    expect(scoped).not.toMatch(/:where\([^()]*,/);
    expect(scoped).not.toContain(":is(");
  });

  it("emits descendant and self selectors per root", () => {
    expect(scopeUtilities(".flex-col{flex-direction:column}")).toBe(
      `@layer utilities{${each(".flex-col", "flex-direction:column")}}`,
    );
  });

  it("scopes each selector in a list", () => {
    expect(scopeUtilities(".a,.b{color:red}")).toBe(
      `@layer utilities{${both(".a")},${both(".b")}{color:red}}`,
    );
  });

  it("preserves nesting specificity when the original selector list has different specificities", () => {
    expect(scopeUtilities(".a,#b{&:hover{color:red}}")).toBe(
      `@layer utilities{${both(".a")},${both("#b")}{&:hover{color:red}}}`,
    );
  });

  it("keeps commas inside :is()/:not() out of the selector split", () => {
    const scoped = scopeUtilities(":is(.a,.b) > .c{color:red}");
    expect(scoped).toBe(
      `@layer utilities{${[OWNED, PORTAL].flatMap((root) => [`${root} :is(.a,.b) > .c{color:red}`, `${root}:is(.a,.b) > .c{color:red}`]).join("")}}`,
    );
  });

  it("drops the self arm for sibling combinators so a portal root cannot reach host siblings", () => {
    const hidden = String.raw`.\[\&\~\*\]\:hidden`;
    expect(scopeUtilities(`${hidden}{&~*{display:none}}`)).toBe(
      `@layer utilities{${OWNED} ${hidden}{&~*{display:none}}${PORTAL} ${hidden}{&~*{display:none}}}`,
    );
    expect(scopeUtilities(`${hidden} ~ *{display:none}`)).toBe(
      `@layer utilities{${OWNED} ${hidden} ~ *{display:none}${PORTAL} ${hidden} ~ *{display:none}}`,
    );
    expect(scopeUtilities(".a{+ .b{color:red}}")).toBe(
      `@layer utilities{${OWNED} .a{+ .b{color:red}}${PORTAL} .a{+ .b{color:red}}}`,
    );
    expect(
      scopeUtilities(".a{@media (hover:hover){&:hover + .b{color:red}}}"),
    ).toBe(
      `@layer utilities{${OWNED} .a{@media (hover:hover){&:hover + .b{color:red}}}${PORTAL} .a{@media (hover:hover){&:hover + .b{color:red}}}}`,
    );
  });

  it("keeps both arms when a sibling combinator precedes & so the subject stays on the element", () => {
    expect(scopeUtilities(".x{.a ~ &{color:red}}")).toBe(
      `@layer utilities{${each(".x", ".a ~ &{color:red}")}}`,
    );
    expect(scopeUtilities(".x{&:hover{color:red}}")).toBe(
      `@layer utilities{${each(".x", "&:hover{color:red}")}}`,
    );
  });

  it("keeps both arms when + or ~ only appear escaped, in attributes, or inside :is()", () => {
    const peer = String.raw`.peer-checked\:hidden:is(:where(.peer):checked ~ *)`;
    expect(scopeUtilities(`${peer}{display:none}`)).toContain(
      `${PORTAL}${peer}`,
    );
    const attr = String.raw`[data-x~="a"].mt-\[calc\(1px\+2px\)\]`;
    expect(scopeUtilities(`${attr}{margin:0}`)).toContain(`${OWNED}${attr}`);
  });

  it("keeps the scope in front of a pseudo-element so the selector stays valid", () => {
    expect(scopeUtilities(".content-x::before{content:'x'}")).toContain(
      `${OWNED}.content-x::before`,
    );
  });

  it("survives escaped class names and braces inside strings", () => {
    const scoped = scopeUtilities(String.raw`.w-\[50\%\]{content:"}"}`);
    expect(scoped).toBe(
      `@layer utilities{${each(String.raw`.w-\[50\%\]`, 'content:"}"')}}`,
    );
  });

  it("scopes rules nested in conditional at-rules", () => {
    const scoped = scopeUtilities(
      "@media (min-width:40rem){.md-flex{display:flex}}",
    );
    expect(scoped).toBe(
      `@layer utilities{@media (min-width:40rem){${each(".md-flex", "display:flex")}}}`,
    );
  });

  it("leaves keyframe selectors alone", () => {
    const scoped = scopeUtilities(
      "@keyframes spin{from{rotate:0deg}to{rotate:360deg}}",
    );
    expect(scoped).toBe(
      "@layer utilities{@keyframes spin{from{rotate:0deg}to{rotate:360deg}}}",
    );
  });

  it("leaves theme variables and @property registrations unscoped", () => {
    const css = [
      "@layer theme{:root{--color-red:red}}",
      '@property --tw-scale-x{syntax:"*";inherits:false}',
      "@layer utilities{.scale-x-50{--tw-scale-x:50%}}",
    ].join("");
    const scoped = scopePluginUtilities(css, ROOTS);
    expect(scoped).toContain("@layer theme{:root{--color-red:red}}");
    expect(scoped).toContain(
      '@property --tw-scale-x{syntax:"*";inherits:false}',
    );
    expect(scoped).toContain(`${OWNED}.scale-x-50`);
  });

  it("preserves the license banner in readable optimized CSS", () => {
    const banner =
      "/*! tailwindcss v4.3.0 | MIT License | https://tailwindcss.com */";
    expect(
      scopePluginUtilities(`${banner}@layer utilities{.a{color:red}}`, ROOTS),
    ).toBe(`${banner}@layer utilities{${each(".a", "color:red")}}`);
  });

  it("accepts a build with no utilities layer", () => {
    expect(scopePluginUtilities("@layer theme{:root{--a:1}}", ROOTS)).toBe(
      "@layer theme{:root{--a:1}}",
    );
  });

  it("throws when a class rule lands outside the utilities layer", () => {
    expect(() =>
      scopePluginUtilities(
        "@layer theme{.flex-col{flex-direction:column}}",
        ROOTS,
      ),
    ).toThrow(/class rule outside the utilities layer/);
  });

  it("allows the universal registered-property fallback layer", () => {
    const css =
      "@layer properties{@supports (top:1px){*,::before{--tw-blur:initial}}}" +
      "@layer utilities{.blur-sm{filter:blur(4px)}}";
    expect(() => scopePluginUtilities(css, ROOTS)).not.toThrow();
  });
});

describe("dropHostProvidedTailwind", () => {
  const HOST = [
    "@layer theme {\n  :root, :host {\n    --spacing: 0.25rem;\n    --color-red-500: oklch(63.7% 0.237 25.331);\n  }\n}",
    '@property --tw-blur {\n  syntax: "*";\n  inherits: false;\n}',
    '@property --tw-shadow {\n  syntax: "*";\n  inherits: false;\n  initial-value: 0 0 #0000;\n}',
  ].join("\n");

  it("drops registrations the host makes and their fallback declarations", () => {
    const css =
      "@layer properties{@supports (top:1px){*,::before{--tw-blur:initial;--tw-shadow:0 0 #0000;--x-own:1}}}" +
      "@layer utilities{.shadow{--tw-shadow:0 1px #000;box-shadow:var(--tw-shadow)}}" +
      '@property --tw-blur{syntax:"*";inherits:false}' +
      '@property --tw-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}' +
      '@property --x-own{syntax:"*";inherits:false;initial-value:1}';
    expect(dropHostProvidedTailwind(css, HOST)).toBe(
      "@layer properties{@supports (top:1px){*,::before{--x-own:1}}}" +
        "@layer utilities{.shadow{--tw-shadow:0 1px #000;box-shadow:var(--tw-shadow)}}" +
        '@property --x-own{syntax:"*";inherits:false;initial-value:1}',
    );
  });

  it("keeps a registration whose descriptors differ from the host's", () => {
    const css =
      '@property --tw-shadow{syntax:"*";inherits:false;initial-value:none}';
    expect(dropHostProvidedTailwind(css, HOST)).toBe(css);
  });

  it("removes the fallback layer once every declaration in it is dropped", () => {
    const css =
      "@layer properties;@layer properties{@supports (top:1px){*{--tw-blur:initial}}}" +
      '@property --tw-blur{syntax:"*";inherits:false}' +
      "@layer utilities{.a{color:red}}";
    expect(dropHostProvidedTailwind(css, HOST)).toBe(
      "@layer properties;@layer utilities{.a{color:red}}",
    );
  });

  it("drops theme variables the host declares with the same value", () => {
    const css =
      "@layer theme{:root,:host{--spacing:0.25rem;--color-red-500:red;--text-xs:0.75rem}}" +
      "@layer utilities{.p-1{padding:calc(var(--spacing) * 1)}}";
    expect(dropHostProvidedTailwind(css, HOST)).toBe(
      "@layer theme{:root,:host{--color-red-500:red;--text-xs:0.75rem}}" +
        "@layer utilities{.p-1{padding:calc(var(--spacing) * 1)}}",
    );
  });

  it("removes the theme layer once the host declares all of it", () => {
    expect(
      dropHostProvidedTailwind(
        "@layer theme{:root,:host{--spacing:0.25rem}}@layer utilities{.a{color:red}}",
        HOST,
      ),
    ).toBe("@layer utilities{.a{color:red}}");
  });
});

describe("dropHostDuplicateUtilities", () => {
  const HOST_APP =
    "@layer theme{:root{--spacing:0.25rem}}" +
    "@layer utilities{.flex{display:flex}.hidden{display:none}.p-1{padding:4px}" +
    "@media (width>=40rem){.sm\\:flex{display:flex}}}";
  const BASE = "@layer base{button{color:red}}";

  function drop(utilities: string, base = ""): string {
    return dropHostDuplicateUtilities(
      `${base}@layer utilities{${utilities}}`,
      HOST_APP,
      "demo",
    );
  }

  it("drops a scoped utility the host already declares identically", () => {
    expect(drop(each(".flex", "display:flex") + each(".a", "color:red"))).toBe(
      `@layer utilities{${each(".a", "color:red")}}`,
    );
  });

  it("matches the root a minifier wrote without attribute quotes", () => {
    const unquoted = both(".p-1").replace(/"demo"/g, "demo");
    expect(drop(`${unquoted}{padding:4px}`)).toBe("");
  });

  it("keeps a utility whose declarations differ from the host's", () => {
    const css = each(".p-1", "padding:8px");
    expect(drop(css)).toBe(`@layer utilities{${css}}`);
  });

  it("keeps a duplicate that sits in another at-rule context than the host's", () => {
    const css = `@media (width>=48rem){${each(".flex", "display:flex")}}`;
    expect(drop(css)).toBe(`@layer utilities{${css}}`);
  });

  it("drops a duplicate inside the same at-rule context", () => {
    expect(
      drop(`@media (width>=40rem){${each(".sm\\:flex", "display:flex")}}`),
    ).toBe("");
  });

  it("keeps a duplicate that must still win over an earlier plugin-only rule", () => {
    const css =
      each(".grid-ish", "display:grid") + each(".hidden", "display:none");
    expect(drop(css)).toBe(`@layer utilities{${css}}`);
  });

  it("drops a duplicate before a plugin-only rule of the same property", () => {
    expect(
      drop(each(".hidden", "display:none") + each(".grid-ish", "display:grid")),
    ).toBe(`@layer utilities{${each(".grid-ish", "display:grid")}}`);
  });

  it("leaves layers other than utilities alone", () => {
    expect(drop("", BASE)).toBe(BASE);
  });
});
