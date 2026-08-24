import type {
  ScheduledAction,
  ScheduledActionStore,
  ScheduledActionTransitionResult,
} from "./scheduled-action-persistence.js";
import type {
  ScheduledThreadCloseExecutionTransitionResult,
  ScheduledThreadCloseStore,
} from "./scheduled-thread-close-persistence.js";
import type {
  SystemThreadCloseResult,
  ThreadFailureCode,
  ThreadLifecycleService,
} from "./thread-lifecycle.js";

export type ScheduledThreadCloseExecutionFailureCode =
  | ThreadFailureCode
  | "SCHEDULED_ACTION_CLAIM_FAILED"
  | "SCHEDULED_ACTION_TRANSITION_FAILED"
  | "THREAD_LIFECYCLE_UNEXPECTED_FAILURE";

export type ScheduledThreadCloseExecutionResult =
  | { outcome: "SUCCESS"; action: ScheduledAction }
  | {
      outcome: "SKIPPED";
      reason: "ACTION_TYPE_MISMATCH" | "MISSING" | "NOT_ACTIVE";
      action?: ScheduledAction;
    }
  | {
      outcome: "RETRYABLE_FAILURE";
      code: ScheduledThreadCloseExecutionFailureCode;
      action?: ScheduledAction;
    }
  | {
      outcome: "PERMANENT_FAILURE";
      code: ThreadFailureCode;
      action: ScheduledAction;
    };

/**
 * Identifiers for one execution attempt.
 *
 * The thread lifecycle audit and the scheduled-close execution audit are separate records in
 * separate tables and therefore carry separate stable identifiers.
 */
export type ScheduledThreadCloseExecutionAuditIds = {
  attemptAuditId: string;
  executionAuditId: string;
};

export type ScheduledThreadCloseExecutor = {
  execute: (
    action: ScheduledAction,
    auditIds: ScheduledThreadCloseExecutionAuditIds,
  ) => Promise<ScheduledThreadCloseExecutionResult>;
};

type ExecutionFinalizationStore = Pick<
  ScheduledThreadCloseStore,
  "completeExecution" | "failExecution" | "releaseExecutionForRetry"
>;

type Dependencies = {
  scheduledActions: Pick<ScheduledActionStore, "claimExecution" | "findById">;
  schedules: ExecutionFinalizationStore;
  threadLifecycle: Pick<ThreadLifecycleService, "closeAsSystem">;
};

export function createScheduledThreadCloseExecutor({
  scheduledActions,
  schedules,
  threadLifecycle,
}: Dependencies): ScheduledThreadCloseExecutor {
  return {
    async execute(action, { attemptAuditId, executionAuditId }) {
      if (action.actionType !== "CLOSE_THREAD") {
        return { outcome: "SKIPPED", reason: "ACTION_TYPE_MISMATCH", action };
      }

      let claim: ScheduledActionTransitionResult;
      try {
        claim = await scheduledActions.claimExecution(action.id);
      } catch {
        return confirmClaimAfterResponseLoss(scheduledActions, action.id);
      }
      if (!claim.transitioned) {
        return skippedForCurrent(claim.current);
      }

      let lifecycleResult: SystemThreadCloseResult;
      try {
        lifecycleResult = await threadLifecycle.closeAsSystem(
          claim.current.guildId,
          claim.current.targetId,
          attemptAuditId,
        );
      } catch {
        return finalizeTransition(
          claim.current,
          () =>
            schedules.releaseExecutionForRetry({
              scheduledActionId: claim.current.id,
              auditId: executionAuditId,
              failureCode: "THREAD_LIFECYCLE_UNEXPECTED_FAILURE",
            }),
          "RETRYABLE_FAILURE",
          "THREAD_LIFECYCLE_UNEXPECTED_FAILURE",
        );
      }

      if (lifecycleResult.outcome === "SUCCESS") {
        return finalizeTransition(
          claim.current,
          () =>
            schedules.completeExecution({
              scheduledActionId: claim.current.id,
              auditId: executionAuditId,
            }),
          "SUCCESS",
        );
      }
      if (lifecycleResult.outcome === "PERMANENT_FAILURE") {
        return finalizeTransition(
          claim.current,
          () =>
            schedules.failExecution({
              scheduledActionId: claim.current.id,
              auditId: executionAuditId,
              failureCode: lifecycleResult.code,
            }),
          "PERMANENT_FAILURE",
          lifecycleResult.code,
        );
      }
      return finalizeTransition(
        claim.current,
        () =>
          schedules.releaseExecutionForRetry({
            scheduledActionId: claim.current.id,
            auditId: executionAuditId,
            failureCode: lifecycleResult.code,
          }),
        "RETRYABLE_FAILURE",
        lifecycleResult.code,
      );
    },
  };
}

async function confirmClaimAfterResponseLoss(
  scheduledActions: Pick<ScheduledActionStore, "findById">,
  actionId: string,
): Promise<ScheduledThreadCloseExecutionResult> {
  try {
    const current = await scheduledActions.findById(actionId);
    if (current === undefined) {
      return { outcome: "SKIPPED", reason: "MISSING" };
    }
    if (
      current.status === "CANCELLED" ||
      current.status === "COMPLETED" ||
      current.status === "FAILED"
    ) {
      return skippedForCurrent(current);
    }
    return {
      outcome: "RETRYABLE_FAILURE",
      code: "SCHEDULED_ACTION_CLAIM_FAILED",
      action: current,
    };
  } catch {
    return { outcome: "RETRYABLE_FAILURE", code: "SCHEDULED_ACTION_CLAIM_FAILED" };
  }
}

function skippedForCurrent(
  current: ScheduledAction | undefined,
): ScheduledThreadCloseExecutionResult {
  return current === undefined
    ? { outcome: "SKIPPED", reason: "MISSING" }
    : { outcome: "SKIPPED", reason: "NOT_ACTIVE", action: current };
}

/**
 * Applies one audited execution transition.
 *
 * The scheduled-action state change and its execution audit commit together, so an unconfirmed
 * response is classified as retryable rather than retried blindly here.
 */
async function finalizeTransition(
  executingAction: ScheduledAction,
  transition: () => Promise<ScheduledThreadCloseExecutionTransitionResult>,
  finalOutcome: "SUCCESS" | "RETRYABLE_FAILURE" | "PERMANENT_FAILURE",
  failureCode?: ScheduledThreadCloseExecutionFailureCode,
): Promise<ScheduledThreadCloseExecutionResult> {
  let result: ScheduledThreadCloseExecutionTransitionResult;
  try {
    result = await transition();
  } catch {
    return transitionFailure(executingAction);
  }

  if (result.outcome === "NOT_TRANSITIONED") {
    return result.current === undefined
      ? { outcome: "RETRYABLE_FAILURE", code: "SCHEDULED_ACTION_TRANSITION_FAILED" }
      : {
          outcome: "RETRYABLE_FAILURE",
          code: "SCHEDULED_ACTION_TRANSITION_FAILED",
          action: result.current,
        };
  }

  if (finalOutcome === "SUCCESS") {
    return { outcome: "SUCCESS", action: result.action };
  }
  if (finalOutcome === "PERMANENT_FAILURE") {
    return {
      outcome: "PERMANENT_FAILURE",
      code: failureCode as ThreadFailureCode,
      action: result.action,
    };
  }
  return {
    outcome: "RETRYABLE_FAILURE",
    code: failureCode ?? "SCHEDULED_ACTION_TRANSITION_FAILED",
    action: result.action,
  };
}

function transitionFailure(executingAction: ScheduledAction): ScheduledThreadCloseExecutionResult {
  return {
    outcome: "RETRYABLE_FAILURE",
    code: "SCHEDULED_ACTION_TRANSITION_FAILED",
    action: executingAction,
  };
}
