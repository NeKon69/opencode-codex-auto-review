import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { flushReviewLogs } from "../src/diagnostics.js";
import plugin from "../src/index.js";

test("registers only against the existing native Codex route and leaves provider settings unchanged", async () => {
  const previousLogPath = process.env.OPENCODE_CODEX_AUTO_REVIEW_LOG;
  const directory = await mkdtemp(join("/tmp/opencode", "codex-auto-review-startup-test-"));
  const logPath = join(directory, "review.ndjson");
  process.env.OPENCODE_CODEX_AUTO_REVIEW_LOG = logPath;

  const provider = {
    id: "openai",
    package: "@opencode/ai/providers/openai",
    integrationID: "openai",
    headers: { originator: "opencode" },
    settings: { baseURL: "https://chatgpt.com/backend-api/codex", timeout: 45_000, transport: "http" },
  };
  const originalProvider = structuredClone(provider);
  const providerRecord = { provider, models: new Map() };
  const connection = { type: "credential", id: "chatgpt-test", label: "ChatGPT", method: "oauth" };
  let providerTransform;
  let modelTransform;
  let disposed = 0;
  const ctx = {
    options: { mode: "permissive", fallback: "deny" },
    permission: {
      hook: async () => ({ dispose: async () => { disposed++; } }),
    },
    integration: {
      connection: {
        active: async () => connection,
        resolve: async () => ({
          type: "oauth",
          methodID: "chatgpt-browser",
          access: "synthetic-test-token",
          expires: Date.now() + 60_000,
        }),
      },
    },
    provider: {
      transform: async (callback) => {
        providerTransform = callback;
        return { dispose: async () => { disposed++; } };
      },
      reload: async () => {},
    },
    model: {
      transform: async (callback) => {
        modelTransform = callback;
        return { dispose: async () => { disposed++; } };
      },
      reload: async () => {},
    },
  };

  try {
    const cleanup = await plugin.setup(ctx);
    assert.equal(providerRecord.models.has("codex-auto-review"), false);
    assert.equal(typeof modelTransform, "function");

    providerTransform({
      get: (providerID) => providerID === "openai" ? providerRecord : undefined,
      models: {
        set: (providerID, models) => {
          assert.equal(providerID, "openai");
          providerRecord.models = new Map(models.map((model) => [model.id, model]));
        },
        update: (providerID, modelID, update) => {
          assert.equal(providerID, "openai");
          const model = { ...providerRecord.models.get(modelID) };
          update(model);
          providerRecord.models.set(modelID, model);
        },
      },
    });
    modelTransform({
      get: (providerID, modelID) => providerID === "openai" ? providerRecord.models.get(modelID) : undefined,
      update: (providerID, modelID, update) => {
        assert.equal(providerID, "openai");
        const model = { ...providerRecord.models.get(modelID) };
        update(model);
        providerRecord.models.set(modelID, model);
      },
    });

    const model = providerRecord.models.get("codex-auto-review");
    assert.ok(model);
    assert.equal(model.enabled, true);
    assert.equal(model.capabilities.tools, false);
    assert.deepEqual(providerRecord.provider, originalProvider);

    await cleanup();
    await flushReviewLogs();
    const records = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.some((record) => record.event === "reviewer-model.setup.completed" && record.transformRegistered && record.routeCheckPending), true);
    assert.equal(records.some((record) => record.event === "provider.registration.completed" && record.registered), true);
    assert.equal(records.some((record) => record.event === "plugin.setup.started" && record.approvalMode === "permissive" && record.decisionFallback === "deny"), true);
    assert.equal(disposed, 3);
    assert.equal(JSON.stringify(records).includes("synthetic-test-token"), false);
  } finally {
    await flushReviewLogs();
    if (previousLogPath === undefined) delete process.env.OPENCODE_CODEX_AUTO_REVIEW_LOG;
    else process.env.OPENCODE_CODEX_AUTO_REVIEW_LOG = previousLogPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("deny fallback declines unreviewable tool asks but leaves non-tool asks untouched", async () => {
  const previousFallback = process.env.OPENCODE_CODEX_AUTO_REVIEW_FALLBACK;
  const previousLogPath = process.env.OPENCODE_CODEX_AUTO_REVIEW_LOG;
  const directory = await mkdtemp(join("/tmp/opencode", "codex-auto-review-fallback-test-"));
  process.env.OPENCODE_CODEX_AUTO_REVIEW_FALLBACK = "deny";
  process.env.OPENCODE_CODEX_AUTO_REVIEW_LOG = join(directory, "review.ndjson");
  let evaluateHook;
  const ctx = {
    permission: {
      hook: async (name, callback) => {
        assert.equal(name, "evaluate");
        evaluateHook = callback;
        return { dispose: async () => {} };
      },
    },
    integration: { connection: { active: async () => undefined } },
  };

  try {
    const cleanup = await plugin.setup(ctx);
    const unsupportedToolAsk = {
      effect: "ask",
      action: "shell",
      resources: [],
      source: { type: "tool" },
    };
    const nonToolAsk = {
      effect: "ask",
      action: "shell",
      resources: [],
      source: { type: "other" },
    };
    await evaluateHook(unsupportedToolAsk);
    await evaluateHook(nonToolAsk);

    assert.equal(unsupportedToolAsk.effect, "deny");
    assert.equal(nonToolAsk.effect, "ask");
    await cleanup();
  } finally {
    await flushReviewLogs();
    if (previousFallback === undefined) delete process.env.OPENCODE_CODEX_AUTO_REVIEW_FALLBACK;
    else process.env.OPENCODE_CODEX_AUTO_REVIEW_FALLBACK = previousFallback;
    if (previousLogPath === undefined) delete process.env.OPENCODE_CODEX_AUTO_REVIEW_LOG;
    else process.env.OPENCODE_CODEX_AUTO_REVIEW_LOG = previousLogPath;
    await rm(directory, { recursive: true, force: true });
  }
});
