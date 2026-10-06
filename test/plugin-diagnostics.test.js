import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { flushReviewLogs } from "../src/diagnostics.js";
import plugin from "../src/index.js";

test("permission hook logs decisions, phase timings, and overlap without logging request values", async () => {
  const previousLogPath = process.env.OPENCODE_CODEX_AUTO_REVIEW_LOG;
  const directory = await mkdtemp(join("/tmp/opencode", "codex-auto-review-hook-test-"));
  const logPath = join(directory, "review.ndjson");
  process.env.OPENCODE_CODEX_AUTO_REVIEW_LOG = logPath;
  let permissionHook;
  const ctx = {
    permission: {
      hook: async (name, callback) => {
        assert.equal(name, "evaluate");
        permissionHook = callback;
        return { dispose: async () => {} };
      },
    },
    session: {
      context: async () => [{ type: "user", text: "Please inspect the directory." }],
    },
    integration: {
      connection: {
        active: async () => undefined,
        resolve: async () => undefined,
      },
    },
  };
  try {
    const cleanup = await plugin.setup(ctx);
    const resourceCanary = "SYNTHETIC_PRIVATE_COMMAND_CANARY";
    const sessionCanary = "SYNTHETIC_SESSION_ID_CANARY";
    const requests = [0, 1].map(() => ({
      sessionID: sessionCanary,
      action: "shell",
      resources: [resourceCanary],
      source: { type: "tool", id: "tool-canary" },
      effect: "ask",
    }));

    await Promise.all(requests.map((request) => permissionHook(request)));
    await cleanup();
    await flushReviewLogs();

    const records = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const events = records.map((record) => record.event);
    assert.equal(events.filter((event) => event === "permission-hook.received").length, 2);
    assert.equal(events.filter((event) => event === "review.started").length, 2);
    assert.equal(events.filter((event) => event === "phase.started").length >= 4, true);
    assert.equal(events.filter((event) => event === "decision.manual").length, 2);
    assert.equal(events.filter((event) => event === "permission-hook.completed").length, 2);
    assert.equal(records.some((record) => record.inFlightBefore === 1), true);
    assert.equal(records.some((record) => record.phase === "session.context" && typeof record.durationMs === "number"), true);
    assert.equal(requests.every((request) => request.effect === "ask"), true);
    assert.equal(JSON.stringify(records).includes(resourceCanary), false);
    assert.equal(JSON.stringify(records).includes(sessionCanary), false);
  } finally {
    await flushReviewLogs();
    if (previousLogPath === undefined) delete process.env.OPENCODE_CODEX_AUTO_REVIEW_LOG;
    else process.env.OPENCODE_CODEX_AUTO_REVIEW_LOG = previousLogPath;
    await rm(directory, { recursive: true, force: true });
  }
});
