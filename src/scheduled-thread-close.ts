import type {
  ScheduledAction,
  ScheduledActionStatus,
  ScheduledActionStore,
  ScheduledActionTransitionResult,
} from "./scheduled-action-persistence.js";
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

export type ScheduledThreadCloseExecutor = {
  execute: (
    action: ScheduledAction,
    attemptAuditId: string,
  ) => Promise<ScheduledThreadCloseExecutionResult>;
};

type Dependencies = {
  scheduledActions: ScheduledActionStore;
  threadLifecycle: Pick<ThreadLifecycleService, "closeAsSystem">;
};

export function createScheduledThreadCloseExecutor({
  scheduledActions,
  threadLifecycle,
}: Dependencies): ScheduledThreadCloseExecutor {
  return {
    async execute(action, attemptAuditId) {
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
          scheduledActions,
          claim.current,
          "ACTIVE",
          scheduledActions.releaseExecutionForRetry,
          "RETRYABLE_FAILURE",
          "THREAD_LIFECYCLE_UNEXPECTED_FAILURE",
        );
      }

      if (lifecycleResult.outcome === "SUCCESS") {
        return finalizeTransition(
          scheduledActions,
          claim.current,
          "COMPLETED",
          scheduledActions.completeExecution,
          "SUCCESS",
        );
      }
      if (lifecycleResult.outcome === "PERMANENT_FAILURE") {
        return finalizeTransition(
          scheduledActions,
          claim.current,
          "FAILED",
          scheduledActions.failExecution,
          "PERMANENT_FAILURE",
          lifecycleResult.code,
        );
      }
      return finalizeTransition(
        scheduledActions,
        claim.current,
        "ACTIVE",
        scheduledActions.releaseExecutionForRetry,
        "RETRYABLE_FAILURE",
        lifecycleResult.code,
      );
    },
  };
}

async function confirmClaimAfterResponseLoss(
  scheduledActions: ScheduledActionStore,
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

async function finalizeTransition(
  scheduledActions: ScheduledActionStore,
  executingAction: ScheduledAction,
  expectedFinalStatus: ScheduledActionStatus,
  transition: (id: string) => Promise<ScheduledActionTransitionResult>,
  finalOutcome: "SUCCESS" | "RETRYABLE_FAILURE" | "PERMANENT_FAILURE",
  failureCode?: ScheduledThreadCloseExecutionFailureCode,
): Promise<ScheduledThreadCloseExecutionResult> {
  let result: ScheduledActionTransitionResult;
  try {
    result = await transition(executingAction.id);
  } catch {
    try {
      const current = await scheduledActions.findById(executingAction.id);
      return transitionResult(current, expectedFinalStatus, finalOutcome, failureCode);
    } catch {
      return transitionFailure(executingAction);
    }
  }
  return transitionResult(result.current, expectedFinalStatus, finalOutcome, failureCode);
}

function transitionResult(
  current: ScheduledAction | undefined,
  expectedFinalStatus: ScheduledActionStatus,
  finalOutcome: "SUCCESS" | "RETRYABLE_FAILURE" | "PERMANENT_FAILURE",
  failureCode?: ScheduledThreadCloseExecutionFailureCode,
): ScheduledThreadCloseExecutionResult {
  if (current === undefined || current.status !== expectedFinalStatus) {
    return current === undefined
      ? { outcome: "RETRYABLE_FAILURE", code: "SCHEDULED_ACTION_TRANSITION_FAILED" }
      : {
          outcome: "RETRYABLE_FAILURE",
          code: "SCHEDULED_ACTION_TRANSITION_FAILED",
          action: current,
        };
  }
  if (finalOutcome === "SUCCESS") {
    return { outcome: "SUCCESS", action: current };
  }
  if (finalOutcome === "PERMANENT_FAILURE") {
    return {
      outcome: "PERMANENT_FAILURE",
      code: failureCode as ThreadFailureCode,
      action: current,
    };
  }
  return {
    outcome: "RETRYABLE_FAILURE",
    code: failureCode ?? "SCHEDULED_ACTION_TRANSITION_FAILED",
    action: current,
  };
}

function transitionFailure(executingAction: ScheduledAction): ScheduledThreadCloseExecutionResult {
  return {
    outcome: "RETRYABLE_FAILURE",
    code: "SCHEDULED_ACTION_TRANSITION_FAILED",
    action: executingAction,
  };
}
