import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../src/index.js";

test("exports a valid V2 server plugin definition", () => {
  assert.equal(plugin.id, "opencode-codex-auto-review");
  assert.equal(typeof plugin.setup, "function");
});
