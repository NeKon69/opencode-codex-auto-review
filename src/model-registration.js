import { Info as ModelInfo } from "@opencode/schema/model";
import { AUTO_REVIEW_MODEL, OPENAI_PROVIDER_ID } from "./review-protocol.js";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const REVIEWER_OUTPUT_LIMIT = 2_048;

export function inspectAutoReviewProvider(editor) {
  const record = editor.get(OPENAI_PROVIDER_ID);
  const directSettings = record?.settings;
  const nestedProvider = record?.provider;
  const nestedSettings = nestedProvider?.settings;
  return {
    providerRecordAvailable: Boolean(record),
    recordHasDirectSettings: Boolean(directSettings),
    recordHasDirectHeaders: Boolean(record?.headers),
    nestedProviderAvailable: Boolean(nestedProvider),
    directRouteMatches: directSettings?.baseURL === CODEX_BASE_URL && record?.headers?.originator === "opencode",
    nestedRouteMatches: nestedSettings?.baseURL === CODEX_BASE_URL && nestedProvider?.headers?.originator === "opencode",
    recordHasModels: Boolean(record?.models),
    modelsIsMap: record?.models instanceof Map,
  };
}

/** Construct a text-only model definition for the hidden Codex reviewer. */
export function createAutoReviewModel() {
  const model = ModelInfo.default(OPENAI_PROVIDER_ID, AUTO_REVIEW_MODEL);
  model.name = "Codex Auto Review";
  model.capabilities = { tools: false, input: ["text"], output: ["text"] };
  model.enabled = true;
  model.status = "active";
  model.limit = { ...model.limit, output: REVIEWER_OUTPUT_LIMIT };
  return model;
}

/** Add the reviewer only to OpenCode's already-configured native ChatGPT route. */
export function registerAutoReviewModel(editor) {
  const record = editor.get(OPENAI_PROVIDER_ID);
  const provider = record?.provider ?? record;
  if (
    !record ||
    provider?.settings?.baseURL !== CODEX_BASE_URL ||
    provider?.headers?.originator !== "opencode"
  ) return false;

  if (record.models.has(AUTO_REVIEW_MODEL)) {
    editor.models.update(OPENAI_PROVIDER_ID, AUTO_REVIEW_MODEL, (draft) => {
      draft.name ||= "Codex Auto Review";
      draft.enabled = true;
      draft.status = "active";
      draft.capabilities = { ...draft.capabilities, tools: false, input: ["text"], output: ["text"] };
    });
    return true;
  }

  editor.models.set(OPENAI_PROVIDER_ID, [...record.models.values(), createAutoReviewModel()]);
  return true;
}
