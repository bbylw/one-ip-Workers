import { adaptNavigator } from "./browser-diagnostics-adapter.mjs";
import { createHash } from "node:crypto";
import { readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { rollup } from "rollup";
import { transformSync } from "esbuild";

// TypeScript 7 is the native compiler and exports no stable JavaScript API, so
// this transform step uses esbuild instead. `const enum` is the one construct
// where the two could disagree in single-file mode; both keep it as a runtime
// object, which is what these vendor sources need.
//
// The committed public/browser-diagnostics.js was still produced by the
// TypeScript 6 emit, so the first run of this script rewrites most of that file
// (quote style, indentation, dropped comments, `/* @__PURE__ */` markers). That
// makes the rebuild its own change to review rather than part of a dependency
// bump: tests/deep-diagnostics.test.mjs pins the bundle hash, and the bundle
// feeds the browser fingerprint results.
const bundle = await rollup({
  input: "vendor/browser-diagnostics/entry.ts",
  plugins: [
    {
      name: "local-typescript",
      async resolveId(source, importer) {
        if (!importer || !source.startsWith(".")) return null;
        const base = resolve(dirname(importer), source);
        for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
          if (
            await stat(candidate).then(
              () => true,
              () => false,
            )
          )
            return candidate;
        }
        return null;
      },
      transform(code, id) {
        if (!id.endsWith(".ts")) return null;
        if (id === resolve("vendor/browser-diagnostics/upstream/navigator/index.ts")) code = adaptNavigator(code);
        return {
          code: transformSync(code, {
            loader: "ts",
            format: "esm",
            target: "es2020",
          }).code,
          map: null,
        };
      },
    },
  ],
});
const { output } = await bundle.generate({
  format: "iife",
  banner:
    "/*! Based on CreepJS (MIT), Copyright (c) 2021 abrahamjuliot. License: /browser-diagnostics.LICENSE.txt */",
});
await bundle.close();
const code = output[0].code;
await writeFile("public/browser-diagnostics.js", code);
await copyFile(
  "vendor/browser-diagnostics/LICENSE",
  "public/browser-diagnostics.LICENSE.txt",
);
const upstream = JSON.parse(
  await readFile("vendor/browser-diagnostics/upstream.json", "utf8"),
);
await writeFile(
  "src/views/browser/diagnostics-version.json",
  JSON.stringify(
    {
      commit: upstream.commit,
      bundleHash: createHash("sha256").update(code).digest("hex"),
    },
    null,
    2,
  ) + "\n",
);
