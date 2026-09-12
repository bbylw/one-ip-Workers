import { transformSync } from "esbuild";
import { Buffer } from "node:buffer";

/**
 * TypeScript 7 is the native compiler and deliberately ships without a stable
 * JavaScript API (the programmatic API returns in 7.1), so the test suite can no
 * longer reach for `ts.transpileModule` the way it did under TypeScript 6.
 *
 * These helpers cover the two things the tests actually needed it for:
 *
 * - `esmCode` / `esmUrl` — load an app module in Node by transpiling it first,
 *   which lets a test rewrite an import specifier before evaluating it.
 * - `commonjs` — run a component under a hand-written `require` shim, which is
 *   how several tests render one view without a DOM.
 *
 * esbuild replaces the compiler here because it strips TypeScript and JSX with no
 * configuration, and the project's `erasableSyntaxOnly` setting already guarantees
 * nothing needs type-directed emit.
 */

const DEFAULT_TARGET = "es2022";

function transform(
  source,
  { tsx = false, format, target = DEFAULT_TARGET } = {},
) {
  return transformSync(source, {
    loader: tsx ? "tsx" : "ts",
    format,
    target,
    // Matches the `jsx: "react-jsx"` in tsconfig.app.json.
    jsx: "automatic",
  }).code;
}

/** Transpiled ES module text, ready to evaluate or inspect. */
export function esmCode(source, options) {
  return transform(source, { ...options, format: "esm" });
}

/**
 * Transpiled ES module text with its export clause removed, for tests that wrap
 * the body in `new Function` and pick the entry point themselves. esbuild appends
 * the clause last, so everything before it is plain statements.
 */
export function esmBody(source, options) {
  const code = esmCode(source, options);
  const start = code.lastIndexOf("\nexport {");
  return start === -1 ? code : code.slice(0, start);
}

/** `data:` URL of the transpiled module, for `await import(...)`. */
export function esmUrl(source, options) {
  const encoded = Buffer.from(esmCode(source, options)).toString("base64");
  return `data:text/javascript;base64,${encoded}`;
}

/**
 * Evaluate the module as CommonJS with a synthetic module scope and return its
 * exports. Unlike the TypeScript 6 emit these tests were written against, which
 * assigned onto a shared `exports`, esbuild replaces `module.exports` wholesale —
 * hence the fresh module object per call.
 */
export function commonjs(source, require, options) {
  const code = transform(source, { ...options, format: "cjs" });
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(
    require,
    module,
    module.exports,
  );
  return module.exports;
}
