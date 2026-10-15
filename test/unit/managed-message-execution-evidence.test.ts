import { describe, expect, it } from "vitest";
import {
  classifyManagedMessageExecution as classify,
  newManagedMessageExecutionAttempt,
  type ManagedMessageExecutionAttempt,
} from "../../src/managed-message-execution-evidence.js";

const at = new Date("2030-01-01T00:00:00.123Z");
function attempt(
  overrides: Partial<ManagedMessageExecutionAttempt> = {},
): ManagedMessageExecutionAttempt {
  return {
    ...newManagedMessageExecutionAttempt("MANAGED_MESSAGE_SEND"),
    operationId: "11111111-1111-4111-8111-111111111111",
    eligible: true,
    failure: { stage: "DISCORD_PREFLIGHT", reasonCode: "BOT_PERMISSION_MISSING" },
    ...overrides,
  };
}
function effected(overrides: Partial<ManagedMessageExecutionAttempt> = {}) {
  return attempt({
    discordEvidence: "SEND_CONFIRMED",
    messageId: "message",
    discordEffectAt: at,
    payloadEvidence: "MATCH",
    databaseTransition: "ATTEMPTED",
    compensationType: "DELETE",
    compensationEvidence: "CONFIRMED",
    transactionEvidence: {
      disposition: "ROLLED_BACK",
      callbackEntered: true,
      commitAttempted: false,
    },
    ...overrides,
  });
}

describe("managed execution evidence classifier", () => {
  it.each([
    { eligible: false },
    { operationId: "" },
    { successConfirmed: true as const },
    { historicalSuccess: "MATCH" as const },
    { historicalSuccess: "MISMATCH" as const },
    { historicalSuccess: "READ_FAILED" as const },
    { failure: undefined },
  ])(
    "excludes missing authorization, normal guards, confirmed success and unavailable history: %j",
    (change) => {
      const value = attempt();
      if ("failure" in change) delete value.failure;
      else Object.assign(value, change);
      expect(classify(value)).toBeUndefined();
    },
  );

  it.each(["NOT_ATTEMPTED", "REJECTED", "NOT_APPLIED_BY_READBACK"] as const)(
    "records a confirmed eligible pre-database failure with %s",
    (discordEvidence) => {
      expect(classify(attempt({ discordEvidence }))).toMatchObject({
        outcome: "FAILURE",
        databaseEffect: "NOT_ATTEMPTED",
      });
    },
  );
  it("does not convert an unknown Discord mutation into confirmed failure", () => {
    expect(classify(attempt({ discordEvidence: "UNCONFIRMED" }))).toBeUndefined();
  });

  it.each([
    [
      { disposition: "START_FAILED", callbackEntered: false, commitAttempted: false },
      "TRANSACTION_START_FAILED",
    ],
    [
      { disposition: "ROLLED_BACK", callbackEntered: true, commitAttempted: false },
      "TRANSACTION_ROLLED_BACK",
    ],
    [
      { disposition: "COMMIT_REJECTED", callbackEntered: true, commitAttempted: true },
      "COMMIT_REJECTED",
    ],
  ] as const)(
    "uses positive transaction noncompletion evidence: %j",
    (transactionEvidence, reasonCode) => {
      expect(classify(effected({ transactionEvidence }))).toMatchObject({
        outcome: "FAILURE",
        reasonCode,
        databaseEffect: "NOT_APPLIED",
      });
    },
  );

  it.each(["CONFIRMED", "ALREADY_ABSENT", "REJECTED", "UNCONFIRMED", "NOT_ATTEMPTED"] as const)(
    "preserves ambiguous COMMIT regardless of compensation %s",
    (compensationEvidence) => {
      for (const historicalSuccess of [undefined, "MISSING"] as const) {
        const value = effected({
          compensationEvidence,
          transactionEvidence: {
            disposition: "UNCONFIRMED",
            callbackEntered: true,
            commitAttempted: true,
          },
        });
        if (historicalSuccess) value.historicalSuccess = historicalSuccess;
        expect(classify(value)).toBeUndefined();
      }
    },
  );
  it("requires observed transaction evidence, not a rejected Promise or absent success history", () => {
    const value = effected({ historicalSuccess: "MISSING" });
    delete value.transactionEvidence;
    expect(classify(value)).toBeUndefined();
  });

  it.each([
    ["CONFIRMED", "FAILURE"],
    ["ALREADY_ABSENT", "FAILURE"],
    ["REJECTED", "PARTIAL"],
    ["NOT_ATTEMPTED", "PARTIAL"],
    ["UNCONFIRMED", undefined],
  ] as const)("separates compensated send disposition %s", (compensationEvidence, outcome) => {
    expect(classify(effected({ compensationEvidence }))?.outcome).toBe(outcome);
  });

  it.each(["PROJECTION_UNAVAILABLE", "MISMATCH"] as const)(
    "does not require a known payload to establish a verified creation: %s",
    (payloadEvidence) => {
      expect(
        classify(
          effected({
            databaseTransition: "NOT_ATTEMPTED",
            payloadEvidence,
            compensationEvidence: "REJECTED",
            failure: {
              stage: "DISCORD_RESPONSE",
              reasonCode:
                payloadEvidence === "MISMATCH"
                  ? "RETURNED_PAYLOAD_MISMATCH"
                  : "RETURNED_PAYLOAD_PROJECTION_FAILED",
            },
          }),
        ),
      ).toMatchObject({ outcome: "PARTIAL", databaseEffect: "NOT_ATTEMPTED" });
    },
  );

  it.each([
    "SKIPPED_DATABASE_GUARD",
    "SKIPPED_DISCORD_GUARD",
    "SKIPPED_READ_FAILURE",
    "REJECTED",
  ] as const)(
    "records confirmed edit effects without claiming their present persistence: %s",
    (compensationEvidence) => {
      expect(
        classify(
          effected({
            operationCode: "MANAGED_MESSAGE_EDIT",
            discordEvidence: "EDIT_CONFIRMED",
            compensationType: "RESTORE",
            compensationEvidence,
          }),
        ),
      ).toMatchObject({ outcome: "PARTIAL", discordEvidence: "EDIT_CONFIRMED" });
    },
  );
  it("distinguishes a conditional zero-row update from unknown transaction completion", () => {
    expect(
      classify(
        effected({
          operationCode: "MANAGED_MESSAGE_EDIT",
          discordEvidence: "EDIT_CONFIRMED",
          databaseTransition: "NOT_TRANSITIONED",
          compensationType: "RESTORE",
          compensationEvidence: "SKIPPED_DATABASE_GUARD",
          transactionEvidence: {
            disposition: "UNCONFIRMED",
            callbackEntered: true,
            commitAttempted: true,
          },
        }),
      ),
    ).toMatchObject({
      outcome: "PARTIAL",
      databaseEffect: "NOT_TRANSITIONED",
      transactionEvidence: "UNCONFIRMED",
    });
  });
  it("does not classify attempted restoration with response loss as residual effects", () => {
    expect(
      classify(effected({ compensationType: "RESTORE", compensationEvidence: "UNCONFIRMED" })),
    ).toBeUndefined();
  });
  it("attributes deletion finalization failure without fabricating an edit effect", () => {
    const value = effected({
      operationCode: "MANAGED_MESSAGE_EDIT",
      discordEvidence: "DELETION_OBSERVED",
      discordEffectAt: null,
      compensationType: "NONE",
      compensationEvidence: "NOT_REQUIRED",
    });
    expect(classify(value)).toMatchObject({ outcome: "FAILURE", stage: "DELETION_FINALIZATION" });
    value.databaseTransition = "NOT_TRANSITIONED";
    expect(classify(value)).toBeUndefined();
  });
});
