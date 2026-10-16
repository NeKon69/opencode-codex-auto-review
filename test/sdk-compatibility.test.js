import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("has no runtime dependency on version-specific OpenCode schemas", () => {
  assert.equal(packageJson.dependencies?.["@opencode/schema"], undefined);
  assert.equal(packageJson.dependencies?.["@opencode/plugin"], undefined);
  assert.equal(packageJson.devDependencies["@opencode/schema"], "*");
  assert.match(packageJson.scripts.check, /src\/diagnostics\.js/);
  assert.match(packageJson.scripts.check, /src\/semaphore\.js/);
});
