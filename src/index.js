import { inspectAutoReviewProvider, registerAutoReviewModel } from "./model-registration.js";
import { isEligibleChatGPTCredential, applyUnreviewedToolFallback, reviewPermission } from "./review.js";
import {
  OPENAI_PROVIDER_ID,
  resolveApprovalMode,
  resolveReviewFallback,
  shouldReviewPermission,
} from "./review-protocol.js";
import {
  createReviewLogger,
  createReviewID,
  elapsedMs,
  safeErrorName,
  summarizePermission,
} from "./diagnostics.js";

export default {
  id: "opencode-codex-auto-review",
  async setup(ctx) {
    const approvalMode = resolveApprovalMode(ctx.options?.mode ?? process.env.OPENCODE_CODEX_AUTO_REVIEW_MODE);
    const decisionFallback = resolveReviewFallback(ctx.options?.fallback ?? process.env.OPENCODE_CODEX_AUTO_REVIEW_FALLBACK);
    const log = createReviewLogger();
    const setupStartedAt = performance.now();
    let disposed = false;
    const active = new Set();
    const transforms = [];

    log("plugin.setup.started", { approvalMode, decisionFallback });
    let permissionRegistration;
    const registrationStartedAt = performance.now();
    log("permission-hook.register.started", { name: "evaluate" });
    try {
      permissionRegistration = await ctx.permission.hook("evaluate", async (event) => {
        const reviewID = createReviewID();
        const hookStartedAt = performance.now();
        const eligible = shouldReviewPermission(event);
        log("permission-hook.received", {
          reviewID,
          ...summarizePermission(event),
          eligible,
          inFlightBefore: active.size,
        });

        if (disposed || !eligible) {
          const reason = disposed
            ? "plugin_disposed"
            : event?.effect !== "ask"
              ? "permission_not_ask"
              : event?.source?.type !== "tool"
                ? "source_not_tool"
                : "invalid_permission_request";
          log("permission-hook.skipped", { reviewID, reasonCode: reason, durationMs: elapsedMs(hookStartedAt) });
          if (!disposed) applyUnreviewedToolFallback(event, { fallback: decisionFallback, reviewID, startedAt: hookStartedAt, log });
          return;
        }

        const controller = new AbortController();
        active.add(controller);
        log("review.dispatched", { reviewID, inFlight: active.size });
        try {
          await reviewPermission(ctx, event, {
            signal: controller.signal,
            mode: approvalMode,
            fallback: decisionFallback,
            reviewID,
            startedAt: hookStartedAt,
            log,
          });
        } finally {
          active.delete(controller);
          log("permission-hook.completed", {
            reviewID,
            finalEffect: event.effect,
            durationMs: elapsedMs(hookStartedAt),
            inFlight: active.size,
          });
        }
      });
      log("permission-hook.register.completed", {
        name: "evaluate",
        durationMs: elapsedMs(registrationStartedAt),
      });
    } catch (error) {
      log("permission-hook.register.failed", {
        name: "evaluate",
        durationMs: elapsedMs(registrationStartedAt),
        errorName: safeErrorName(error),
      });
      throw error;
    }

    let startupPhase = "connection.active";
    const startupPhaseStartedAt = performance.now();
    log("reviewer-model.setup.started");
    try {
      log("phase.started", { phase: startupPhase });
      const candidate = await ctx.integration.connection.active(OPENAI_PROVIDER_ID);
      log("phase.completed", {
        phase: startupPhase,
        durationMs: elapsedMs(startupPhaseStartedAt),
        connectionAvailable: Boolean(candidate),
      });
      const credential = candidate ? await ctx.integration.connection.resolve(candidate) : undefined;
      log("oauth.eligibility.checked", {
        credentialAvailable: Boolean(credential),
        eligible: isEligibleChatGPTCredential(credential),
      });
      if (isEligibleChatGPTCredential(credential)) {
        let providerReady = false;
        let lastProviderRegistrationState;
        startupPhase = "provider.transform";
        let phaseStartedAt = performance.now();
        log("phase.started", { phase: startupPhase });
        transforms.push(await ctx.provider.transform((editor) => {
          const inspection = inspectAutoReviewProvider(editor);
          providerReady = registerAutoReviewModel(editor);
          const registrationState = JSON.stringify({ ...inspection, registered: providerReady });
          if (registrationState !== lastProviderRegistrationState) {
            lastProviderRegistrationState = registrationState;
            log("provider.registration.inspect", inspection);
            log("provider.registration.completed", {
              registered: providerReady,
              reasonCode: providerReady ? undefined : "native_codex_route_missing",
            });
          }
        }));
        log("phase.completed", { phase: startupPhase, durationMs: elapsedMs(phaseStartedAt) });

        startupPhase = "provider.reload";
        phaseStartedAt = performance.now();
        log("phase.started", { phase: startupPhase });
        await ctx.provider.reload();
        log("phase.completed", { phase: startupPhase, durationMs: elapsedMs(phaseStartedAt) });

        startupPhase = "model.transform";
        phaseStartedAt = performance.now();
        log("phase.started", { phase: startupPhase });
        transforms.push(await ctx.model.transform((editor) => {
          if (!editor.get(OPENAI_PROVIDER_ID, "codex-auto-review")) return;
          editor.update(OPENAI_PROVIDER_ID, "codex-auto-review", (model) => {
            model.enabled = true;
            model.status = "active";
            model.capabilities = { ...model.capabilities, tools: false, input: ["text"], output: ["text"] };
          });
        }));
        log("phase.completed", { phase: startupPhase, durationMs: elapsedMs(phaseStartedAt) });

        startupPhase = "model.reload";
        phaseStartedAt = performance.now();
        log("phase.started", { phase: startupPhase });
        await ctx.model.reload();
        log("phase.completed", { phase: startupPhase, durationMs: elapsedMs(phaseStartedAt) });
        log("reviewer-model.setup.completed", {
          transformRegistered: true,
          routeCheckPending: !providerReady,
          durationMs: elapsedMs(setupStartedAt),
        });
      } else {
        log("reviewer-model.setup.completed", {
          transformRegistered: false,
          routeCheckPending: false,
          reasonCode: candidate ? "credential_ineligible" : "connection_missing",
          durationMs: elapsedMs(setupStartedAt),
        });
      }
    } catch (error) {
      // Without a live ChatGPT OAuth credential, do not expose the reviewer model.
      log("reviewer-model.setup.failed", {
        phase: startupPhase,
        durationMs: elapsedMs(setupStartedAt),
        errorName: safeErrorName(error),
      });
    }

    return async () => {
      disposed = true;
      log("plugin.cleanup.started", { activeReviews: active.size, transforms: transforms.length });
      for (const controller of active) controller.abort();
      await permissionRegistration.dispose();
      for (const registration of transforms.reverse()) await registration.dispose();
      log("plugin.cleanup.completed");
    };
  },
};
