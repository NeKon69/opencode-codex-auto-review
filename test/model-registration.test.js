import test from "node:test";
import assert from "node:assert/strict";
import { createAutoReviewModel, registerAutoReviewModel } from "../src/model-registration.js";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

test("host model templates retain unknown host fields but not model-specific request settings", () => {
  const template = {
    id: "native", modelID: "native", providerID: "openai", hostField: { versionIndependent: true },
    settings: { reasoningEffort: "max" }, headers: { "test-header": "value" }, body: { model: "native" },
    variants: [{ id: "variant" }], limit: { context: 128_000, output: 32_000 },
  };
  const original = structuredClone(template);
  const model = createAutoReviewModel(template);
  assert.deepEqual(template, original);
  assert.deepEqual(model.hostField, template.hostField);
  assert.equal(model.modelID, "codex-auto-review");
  assert.equal(model.limit.context, 128_000);
  assert.equal(model.limit.output, 2_048);
  assert.equal(model.settings, undefined);
  assert.equal(model.headers, undefined);
  assert.equal(model.body, undefined);
  assert.deepEqual(model.variants, []);
});

const providerInfo = () => ({
  id: "openai",
  name: "OpenAI",
  package: "@opencode/ai/providers/openai",
  integrationID: "openai",
  activation: "auto",
  headers: { originator: "opencode", "x-codex-beta-features": "remote_compaction_v2" },
  settings: { timeout: 45_000, transport: "http", baseURL: CODEX_BASE_URL },
});

function makeEditor(initialRecord) {
  const state = { record: initialRecord };
  return {
    state,
    get(providerID) {
      assert.equal(providerID, "openai");
      return state.record;
    },
    add({ info, models, sourceConnection }) {
      assert.equal(state.record, undefined);
      state.record = {
        provider: structuredClone(info),
        models: new Map(models.map((model) => [model.id, structuredClone(model)])),
        sourceConnection,
      };
    },
    update(providerID, update) {
      assert.equal(providerID, "openai");
      const draft = structuredClone(state.record.provider);
      update(draft);
      state.record.provider = draft;
    },
    models: {
      set(providerID, models) {
        assert.equal(providerID, "openai");
        state.record.models = new Map(models.map((model) => [model.id, structuredClone(model)]));
      },
      update(providerID, modelID, update) {
        assert.equal(providerID, "openai");
        const draft = structuredClone(state.record.models.get(modelID));
        update(draft);
        state.record.models.set(modelID, draft);
      },
    },
  };
}

test("registers the reviewer in the native ChatGPT provider without changing its route", () => {
  const originalProvider = providerInfo();
  const originalSettings = structuredClone(originalProvider.settings);
  const editor = makeEditor({ provider: originalProvider, models: new Map(), sourceConnection: undefined });
  const registered = registerAutoReviewModel(editor);

  const record = editor.state.record;
  assert.equal(registered, true);
  assert.equal(record.provider.id, "openai");
  assert.equal(record.provider.package, "@opencode/ai/providers/openai");
  assert.equal(record.provider.integrationID, "openai");
  assert.deepEqual(record.provider.headers, originalProvider.headers);
  assert.deepEqual(record.provider.settings, originalSettings);

  const model = record.models.get("codex-auto-review");
  assert.ok(model);
  assert.equal(model.providerID, "openai");
  assert.equal(model.modelID, "codex-auto-review");
  assert.equal(model.enabled, true);
  assert.equal(model.capabilities.tools, false);
  assert.deepEqual(model.capabilities.input, ["text"]);
  assert.deepEqual(model.capabilities.output, ["text"]);
});

test("does not synthesize a provider when the native OpenAI provider is absent", () => {
  const editor = makeEditor(undefined);
  let added = false;
  editor.add = () => { added = true; };

  assert.equal(registerAutoReviewModel(editor), false);
  assert.equal(added, false);
  assert.equal(editor.state.record, undefined);
});

test("does not register the reviewer on a generic OpenAI API route", () => {
  const provider = providerInfo();
  provider.settings = { ...provider.settings, baseURL: "https://api.openai.com/v1" };
  provider.headers = {};
  const editor = makeEditor({ provider, models: new Map(), sourceConnection: undefined });

  assert.equal(registerAutoReviewModel(editor), false);
  assert.equal(editor.state.record.models.size, 0);
});

test("preserves OpenAI provider models and re-enables an existing hidden reviewer entry", () => {
  const hidden = {
    id: "codex-auto-review",
    modelID: "codex-auto-review",
    providerID: "openai",
    name: "Codex Auto Review",
    enabled: false,
    status: "beta",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    marker: "catalog-entry-preserved",
  };
  const other = { id: "gpt-example", modelID: "gpt-example", providerID: "openai", name: "Existing" };
  const editor = makeEditor({
    provider: providerInfo(),
    models: new Map([[hidden.id, hidden], [other.id, other]]),
    sourceConnection: undefined,
  });

  assert.equal(registerAutoReviewModel(editor), true);

  const record = editor.state.record;
  assert.equal(record.models.size, 2);
  assert.equal(record.models.get("gpt-example").name, "Existing");
  assert.equal(record.models.get("codex-auto-review").enabled, true);
  assert.equal(record.models.get("codex-auto-review").status, "active");
  assert.equal(record.models.get("codex-auto-review").marker, "catalog-entry-preserved");
  assert.equal(record.models.get("codex-auto-review").capabilities.tools, false);
  assert.equal(record.provider.settings.timeout, 45_000);
  assert.equal(record.provider.settings.transport, "http");
  assert.equal(record.provider.settings.baseURL, CODEX_BASE_URL);
});
