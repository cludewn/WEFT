import type { AdministrativeAttempt } from "../administrative-transaction.js";

export const MANAGED_EXECUTION_OPERATIONS = [
  "MANAGED_MESSAGE_SEND",
  "MANAGED_MESSAGE_EDIT",
] as const;
export const MANAGED_EXECUTION_STAGES = [
  "DISCORD_PREFLIGHT",
  "DISCORD_READ",
  "DISCORD_MUTATION",
  "DISCORD_RESPONSE",
  "DATABASE_START",
  "DATABASE_TRANSACTION",
  "DATABASE_COMMIT",
  "DATABASE_GUARD",
  "DELETION_FINALIZATION",
] as const;
export const MANAGED_EXECUTION_REASONS = [
  "BOT_PERMISSION_MISSING",
  "REQUIRED_RESOURCE_READ_FAILED",
  "MUTATION_REJECTED",
  "EDIT_NOT_APPLIED",
  "RETURNED_PAYLOAD_PROJECTION_FAILED",
  "RETURNED_PAYLOAD_MISMATCH",
  "RETURNED_RESPONSE_READ_FAILED",
  "TRANSACTION_START_FAILED",
  "TRANSACTION_ROLLED_BACK",
  "COMMIT_REJECTED",
  "FINALIZATION_NOT_TRANSITIONED",
] as const;
export const MANAGED_DISCORD_EVIDENCE = [
  "NOT_ATTEMPTED",
  "REJECTED",
  "NOT_APPLIED_BY_READBACK",
  "SEND_CONFIRMED",
  "EDIT_CONFIRMED",
  "DELETION_OBSERVED",
] as const;
export const MANAGED_PAYLOAD_EVIDENCE = [
  "NOT_CHECKED",
  "MATCH",
  "PROJECTION_UNAVAILABLE",
  "MISMATCH",
] as const;
export const MANAGED_TRANSACTION_EVIDENCE = [
  "NOT_ATTEMPTED",
  "START_FAILED",
  "ROLLED_BACK",
  "COMMIT_REJECTED",
  "COMMITTED",
  "UNCONFIRMED",
] as const;
export const MANAGED_DATABASE_EFFECTS = [
  "NOT_ATTEMPTED",
  "NOT_APPLIED",
  "NOT_TRANSITIONED",
] as const;
export const MANAGED_COMPENSATION_TYPES = ["NONE", "DELETE", "RESTORE"] as const;
export const MANAGED_COMPENSATION_EVIDENCE = [
  "NOT_REQUIRED",
  "NOT_ATTEMPTED",
  "SKIPPED_DATABASE_GUARD",
  "SKIPPED_DISCORD_GUARD",
  "SKIPPED_READ_FAILURE",
  "CONFIRMED",
  "ALREADY_ABSENT",
  "REJECTED",
] as const;

export type ManagedExecutionFailure = {
  stage: (typeof MANAGED_EXECUTION_STAGES)[number];
  reasonCode: (typeof MANAGED_EXECUTION_REASONS)[number];
};

/** Mutable observations from one awaited business attempt; never a persisted payload snapshot. */
export type ManagedMessageExecutionAttempt = AdministrativeAttempt & {
  operationCode: (typeof MANAGED_EXECUTION_OPERATIONS)[number];
  eligible: boolean;
  discordEvidence: (typeof MANAGED_DISCORD_EVIDENCE)[number] | "UNCONFIRMED";
  payloadEvidence: (typeof MANAGED_PAYLOAD_EVIDENCE)[number];
  databaseTransition: "NOT_ATTEMPTED" | "ATTEMPTED" | "NOT_TRANSITIONED" | "CONFIRMED";
  compensationType: (typeof MANAGED_COMPENSATION_TYPES)[number];
  compensationEvidence: (typeof MANAGED_COMPENSATION_EVIDENCE)[number] | "UNCONFIRMED";
  messageId: string | null;
  discordEffectAt: Date | null;
  failure?: ManagedExecutionFailure;
  successConfirmed?: true;
  historicalSuccess?: "MATCH" | "MISSING" | "MISMATCH" | "READ_FAILED";
};

export type ManagedMessageExecutionObservation = {
  attempt: ManagedMessageExecutionAttempt;
  actorAuthorized: () => void;
};

export type ManagedMessageTransactionAttempt = AdministrativeAttempt & {
  databaseTransition?: ManagedMessageExecutionAttempt["databaseTransition"];
};

export type ConfirmedManagedMessageExecution = ManagedExecutionFailure & {
  outcome: "FAILURE" | "PARTIAL";
  discordEvidence: (typeof MANAGED_DISCORD_EVIDENCE)[number];
  payloadEvidence: (typeof MANAGED_PAYLOAD_EVIDENCE)[number];
  transactionEvidence: (typeof MANAGED_TRANSACTION_EVIDENCE)[number];
  databaseEffect: (typeof MANAGED_DATABASE_EFFECTS)[number];
  compensationType: (typeof MANAGED_COMPENSATION_TYPES)[number];
  compensationEvidence: (typeof MANAGED_COMPENSATION_EVIDENCE)[number];
};

export function newManagedMessageExecutionAttempt(
  operationCode: ManagedMessageExecutionAttempt["operationCode"],
  messageId: string | null = null,
): ManagedMessageExecutionAttempt {
  return {
    operationId: "",
    operationCode,
    eligible: false,
    messageId,
    discordEvidence: "NOT_ATTEMPTED",
    payloadEvidence: "NOT_CHECKED",
    databaseTransition: "NOT_ATTEMPTED",
    compensationType: "NONE",
    compensationEvidence: "NOT_REQUIRED",
    discordEffectAt: null,
  };
}

/** No business result labels participate in this decision. PARTIAL describes historical facts. */
export function classifyManagedMessageExecution(
  attempt: ManagedMessageExecutionAttempt,
): ConfirmedManagedMessageExecution | undefined {
  if (
    !attempt.eligible ||
    attempt.operationId === "" ||
    attempt.successConfirmed ||
    (attempt.historicalSuccess !== undefined && attempt.historicalSuccess !== "MISSING")
  )
    return;

  const transactionEvidence =
    attempt.databaseTransition === "NOT_ATTEMPTED"
      ? "NOT_ATTEMPTED"
      : (attempt.transactionEvidence?.disposition ?? "UNCONFIRMED");
  let databaseEffect: ConfirmedManagedMessageExecution["databaseEffect"];
  let failure = attempt.failure;
  if (attempt.databaseTransition === "CONFIRMED") return;
  if (attempt.databaseTransition === "NOT_ATTEMPTED") databaseEffect = "NOT_ATTEMPTED";
  else if (attempt.databaseTransition === "NOT_TRANSITIONED") {
    databaseEffect = "NOT_TRANSITIONED";
    failure = { stage: "DATABASE_GUARD", reasonCode: "FINALIZATION_NOT_TRANSITIONED" };
  } else {
    databaseEffect = "NOT_APPLIED";
    switch (transactionEvidence) {
      case "START_FAILED":
        failure = { stage: "DATABASE_START", reasonCode: "TRANSACTION_START_FAILED" };
        break;
      case "ROLLED_BACK":
        failure = { stage: "DATABASE_TRANSACTION", reasonCode: "TRANSACTION_ROLLED_BACK" };
        break;
      case "COMMIT_REJECTED":
        failure = { stage: "DATABASE_COMMIT", reasonCode: "COMMIT_REJECTED" };
        break;
      default:
        return;
    }
  }
  if (
    failure === undefined ||
    attempt.discordEvidence === "UNCONFIRMED" ||
    attempt.compensationEvidence === "UNCONFIRMED"
  )
    return;

  let outcome: ConfirmedManagedMessageExecution["outcome"] = "FAILURE";
  if (attempt.discordEvidence === "DELETION_OBSERVED") {
    // External disappearance is not an edit effect. A normal detection guard is excluded.
    if (databaseEffect !== "NOT_APPLIED") return;
    failure = { ...failure, stage: "DELETION_FINALIZATION" };
  } else if (
    attempt.discordEvidence === "SEND_CONFIRMED" ||
    attempt.discordEvidence === "EDIT_CONFIRMED"
  ) {
    if (
      attempt.messageId === null ||
      attempt.discordEffectAt === null ||
      attempt.compensationType === "NONE"
    )
      return;
    if (
      attempt.compensationEvidence !== "CONFIRMED" &&
      attempt.compensationEvidence !== "ALREADY_ABSENT"
    ) {
      if (attempt.compensationEvidence === "NOT_REQUIRED") return;
      outcome = "PARTIAL";
    }
  } else if (attempt.compensationType !== "NONE" || databaseEffect !== "NOT_ATTEMPTED") return;

  return {
    ...failure,
    outcome,
    discordEvidence: attempt.discordEvidence,
    payloadEvidence: attempt.payloadEvidence,
    transactionEvidence,
    databaseEffect,
    compensationType: attempt.compensationType,
    compensationEvidence: attempt.compensationEvidence,
  };
}
