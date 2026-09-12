import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { commonjs } from "./transpile.mjs";
import { t } from "../src/i18n/index.ts";

test("home platform summary initializes its featured services when imported", () => {
  const source = readFileSync("src/views/home/platform-summary.tsx", "utf8");
  const services = JSON.parse(
    readFileSync("src/views/status/services.json", "utf8"),
  );
  const require = (name) => {
    if (name === "@/views/status/services.json") return services;
    if (name === "@/i18n") return { t };
    return {};
  };
  const exports = commonjs(source, require, { tsx: true });
  assert.equal(typeof exports.PlatformSummary, "function");
});
