import {
  AUTO_REVIEW_MODEL,
  OPENAI_PROVIDER_ID,
  applyReviewFallback,
  buildReviewPrompt,
  classifyAssessment,
  extractUserContext,
  parseAssessment,
  resolveApprovalMode,
  resolveReviewFallback,
  shouldReviewPermission,
} from "./review-protocol.js";
import { createSemaphore } from "./semaphore.js";
import {
  createReviewID,
  elapsedMs,
  safeErrorName,
  summarizeSessionContext,
} from "./diagnostics.js";

const CHATGPT_METHOD_IDS = new Set(["chatgpt-browser", "chatgpt-headless"]);
const DEFAULT_TIMEOUT_MS = 30_000;
const TOKEN_EXPIRY_MARGIN_MS = 5_000;
const MIN_TOKEN_LIFETIME_MS = DEFAULT_TIMEOUT_MS + TOKEN_EXPIRY_MARGIN_MS;
export const MAX_PARALLEL_REVIEWS = 5;
const reviewSemaphore = createSemaphore(MAX_PARALLEL_REVIEWS);

function sameCredentialConnection(left, right) {
  return left?.type === "credential" && right?.type === "credential" &&
    typeof left.id === "string" && left.id === right.id &&
    typeof left.method === "string" && left.method === right.method;
}

export function isEligibleChatGPTCredential(credential, now = Date.now()) {
  return credential?.type === "oauth" && CHATGPT_METHOD_IDS.has(credential.methodID) &&
    typeof credential.access === "string" && credential.access.length > 0 &&
    typeof credential.expires === "number" && credential.expires > now + MIN_TOKEN_LIFETIME_MS;
}

/**
 * Review one pending OpenCode permission event. Only ChatGPT-plan OAuth may be
 * used. The default fallback leaves unresolved requests at `ask`; `deny` mode
 * denies plugin-side failures while keeping OpenAI reviewer failures at `ask`.
 */
export async function reviewPermission(ctx, event, options = {}) {
  const reviewID = options.reviewID ?? createReviewID();
  const startedAt = options.startedAt ?? performance.now();
  const log = options.log ?? (() => {});
  const approvalMode = resolveApprovalMode(options.mode ?? process.env.OPENCODE_CODEX_AUTO_REVIEW_MODE);
  const decisionFallback = resolveReviewFallback(options.fallback ?? process.env.OPENCODE_CODEX_AUTO_REVIEW_FALLBACK);
  if (!shouldReviewPermission(event)) {
    applyUnreviewedToolFallback(event, { fallback: decisionFallback, reviewID, startedAt, log });
    log("review.skipped", { reviewID, reasonCode: "invalid_permission_request" });
    return;
  }

  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const externalSignal = options.signal;
  let currentPhase = "initializing";
  const activePhases = new Set();
  let timedOut = false;
  let releaseSlot;
  const abortFromExternal = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    log("review.timeout", {
      reviewID,
      phase: currentPhase,
      activePhaseCount: activePhases.size,
      timeoutMs,
    });
    controller.abort();
  }, timeoutMs);

  const runPhase = async (phase, operation) => {
    currentPhase = phase;
    activePhases.add(phase);
    const phaseStartedAt = performance.now();
    log("phase.started", { reviewID, phase });
    try {
      const result = await operation();
      log("phase.completed", { reviewID, phase, durationMs: elapsedMs(phaseStartedAt) });
      return result;
    } catch (error) {
      log("phase.failed", {
        reviewID,
        phase,
        durationMs: elapsedMs(phaseStartedAt),
        errorName: safeErrorName(error),
      });
      throw error;
    } finally {
      activePhases.delete(phase);
    }
  };

  log("review.started", { reviewID, timeoutMs, approvalMode, decisionFallback });

  try {
    const resourceBytes = Buffer.byteLength(JSON.stringify(event.resources), "utf8");
    log("review.request.summary", {
      reviewID,
      resourceCount: event.resources.length,
      resourceBytes,
    });

    const queueStartedAt = performance.now();
    if (reviewSemaphore.activeCount >= MAX_PARALLEL_REVIEWS) {
      log("review.queue.waiting", {
        reviewID,
        activeReviews: reviewSemaphore.activeCount,
        queuedReviews: reviewSemaphore.queuedCount + 1,
      });
    }
    releaseSlot = await runPhase("review.queue.acquire", () => reviewSemaphore.acquire(controller.signal));
    log("review.queue.acquired", {
      reviewID,
      queueWaitMs: elapsedMs(queueStartedAt),
      activeReviews: reviewSemaphore.activeCount,
      queuedReviews: reviewSemaphore.queuedCount,
    });

    const [session, connection] = await Promise.all([
      runPhase("session.context", () => raceWithAbort(
        Promise.resolve().then(() => ctx.session.context(
          { sessionID: event.sessionID },
          { signal: controller.signal },
        )),
        controller.signal,
      )),
      runPhase("integration.connection.active", () => raceWithAbort(
        Promise.resolve().then(() => ctx.integration.connection.active(OPENAI_PROVIDER_ID)),
        controller.signal,
      )),
    ]);
    log("session.context.summary", {
      reviewID,
      ...summarizeSessionContext(session),
    });
    log("integration.connection.summary", { reviewID, connectionAvailable: Boolean(connection) });

    const authorization = await runPhase("context.validation", () => extractUserContext(session));
    log("context.validation.summary", {
      reviewID,
      acceptedUserMessageCount: authorization.messages.length,
      acceptedTextChars: authorization.messages.reduce((total, text) => total + text.length, 0),
      hasCompactionSummary: Boolean(authorization.compactionSummary),
      compactionSummaryChars: authorization.compactionSummary
        ? authorization.compactionSummary.summary.length + authorization.compactionSummary.recent.length
        : 0,
      truncated: authorization.truncated,
      compacted: authorization.compacted,
    });
    if (authorization.truncated ||
        (authorization.messages.length === 0 && !authorization.compactionSummary)) {
      handleUnresolvedPermission(event, "context_incomplete", reviewID, startedAt, undefined, log, undefined, decisionFallback, currentPhase);
      return;
    }

    if (!connection) {
      handleUnresolvedPermission(event, "connection_inactive", reviewID, startedAt, undefined, log, undefined, decisionFallback, currentPhase);
      return;
    }

    const promptStartedAt = performance.now();
    const [prompt, credential] = await Promise.all([
      runPhase("prompt.build", () => buildReviewPrompt({
        action: event.action,
        resources: event.resources,
        userInstructions: authorization.messages,
        compactionSummary: authorization.compactionSummary,
        approvalMode,
      })),
      runPhase("integration.connection.resolve", () => raceWithAbort(
        Promise.resolve().then(() => ctx.integration.connection.resolve(connection)),
        controller.signal,
      )),
    ]);
    log("review.request.prepared", {
      reviewID,
      preparationDurationMs: elapsedMs(promptStartedAt),
      promptBytes: Buffer.byteLength(prompt, "utf8"),
    });
    const credentialEligible = isEligibleChatGPTCredential(credential, now());
    log("oauth.eligibility.checked", {
      reviewID,
      credentialAvailable: Boolean(credential),
      credentialEligible,
    });
    if (!credentialEligible) {
      handleUnresolvedPermission(event, "credential_ineligible", reviewID, startedAt, undefined, log, undefined, decisionFallback, currentPhase);
      return;
    }

    const connectionCheckStartedAt = performance.now();
    const currentConnection = await runPhase("integration.connection.recheck", () => raceWithAbort(
      Promise.resolve().then(() => ctx.integration.connection.active(OPENAI_PROVIDER_ID)),
      controller.signal,
    ));
    const connectionStable = sameCredentialConnection(connection, currentConnection);
    log("integration.connection.recheck.summary", {
      reviewID,
      connectionStable,
      durationMs: elapsedMs(connectionCheckStartedAt),
    });
    if (!connectionStable) {
      handleUnresolvedPermission(event, "connection_changed", reviewID, startedAt, undefined, log, undefined, decisionFallback, currentPhase);
      return;
    }

    const promptBytes = Buffer.byteLength(prompt, "utf8");
    const input = {
      prompt,
      model: { id: AUTO_REVIEW_MODEL, providerID: OPENAI_PROVIDER_ID },
    };
    const generate = options.generateImpl ?? ((value, requestOptions) => ctx.generate.text(value, requestOptions));
    const response = await runPhase("reviewer.generate", () => raceWithAbort(
      Promise.resolve().then(() => generate(input, { signal: controller.signal })),
      controller.signal,
    ));
    log("reviewer.response.summary", {
      reviewID,
      promptBytes,
      responseChars: typeof response?.text === "string" ? response.text.length : 0,
      responseBytes: typeof response?.text === "string" ? Buffer.byteLength(response.text, "utf8") : 0,
      responsePresent: typeof response?.text === "string",
    });

    const assessment = await runPhase("assessment.parse", () => parseAssessment(response?.text));
    if (!assessment) {
      handleUnresolvedPermission(event, "assessment_invalid", reviewID, startedAt, undefined, log, undefined, decisionFallback, currentPhase);
      return;
    }

    const decision = await runPhase("assessment.classify", () => classifyAssessment(assessment, {
      mode: approvalMode,
      hasDirectUserMessages: authorization.messages.length > 0,
      hasCompactionSummary: Boolean(authorization.compactionSummary),
    }));
    log("assessment.summary", {
      reviewID,
      riskLevel: assessment.risk_level,
      authorization: assessment.user_authorization,
      requestedOutcome: assessment.outcome,
      approvalMode,
      decisionFallback,
      appliedDecision: decision,
    });
    if (decision === "allow") {
      event.effect = "allow";
      event.message = `Codex Auto Review allowed this action under the ${approvalMode} profile.`;
      log("decision.applied", { reviewID, effect: "allow", approvalMode, decisionFallback, durationMs: elapsedMs(startedAt) });
      return;
    }
    if (decision === "deny") {
      event.effect = "deny";
      event.message = "Codex Auto Review denied this request based on its structured assessment.";
      log("decision.applied", { reviewID, effect: "deny", approvalMode, decisionFallback, durationMs: elapsedMs(startedAt) });
      return;
    }
    handleUnresolvedPermission(event, "assessment_uncertain", reviewID, startedAt, assessment.risk_level, log, approvalMode, decisionFallback, currentPhase);
  } catch (error) {
    // Do not log provider messages, stack traces, prompts, resource values, or credentials.
    log("review.failed", {
      reviewID,
      phase: currentPhase,
      errorName: safeErrorName(error),
      timedOut,
      externallyAborted: Boolean(externalSignal?.aborted),
      durationMs: elapsedMs(startedAt),
    });
    const failureCode = timedOut
      ? "timeout"
      : externalSignal?.aborted
        ? "cancelled"
        : "review_failed";
    if (!controller.signal.aborted) controller.abort();
    handleUnresolvedPermission(event, failureCode, reviewID, startedAt, undefined, log, undefined, decisionFallback, currentPhase);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternal);
    releaseSlot?.();
    log("review.finished", {
      reviewID,
      finalEffect: event.effect,
      timedOut,
      durationMs: elapsedMs(startedAt),
    });
  }
}

export function applyUnreviewedToolFallback(event, options = {}) {
  if (event?.effect !== "ask" || event?.source?.type !== "tool") return false;
  const decisionFallback = resolveReviewFallback(
    options.fallback ?? process.env.OPENCODE_CODEX_AUTO_REVIEW_FALLBACK,
  );
  return applyDenyFallback(
    event,
    "invalid_permission_request",
    undefined,
    options.reviewID,
    options.startedAt ?? performance.now(),
    decisionFallback,
    options.log ?? (() => {}),
  );
}

function applyDenyFallback(event, reasonCode, phase, reviewID, startedAt, decisionFallback, log) {
  const decision = applyReviewFallback("ask", { fallback: decisionFallback, reasonCode, phase });
  if (decision !== "deny" || event?.effect !== "ask" || event?.source?.type !== "tool") return false;
  event.effect = "deny";
  event.message = "Codex Auto Review denied this tool request under the deny fallback because it could not safely approve it.";
  log("decision.applied", {
    reviewID,
    effect: "deny",
    reasonCode,
    decisionFallback,
    durationMs: elapsedMs(startedAt),
  });
  return true;
}

function handleUnresolvedPermission(event, reasonCode, reviewID, startedAt, riskLevel, log, approvalMode, decisionFallback, phase) {
  if (applyDenyFallback(event, reasonCode, phase, reviewID, startedAt, decisionFallback, log)) return;
  let reasonText;
  switch (reasonCode) {
    case "context_compacted":
      reasonText = "the session has a compaction checkpoint and earlier authorization may be missing";
      break;
    case "context_incomplete":
      reasonText = "the complete user-authored context is unavailable";
      break;
    case "connection_inactive":
      reasonText = "the OpenAI ChatGPT connection is not active";
      break;
    case "connection_changed":
      reasonText = "the active OpenAI connection changed during review";
      break;
    case "credential_ineligible":
      reasonText = "a valid ChatGPT-plan OAuth credential is unavailable";
      break;
    case "assessment_invalid":
      reasonText = "the reviewer did not return a complete valid assessment";
      break;
    case "assessment_uncertain":
      reasonText = `review assessed ${riskLevel} risk, insufficient authorization, or did not meet the ${approvalMode ?? "selected"} profile threshold`;
      break;
    case "timeout":
      reasonText = "the reviewer timed out";
      break;
    case "cancelled":
      reasonText = "the review was cancelled";
      break;
    default:
      reasonText = "the reviewer could not complete its check";
  }
  log("decision.manual", {
    reviewID,
    reasonCode,
    decisionFallback,
    durationMs: elapsedMs(startedAt),
  });
  const notice = `Codex Auto Review did not approve automatically because ${reasonText}; manual confirmation is still required.`;
  event.message = typeof event.message === "string" && event.message.trim()
    ? `${event.message.trim()}\n${notice}`
    : notice;
}

function raceWithAbort(operation, signal) {
  if (signal.aborted) return Promise.reject(new Error("review aborted"));
  let rejectAbort;
  const aborted = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(new Error("review aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([operation, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}
