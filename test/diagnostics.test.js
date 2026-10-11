import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createReviewID, createReviewLogger, flushReviewLogs, summarizePermission, summarizeSessionContext } from "../src/diagnostics.js";

test("permission and context diagnostics expose metadata without contents", () => {
  const canary = "SYNTHETIC_PRIVATE_COMMAND_AND_PROMPT_CANARY";
  const permission = summarizePermission({
    action: "shell",
    effect: "ask",
    source: { type: "tool", id: canary },
    resources: [canary],
  });
  const context = summarizeSessionContext([
    { type: "user", text: canary, files: [], agents: [], skills: [] },
    { type: "compaction" },
  ]);

  const serialized = JSON.stringify({ permission, context });
  assert.equal(serialized.includes(canary), false);
  assert.equal(permission.resourceCount, 1);
  assert.equal(permission.resourceChars, canary.length);
  assert.equal(context.userMessageCount, 1);
  assert.equal(context.userTextChars, canary.length);
  assert.equal(context.compactionCount, 1);
});

test("review logger writes JSONL metadata without request contents", async () => {
  const canary = "SYNTHETIC_PRIVATE_COMMAND_AND_PROMPT_CANARY";
  const directory = await mkdtemp(join("/tmp/opencode", "codex-auto-review-logger-test-"));
  const filePath = join(directory, "review.ndjson");
  const reviewID = createReviewID();
  try {
    const log = createReviewLogger({ filePath });

    log("permission-hook.received", {
      reviewID,
      action: "shell",
      phase: "session.context",
      reasonCode: "permission_not_ask",
      contextFailureCode: "context_budget_exceeded",
      decisionFallback: "deny",
      resourceChars: canary.length,
      resources: [canary],
      sessionID: canary,
      prompt: canary,
      providerError: canary,
      invalidContextFailureCode: canary,
    });
    await flushReviewLogs();
    const records = (await readFile(filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

    assert.equal(records.length, 1);
    assert.equal(records[0].component, "codex-auto-review");
    assert.equal(records[0].event, "permission-hook.received");
    assert.equal(records[0].reviewID, reviewID);
    assert.equal(records[0].reasonCode, "permission_not_ask");
    assert.equal(records[0].contextFailureCode, "context_budget_exceeded");
    assert.equal(records[0].invalidContextFailureCode, undefined);
    assert.equal(records[0].decisionFallback, "deny");
    assert.equal(records[0].resourceChars, canary.length);
    assert.equal(JSON.stringify(records[0]).includes(canary), false);
  } finally {
    await flushReviewLogs();
    await rm(directory, { recursive: true, force: true });
  }
});

test("custom policy diagnostics retain scope and size but not instruction text", async () => {
  const secretRule = "SYNTHETIC_CUSTOM_POLICY_PRIVATE_CANARY";
  const directory = await mkdtemp(join("/tmp/opencode", "codex-auto-review-policy-logger-test-"));
  const filePath = join(directory, "review.ndjson");
  try {
    const log = createReviewLogger({ filePath });
    log("custom-policy.summary", {
      globalPolicyLoaded: true,
      projectPolicyLoaded: true,
      globalPolicyChars: 17,
      projectPolicyChars: 19,
      customPolicyChars: 36,
      instructions: secretRule,
    });
    await flushReviewLogs();
    const record = JSON.parse((await readFile(filePath, "utf8")).trim());

    assert.equal(record.event, "custom-policy.summary");
    assert.equal(record.globalPolicyLoaded, true);
    assert.equal(record.projectPolicyLoaded, true);
    assert.equal(record.globalPolicyChars, 17);
    assert.equal(record.projectPolicyChars, 19);
    assert.equal(record.customPolicyChars, 36);
    assert.equal(JSON.stringify(record).includes(secretRule), false);
  } finally {
    await flushReviewLogs();
    await rm(directory, { recursive: true, force: true });
  }
});
