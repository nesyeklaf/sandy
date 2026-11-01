import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { experimental_scanPublicSdkOnly as scanPublicSdkOnly } from "../index.js";

let packageRoot: string;

function plant(files: Record<string, string>, manifest: object = {}): void {
  packageRoot = mkdtempSync(join(tmpdir(), "sandy-public-sdk-only-"));
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "planted", ...manifest }),
  );
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(join(packageRoot, file, ".."), { recursive: true });
    writeFileSync(join(packageRoot, file), source);
  }
}

afterEach(() => {
  rmSync(packageRoot, { recursive: true, force: true });
});

describe("experimental_scanPublicSdkOnly", () => {
  it("walks the package, skipping node_modules and dist, and accepts the published SDK surface", () => {
    plant({
      "server.ts": `import { z } from "zod";\nimport type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";\nimport { join } from "node:path";\nimport { helper } from "./src/helper.js";\n`,
      "src/helper.ts": `import "@sandy-sdk/plugin-sdk/provider-bridge";\nimport "@sandy-sdk/plugin-sdk/provider-bridge/acp";\nimport "@sandy-sdk/plugin-sdk/host";\nexport const helper = 1;\n`,
      "app.tsx": `import "@sandy-sdk/plugin-sdk/app";\n`,
      "server.test.ts": `import { it } from "vitest";\nimport "@sandy-sdk/plugin-sdk/testing";\nimport "@sandy-sdk/plugin-sdk/provider-bridge/testing";\n`,
      "node_modules/dep/index.js": `require("@sandy/domain");\n`,
      "dist/server.js": `import "@sandy/domain";\n`,
    });
    const scan = scanPublicSdkOnly(packageRoot);
    expect(scan.files.sort()).toEqual([
      "app.tsx",
      "server.test.ts",
      "server.ts",
      join("src", "helper.ts"),
    ]);
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });

  it("reports a private workspace import, a specifier outside the allowlist, and a testing subpath in plugin code", () => {
    plant({
      "server.ts": `import { events } from "@sandy/db";\nimport yaml from "yaml";\nimport "@sandy-sdk/plugin-sdk/testing";\n`,
      "server.test.ts": `import { createFakePluginHost } from "@sandy-sdk/plugin-sdk/testing";\nimport { describe } from "vitest";\n`,
    });
    expect(scanPublicSdkOnly(packageRoot).violations).toEqual([
      { file: "server.ts", specifier: "@sandy/db", reason: "private-package" },
      { file: "server.ts", specifier: "yaml", reason: "outside-allowlist" },
      {
        file: "server.ts",
        specifier: "@sandy-sdk/plugin-sdk/testing",
        reason: "outside-allowlist",
      },
    ]);
  });

  it("admits the public packages a plugin names in `allow`, for plugin code and tests alike", () => {
    plant({
      "src/host.ts": `import { parse } from "smol-toml";\nimport yaml from "yaml";\n`,
      "src/host.test.ts": `import { parse } from "smol-toml";\n`,
    });
    expect(
      scanPublicSdkOnly(packageRoot, { allow: [/^yaml$/u, /^smol-toml$/u] })
        .violations,
    ).toEqual([]);
    expect(scanPublicSdkOnly(packageRoot).violations).toHaveLength(3);
  });

  it("reports a relative import that resolves outside the package root and admits one inside it", () => {
    plant({
      "src/bridge.ts": `import { threadEventSchema } from "../../outside.js";\nimport { helper } from "./inside.js";\nimport { shared } from "../sibling.js";\nimport { config } from "../../vitest.shared.js";\n`,
      "src/inside.ts": "export const helper = 1;\n",
      "sibling.ts": "export const shared = 1;\n",
    });
    expect(scanPublicSdkOnly(packageRoot).violations).toEqual([
      {
        file: join("src", "bridge.ts"),
        specifier: "../../outside.js",
        reason: "outside-package",
      },
      {
        file: join("src", "bridge.ts"),
        specifier: "../../vitest.shared.js",
        reason: "outside-package",
      },
    ]);
    expect(
      scanPublicSdkOnly(packageRoot, {
        allow: [/^(?:\.\.\/)+vitest\.shared\.js$/u],
      }).violations.map((violation) => violation.specifier),
    ).toEqual(["../../outside.js"]);
  });

  it("reports an import() or require() whose specifier it cannot read", () => {
    plant({
      "server.ts": [
        `const name = "domain";`,
        `const spec = "@sandy/" + name;`,
        `const a = await import(spec);`,
        "const b = await import(`@sandy/${name}`);",
        `const c = require(spec);`,
        `const d = await import("./literal.js");`,
        "",
      ].join("\n"),
      "literal.ts": "export const literal = 1;\n",
    });
    expect(scanPublicSdkOnly(packageRoot).violations).toEqual([
      { file: "server.ts", specifier: "spec", reason: "dynamic-specifier" },
      {
        file: "server.ts",
        specifier: "`@sandy/${name}`",
        reason: "dynamic-specifier",
      },
      { file: "server.ts", specifier: "spec", reason: "dynamic-specifier" },
    ]);
  });

  it("reads imports from syntax, not from method names, property calls, comments, strings, or JSX text", () => {
    plant({
      "server.ts": [
        "const f = { import(includeUncertain = false) { return includeUncertain; } };",
        "class Store { async require(path: string): Promise<void> {} }",
        "interface Importer { import(estimate: number): void; }",
        "f.import(estimate);",
        'f.import("@sandy/db");',
        "store?.require(path);",
        'const label = { import: "@sandy/db", export: 1 };',
        "const pattern = /from [\"']@sandy\\/db[\"']/u;",
        '// import("@sandy/db") or require(name)',
        '/* export * from "@sandy/db"; */',
        "const text = \"import('@sandy/db')\";",
        'const doc = `require(name) from "@sandy/db"`;',
        "const url = import.meta.url;",
        "",
      ].join("\n"),
      "server.test.ts": [
        'import { it } from "vitest";',
        'it("after a confirmed import", () => {});',
        'it("next test", () => {});',
        "",
      ].join("\n"),
      "app.tsx": [
        'import "@sandy-sdk/plugin-sdk/app";',
        "export function Panel<T,>(props: { items: T[] }) {",
        "  return (",
        '    <section title="don\'t import">',
        '      <p>Can\'t import (beta) from "@sandy/db" // or require(it)</p>',
        "      {props.items.length > 0 ? <List items={props.items} /> : null}",
        "      <>{/* import(name) */}</>",
        "    </section>",
        "  );",
        "}",
        "",
      ].join("\n"),
    });
    expect(scanPublicSdkOnly(packageRoot).violations).toEqual([]);
  });

  it("still reports every real import form, including ones the old text scan read", () => {
    plant({
      "server.ts": [
        'import type { Event } from "@sandy/domain";',
        'import defaultThing, { named } from "yaml";',
        'import * as ns from "@sandy/sdk";',
        'import "side-effect";',
        'import legacy = require("@sandy/legacy");',
        'export { thing } from "@sandy/reexport";',
        'export * as all from "@sandy/star";',
        'export type { Shape } from "@sandy/types";',
        'type Lazy = typeof import("@sandy/lazy-type");',
        "const lazy = cond ? import(spec) : null;",
        'const nested = `${await import("@sandy/in-template")}`;',
        'const viaRequire = [require("@sandy/required")];',
        "",
      ].join("\n"),
      "app.tsx": [
        "export const View = () => (",
        '  <div onClick={() => import("@sandy/from-jsx")}>{require(name)}</div>',
        ");",
        "",
      ].join("\n"),
    });
    const violations = scanPublicSdkOnly(packageRoot).violations;
    const reported = (file: string) =>
      violations
        .filter((violation) => violation.file === file)
        .map(({ specifier, reason }) => `${reason} ${specifier}`);
    expect(reported("app.tsx")).toEqual([
      "private-package @sandy/from-jsx",
      "dynamic-specifier name",
    ]);
    expect(reported("server.ts")).toEqual([
      "private-package @sandy/domain",
      "outside-allowlist yaml",
      "private-package @sandy/sdk",
      "outside-allowlist side-effect",
      "private-package @sandy/legacy",
      "private-package @sandy/reexport",
      "private-package @sandy/star",
      "private-package @sandy/types",
      "private-package @sandy/lazy-type",
      "dynamic-specifier spec",
      "private-package @sandy/in-template",
      "private-package @sandy/required",
    ]);
  });

  it("lists @sandy/* names from both dependency blocks of package.json", () => {
    plant(
      { "server.ts": "" },
      {
        dependencies: { "@sandy-sdk/plugin-sdk": "^0.4.0", "@sandy/domain": "*" },
        devDependencies: { vitest: "^4", "@sandy/test-helpers": "*" },
      },
    );
    expect(scanPublicSdkOnly(packageRoot).privateDependencies).toEqual([
      "@sandy/domain",
      "@sandy/test-helpers",
    ]);
  });
});
