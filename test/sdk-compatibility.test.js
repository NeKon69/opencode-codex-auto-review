import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("declares the OpenCode V2 schema compatibility range from 2.0.24", () => {
  assert.equal(packageJson.dependencies["@opencode/schema"], "~2.0.24");
  assert.equal(packageJson.dependencies["@opencode/plugin"], undefined);
  assert.match(packageJson.scripts.check, /src\/diagnostics\.js/);
  assert.match(packageJson.scripts.check, /src\/semaphore\.js/);
});
