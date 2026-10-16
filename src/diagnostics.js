import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

let writeQueue = Promise.resolve();

export function createReviewID() {
  return randomUUID();
}

export function createReviewLogger(options = {}) {
  const logPath = Object.hasOwn(options, "filePath")
    ? options.filePath
    : process.env.OPENCODE_CODEX_AUTO_REVIEW_LOG ??
        join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "log", "codex-auto-review.ndjson");

  return (event, fields = {}) => {
    try {
      const record = createRecord(event, fields);
      writeFileRecord(record, logPath);
    } catch {
      // Logging must never change permission behavior.
    }
  };
}

export async function flushReviewLogs() {
  await writeQueue;
}

function createRecord(event, fields) {
  return {
    timestamp: new Date().toISOString(),
    component: "codex-auto-review",
    event: typeof event === "string" && /^[A-Za-z0-9._:-]{1,96}$/.test(event) ? event : "invalid-event",
    ...sanitizeFields(fields),
  };
}

const SAFE_STRING_FIELDS = new Set([
  "reviewID",
  "action",
  "effect",
  "sourceType",
  "finalEffect",
  "phase",
  "reasonCode",
  "contextFailureCode",
  "errorName",
  "name",
  "riskLevel",
  "authorization",
  "requestedOutcome",
  "appliedDecision",
  "approvalMode",
  "decisionFallback",
]);

const SAFE_STRING_VALUES = {
  effect: new Set(["ask", "allow", "deny", "other", "unknown"]),
  sourceType: new Set(["tool", "other", "unknown"]),
  finalEffect: new Set(["ask", "allow", "deny", "other", "unknown"]),
  name: new Set(["evaluate"]),
  riskLevel: new Set(["low", "medium", "high", "critical"]),
  authorization: new Set(["unknown", "low", "medium", "high"]),
  requestedOutcome: new Set(["allow", "deny", "ask"]),
  appliedDecision: new Set(["allow", "deny", "ask"]),
  approvalMode: new Set(["manual", "strict", "cautious", "balanced", "permissive"]),
  decisionFallback: new Set(["ask", "deny"]),
  reasonCode: new Set([
    "assessment_invalid",
    "assessment_uncertain",
    "cancelled",
    "connection_changed",
    "connection_missing",
    "connection_inactive",
    "context_compacted",
    "context_incomplete",
    "credential_ineligible",
    "invalid_permission_request",
    "native_codex_route_missing",
    "permission_not_ask",
    "policy_unavailable",
    "plugin_disposed",
    "review_failed",
    "source_not_tool",
    "timeout",
  ]),
  phase: new Set([
    "assessment.classify",
    "assessment.parse",
    "connection.active",
    "context.validation",
    "integration.connection.active",
    "integration.connection.recheck",
    "integration.connection.resolve",
    "model.reload",
    "model.transform",
    "prompt.build",
    "policy.load",
    "provider.reload",
    "provider.transform",
    "review.queue.acquire",
    "reviewer.generate",
    "session.context",
    "session.user-messages",
  ]),
  contextFailureCode: new Set([
    "context_budget_exceeded",
    "invalid_compaction",
    "missing_user_context",
    "session_context_unavailable",
    "too_many_user_messages",
    "unsupported_context",
  ]),
};

const SAFE_BOOLEAN_FIELDS = new Set([
  "eligible",
  "providerRecordAvailable",
  "recordHasDirectSettings",
  "recordHasDirectHeaders",
  "nestedProviderAvailable",
  "directRouteMatches",
  "nestedRouteMatches",
  "recordHasModels",
  "modelsIsMap",
  "connectionAvailable",
  "credentialAvailable",
  "registered",
  "transformRegistered",
  "routeCheckPending",
  "responsePresent",
  "truncated",
  "compacted",
  "hasCompactionSummary",
  "globalPolicyLoaded",
  "projectPolicyLoaded",
  "timedOut",
  "externallyAborted",
  "connectionStable",
]);

const SAFE_NUMBER_FIELDS = new Set([
  "durationMs",
  "activePhaseCount",
  "preparationDurationMs",
  "queueWaitMs",
  "timeoutMs",
  "inFlight",
  "inFlightBefore",
  "activeReviews",
  "queuedReviews",
  "transforms",
  "resourceCount",
  "resourceChars",
  "resourceBytes",
  "messageCount",
  "userMessageCount",
  "userTextChars",
  "compactionCount",
  "userMessagesWithFiles",
  "userMessagesWithAgents",
  "userMessagesWithSkills",
  "acceptedUserMessageCount",
  "acceptedTextChars",
  "compactionSummaryChars",
  "globalPolicyChars",
  "projectPolicyChars",
  "customPolicyChars",
  "promptBytes",
  "responseChars",
  "responseBytes",
]);

function sanitizeFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return {};
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SAFE_STRING_FIELDS.has(key)) {
      if (typeof value !== "string" || value.length > 96) continue;
      if (key === "reviewID" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
        safe[key] = value;
      } else if (key === "action" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value)) {
        safe[key] = value;
      } else if (key === "errorName" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)) {
        safe[key] = value;
      } else if (SAFE_STRING_VALUES[key]?.has(value)) {
        safe[key] = value;
      }
      continue;
    }
    if (SAFE_BOOLEAN_FIELDS.has(key)) {
      if (typeof value === "boolean") safe[key] = value;
      continue;
    }
    if (SAFE_NUMBER_FIELDS.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) {
      safe[key] = Math.round(value);
    }
  }
  return safe;
}

function writeFileRecord(record, filePath) {
  if (!filePath) return;
  const line = `${JSON.stringify(record)}\n`;
  writeQueue = writeQueue.then(async () => {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
  }).catch(() => {
    // A filesystem/logging issue must never affect permission behavior.
  });
}

export function elapsedMs(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

export function safeErrorName(error) {
  const name = typeof error?.name === "string" ? error.name : "Error";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : "Error";
}

export function summarizePermission(event) {
  const resources = Array.isArray(event?.resources) ? event.resources : [];
  return {
    action: safeLabel(event?.action),
    effect: safeLabel(event?.effect),
    sourceType: safeLabel(event?.source?.type),
    resourceCount: resources.length,
    resourceChars: resources.reduce((total, item) => total + (typeof item === "string" ? item.length : 0), 0),
  };
}

export function summarizeSessionContext(messages) {
  if (!Array.isArray(messages)) {
    return { isArray: false, messageCount: 0, userMessageCount: 0, userTextChars: 0, compactionCount: 0 };
  }

  let userMessageCount = 0;
  let userTextChars = 0;
  let compactionCount = 0;
  let userMessagesWithFiles = 0;
  let userMessagesWithAgents = 0;
  let userMessagesWithSkills = 0;
  for (const message of messages) {
    if (message?.type === "compaction") compactionCount += 1;
    if (message?.type !== "user") continue;
    userMessageCount += 1;
    if (typeof message.text === "string") userTextChars += message.text.length;
    if (Array.isArray(message.files) && message.files.length > 0) userMessagesWithFiles += 1;
    if (Array.isArray(message.agents) && message.agents.length > 0) userMessagesWithAgents += 1;
    if (Array.isArray(message.skills) && message.skills.length > 0) userMessagesWithSkills += 1;
  }

  return {
    isArray: true,
    messageCount: messages.length,
    userMessageCount,
    userTextChars,
    compactionCount,
    userMessagesWithFiles,
    userMessagesWithAgents,
    userMessagesWithSkills,
  };
}

function safeLabel(value) {
  if (typeof value !== "string") return "unknown";
  const label = value.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64);
  return label || "other";
}
