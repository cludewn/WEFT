import {
  confirmedAdministrativeDatabaseFailure,
  type AdministrativeFailureRecorder,
  type ScheduleAdministrativeOperation,
} from "../audit/administrative-operation-failure-audit.js";
import type { AdministrativeAttempt } from "../administrative-transaction.js";
import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type {
  ScheduledMessageCreationAuthorizationFailureCode,
  ScheduledMessageCreationDiscord,
} from "./scheduled-message-discord.js";
import type {
  ScheduledMessageDefinition,
  ScheduledMessageEditableLoadResult,
  EditScheduledMessageResult,
  ScheduledMessageListResult,
  ModifyScheduledMessageResult,
  ScheduledMessageStatusResult,
  ScheduledMessageStore,
} from "./scheduled-message-persistence.js";
import type { ScheduledMessageWorkerController } from "./scheduled-message-worker.js";
import type {
  ScheduledMessageAdministrationStore,
  CombinedScheduleListItem,
  RecurringAdministrationView,
  ScheduleKind,
} from "./scheduled-message-administration-persistence.js";
import type {
  RecurringMessageStore,
  RecurrenceEditEffect,
} from "./recurring-message-persistence.js";
import type { RecurringMessageWorker } from "./recurring-message-worker.js";
import type { GuildSettingsStore } from "../guild/guild-settings.js";
import {
  findNextOccurrence,
  normalizeRecurringTimezone,
  validateRecurringCommandInput,
  type RecurringInputField,
  validateRecurrence,
  type RecurringCommandInput,
} from "./recurring-message.js";
import {
  validateManagedMessagePayload,
  type ManagedMessagePayloadInput,
  type ManagedMessagePayloadValidationCode,
} from "./managed-message-payload.js";
import {
  resolveOneTimeSchedule,
  type OneTimeScheduleInput,
  type OneTimeScheduleError,
} from "./one-time-message-schedule.js";

export type CreateScheduledMessageCommandInput = {
  guildId: string;
  channelId: string;
  actorUserId: string;
  schedule: OneTimeScheduleInput;
  payload: ManagedMessagePayloadInput;
};

export type CreateScheduledMessageCommandResult =
  | {
      outcome: "SUCCESS";
      definition: ScheduledMessageDefinition;
      deliveryPendingReconciliation: boolean;
    }
  | {
      outcome: "FAILURE";
      code:
        | ManagedMessagePayloadValidationCode
        | ScheduledMessageCreationAuthorizationFailureCode
        | OneTimeScheduleError
        | "PERSISTENCE_UNCONFIRMED";
    };

export type CancelScheduledMessageCommandResult =
  | {
      outcome: "CANCELLED" | "ALREADY_CANCELLED";
      kind: ScheduleKind;
      deliveryCleanupPending: boolean;
    }
  | {
      outcome:
        | "EXECUTING"
        | "COMPLETED"
        | "FAILED"
        | "NOT_FOUND_OR_WRONG_CONTEXT"
        | "CONFLICT"
        | "PERSISTENCE_UNCONFIRMED";
    };

export type RescheduleScheduledMessageCommandResult =
  | ({ deliveryPendingReconciliation: boolean } & Extract<
      ModifyScheduledMessageResult,
      { outcome: "RESCHEDULED" }
    >)
  | Exclude<ModifyScheduledMessageResult, { outcome: "RESCHEDULED" | "EDITED" | "UNCHANGED" }>
  | { outcome: OneTimeScheduleError | "UNAVAILABLE" | "WRONG_KIND" };

export type CreateRecurringCommandResult =
  | {
      outcome: "SUCCESS";
      scheduledActionId: string;
      scheduledFor: Date;
      deliveryPendingReconciliation: boolean;
    }
  | {
      outcome: "INVALID_RECURRENCE";
      field?: RecurringInputField;
    }
  | {
      outcome: "INVALID_GUILD_TIMEZONE" | "PERSISTENCE_UNCONFIRMED" | "UNAVAILABLE";
    }
  | {
      outcome: "FAILURE";
      code: ManagedMessagePayloadValidationCode | ScheduledMessageCreationAuthorizationFailureCode;
    };

export type EditRecurrenceCommandResult =
  | { outcome: "INVALID_RECURRENCE"; field?: RecurringInputField }
  | { outcome: "COMMITTED"; effect: RecurrenceEditEffect; deliveryPendingReconciliation: boolean }
  | {
      outcome:
        | "UNCHANGED"
        | "CONFLICT"
        | "WRONG_KIND"
        | "NOT_FOUND_OR_WRONG_CONTEXT"
        | "PERSISTENCE_UNCONFIRMED"
        | "UNAVAILABLE";
    };

export type EditScheduledMessageCommandResult =
  | (Extract<EditScheduledMessageResult, { outcome: "EDITED" | "UNCHANGED" }> & {
      kind: ScheduleKind;
    })
  | Exclude<EditScheduledMessageResult, { outcome: "EDITED" | "UNCHANGED" }>;

export type CombinedScheduledMessageStatusResult =
  ScheduledMessageStatusResult | { outcome: "FOUND"; schedule: RecurringAdministrationView };
export type CombinedScheduledMessageListResult =
  | { outcome: "FOUND"; schedules: CombinedScheduleListItem[] }
  | { outcome: "UNAVAILABLE" }
  | { outcome: "INVALID_PAGE" };

export type ScheduledMessageCommandService = {
  create: (
    input: CreateScheduledMessageCommandInput,
  ) => Promise<CreateScheduledMessageCommandResult>;
  createRecurring: (
    input: Omit<CreateScheduledMessageCommandInput, "schedule"> & {
      recurrence: RecurringCommandInput;
    },
  ) => Promise<CreateRecurringCommandResult>;
  editRecurrence: (input: {
    scheduledActionId: string;
    guildId: string;
    channelId: string;
    actorUserId: string;
    recurrence: RecurringCommandInput;
  }) => Promise<EditRecurrenceCommandResult>;
  cancel: (input: {
    scheduledActionId: string;
    guildId: string;
    channelId: string;
    actorUserId: string;
  }) => Promise<CancelScheduledMessageCommandResult>;
  status: (input: {
    scheduledActionId: string;
    guildId: string;
    channelId: string;
  }) => Promise<CombinedScheduledMessageStatusResult>;
  list: (input: {
    guildId: string;
    channelId: string;
    page: number;
  }) => Promise<CombinedScheduledMessageListResult | ScheduledMessageListResult>;
  findEditable: (input: {
    scheduledActionId: string;
    guildId: string;
    channelId: string;
  }) => Promise<ScheduledMessageEditableLoadResult>;
  edit: (input: {
    scheduledActionId: string;
    guildId: string;
    channelId: string;
    actorUserId: string;
    expectedRevision: number;
    payload: ManagedMessagePayloadInput;
  }) => Promise<
    | EditScheduledMessageCommandResult
    | { outcome: "INVALID_PAYLOAD"; code: ManagedMessagePayloadValidationCode }
  >;
  reschedule: (input: {
    scheduledActionId: string;
    guildId: string;
    channelId: string;
    actorUserId: string;
    schedule: OneTimeScheduleInput;
  }) => Promise<RescheduleScheduledMessageCommandResult>;
};

type Dependencies = {
  discord: ScheduledMessageCreationDiscord;
  store: Pick<
    ScheduledMessageStore,
    | "create"
    | "cancel"
    | "findStatus"
    | "listNonterminal"
    | "findEditable"
    | "edit"
    | "reschedule"
    | "find"
  >;
  delivery: Pick<
    ScheduledMessageWorkerController,
    "ensureScheduledMessageDelivery" | "cancelScheduledMessageDeliveries"
  >;
  logger: Pick<Logger, "warn">;
  administration?: ScheduledMessageAdministrationStore;
  recurring?: Pick<
    RecurringMessageStore,
    "create" | "find" | "editPayload" | "editRecurrence" | "cancel"
  >;
  recurringWorker?: Pick<RecurringMessageWorker, "project">;
  guildSettings?: Pick<GuildSettingsStore, "getOrCreate" | "readTimezone">;
  failures?: AdministrativeFailureRecorder;
  generateId?: () => string;
  now?: () => Date;
};

export function createScheduledMessageCommandService({
  discord,
  store,
  delivery,
  logger,
  administration,
  recurring,
  recurringWorker,
  guildSettings,
  failures,
  generateId = randomUUID,
  now = () => new Date(),
}: Dependencies): ScheduledMessageCommandService {
  const warn = (fields: Record<string, unknown>, message: string): void => {
    try {
      logger.warn(fields, message);
    } catch {
      /* Preserve the business result and its owner. */
    }
  };
  async function establishSchedule(schedule: OneTimeScheduleInput, guildId: string) {
    let timezone: string | undefined;
    if (schedule.kind === "AT") {
      if (guildSettings === undefined) return { ok: false, code: "TIMEZONE_UNAVAILABLE" } as const;
      let storedTimezone: string;
      try {
        storedTimezone = (await guildSettings.getOrCreate(guildId)).timezone;
      } catch {
        return { ok: false, code: "TIMEZONE_UNAVAILABLE" } as const;
      }
      timezone = normalizeRecurringTimezone(storedTimezone);
      if (timezone === undefined) return { ok: false, code: "INVALID_GUILD_TIMEZONE" } as const;
    }
    const establishedAt = now();
    const resolved = resolveOneTimeSchedule(schedule, establishedAt, timezone);
    return resolved.ok ? { ...resolved, establishedAt } : resolved;
  }

  const recordScheduleFailure = async (
    attempt: AdministrativeAttempt,
    input: { guildId: string; actorUserId: string; scheduledActionId: string },
    operationCode: ScheduleAdministrativeOperation,
  ) => {
    const failure = confirmedAdministrativeDatabaseFailure(attempt);
    if (failure)
      await failures
        ?.record(attempt, input.guildId, input.actorUserId, {
          operationCode,
          targetType: "SCHEDULE",
          targetId: input.scheduledActionId,
          ...failure,
        })
        .catch(() => undefined);
  };
  const recordCreationFailure = async (
    attempt: AdministrativeAttempt,
    input: { guildId: string; actorUserId: string; channelId: string },
    operationCode: "ONE_TIME_MESSAGE_CREATE" | "RECURRING_MESSAGE_CREATE",
  ) => {
    const failure = confirmedAdministrativeDatabaseFailure(attempt);
    if (failure)
      await failures
        ?.record(attempt, input.guildId, input.actorUserId, {
          operationCode,
          targetType: "CHANNEL",
          targetId: input.channelId,
          ...failure,
        })
        .catch(() => undefined);
  };

  return {
    async create(input) {
      const validation = validateManagedMessagePayload(input.payload);
      if (!validation.ok) return { outcome: "FAILURE", code: validation.code };

      let preliminaryEligible = false;
      let candidateId: string | undefined;
      let attempt: AdministrativeAttempt | undefined;
      const observeEligibility = async () => {
        try {
          let timezone: string | undefined;
          if (input.schedule.kind === "AT") {
            if (!guildSettings?.readTimezone) return;
            try {
              timezone = normalizeRecurringTimezone(
                await guildSettings.readTimezone(input.guildId),
              );
            } catch {
              return;
            }
            if (timezone === undefined) return;
          }
          preliminaryEligible = resolveOneTimeSchedule(input.schedule, now(), timezone).ok;
          if (preliminaryEligible) {
            candidateId = generateId();
            attempt = { operationId: generateId() };
          }
        } catch {
          /* Unavailable audit-only evidence cannot reject the business request. */
        }
      };
      let authorization;
      try {
        authorization = await discord.authorizeCreation({
          guildId: input.guildId,
          channelId: input.channelId,
          actorUserId: input.actorUserId,
          payload: validation.payload,
          ...(failures ? { afterActorAuthorized: observeEligibility } : {}),
        });
      } catch {
        return { outcome: "FAILURE", code: "CURRENT_STATE_CHECK_FAILED" };
      }
      if (authorization.outcome === "FAILURE") {
        if (preliminaryEligible && attempt && authorization.administrativeFailure)
          await failures
            ?.record(attempt, input.guildId, input.actorUserId, {
              operationCode: "ONE_TIME_MESSAGE_CREATE",
              targetType: "CHANNEL",
              targetId: input.channelId,
              ...authorization.administrativeFailure,
            })
            .catch(() => undefined);
        return { outcome: "FAILURE", code: authorization.code };
      }

      const scheduledActionId = candidateId ?? generateId();
      const auditId = attempt?.operationId ?? generateId();
      const resolved = await establishSchedule(input.schedule, input.guildId);
      if (!resolved.ok) {
        if (preliminaryEligible && attempt && resolved.code === "TIMEZONE_UNAVAILABLE")
          await failures
            ?.record(attempt, input.guildId, input.actorUserId, {
              operationCode: "ONE_TIME_MESSAGE_CREATE",
              targetType: "CHANNEL",
              targetId: input.channelId,
              failureStage: "DATABASE_READ",
              failureReasonCode: "REQUIRED_STATE_READ_FAILED",
            })
            .catch(() => undefined);
        return { outcome: "FAILURE", code: resolved.code };
      }
      attempt ??= { operationId: auditId };
      const { executeAt, establishedAt } = resolved;

      let definition: ScheduledMessageDefinition;
      try {
        definition = await store.create({
          scheduledActionId,
          auditId,
          ...(failures ? { administrativeAttempt: attempt } : {}),
          guildId: input.guildId,
          channelId: input.channelId,
          actorId: input.actorUserId,
          executeAt,
          payload: validation.payload,
          occurredAt: establishedAt,
        });
      } catch {
        await recordCreationFailure(attempt, input, "ONE_TIME_MESSAGE_CREATE");
        try {
          warn(
            {
              event: "scheduled_message_command_creation_unconfirmed",
              scheduledActionId,
              guildId: input.guildId,
              channelId: input.channelId,
              auditId,
            },
            "Scheduled message command creation could not be confirmed",
          );
        } catch {
          /* Preserve the original result. */
        }
        return { outcome: "FAILURE", code: "PERSISTENCE_UNCONFIRMED" };
      }

      let deliveryPendingReconciliation: boolean;
      try {
        deliveryPendingReconciliation =
          (await delivery.ensureScheduledMessageDelivery({
            scheduledActionId: definition.action.id,
            executeAt: definition.action.executeAt,
            revision: definition.revision,
          })) === "PENDING_RECONCILIATION";
      } catch {
        deliveryPendingReconciliation = true;
      }
      if (deliveryPendingReconciliation) {
        warn(
          {
            event: "scheduled_message_command_delivery_pending",
            scheduledActionId: definition.action.id,
            guildId: definition.action.guildId,
            channelId: definition.action.targetId,
          },
          "Scheduled message delivery is pending reconciliation",
        );
      }
      return { outcome: "SUCCESS", definition, deliveryPendingReconciliation };
    },

    async createRecurring(input) {
      if (recurring === undefined || recurringWorker === undefined || guildSettings === undefined)
        return { outcome: "UNAVAILABLE" };
      const validationInput = validateRecurringCommandInput(input.recurrence);
      if (!validationInput.ok)
        return { outcome: "INVALID_RECURRENCE", field: validationInput.field };
      const parsed = validationInput.input;
      let timezone = parsed.explicitTimezone;
      if (timezone === undefined) {
        try {
          timezone = normalizeRecurringTimezone(
            (await guildSettings.getOrCreate(input.guildId)).timezone,
          );
        } catch {
          return { outcome: "INVALID_GUILD_TIMEZONE" };
        }
        if (timezone === undefined) return { outcome: "INVALID_GUILD_TIMEZONE" };
      }
      const payload = validateManagedMessagePayload(input.payload);
      if (!payload.ok) return { outcome: "FAILURE", code: payload.code };
      let attempt: AdministrativeAttempt | undefined;
      try {
        const authorization = await discord.authorizeCreation({
          guildId: input.guildId,
          channelId: input.channelId,
          actorUserId: input.actorUserId,
          payload: payload.payload,
          ...(failures
            ? {
                afterActorAuthorized: () => {
                  try {
                    if (
                      validateRecurrence({
                        frequency: parsed.frequency,
                        weekdayMask: parsed.weekdayMask,
                        localTime: parsed.localTime,
                        timezone,
                      }).ok
                    )
                      attempt = { operationId: generateId() };
                  } catch {
                    /* Audit-only qualification cannot reject the business request. */
                  }
                  return Promise.resolve();
                },
              }
            : {}),
        });
        if (authorization.outcome === "FAILURE") {
          if (attempt && authorization.administrativeFailure)
            await failures
              ?.record(attempt, input.guildId, input.actorUserId, {
                operationCode: "RECURRING_MESSAGE_CREATE",
                targetType: "CHANNEL",
                targetId: input.channelId,
                ...authorization.administrativeFailure,
              })
              .catch(() => undefined);
          return { outcome: "FAILURE", code: authorization.code };
        }
      } catch {
        return { outcome: "FAILURE", code: "CURRENT_STATE_CHECK_FAILED" };
      }
      const effectiveAt = now();
      const recurrence = validateRecurrence({
        frequency: parsed.frequency,
        weekdayMask: parsed.weekdayMask,
        localTime: parsed.localTime,
        timezone,
      });
      if (!recurrence.ok) return { outcome: "INVALID_RECURRENCE" };
      const selection = findNextOccurrence(recurrence.definition, 0, effectiveAt);
      const scheduledActionId = generateId();
      const occurrenceId = generateId();
      attempt ??= { operationId: generateId() };
      const result = await recurring
        .create({
          scheduledActionId,
          occurrenceId,
          auditId: attempt.operationId,
          ...(failures ? { administrativeAttempt: attempt } : {}),
          gapAuditIds: selection.skippedGaps.map(() => generateId()),
          guildId: input.guildId,
          channelId: input.channelId,
          actorId: input.actorUserId,
          payload: payload.payload,
          recurrence: recurrence.definition,
          effectiveAt,
        })
        .catch(() => ({ outcome: "PERSISTENCE_UNCONFIRMED" }) as const);
      if (result.outcome !== "COMMITTED") {
        await recordCreationFailure(attempt, input, "RECURRING_MESSAGE_CREATE");
        return {
          outcome:
            result.outcome === "INVALID_RECURRENCE"
              ? "INVALID_RECURRENCE"
              : "PERSISTENCE_UNCONFIRMED",
        };
      }
      let deliveryPendingReconciliation = true;
      try {
        deliveryPendingReconciliation =
          (await recurringWorker.project({
            delivery: {
              kind: "recurring-message-occurrence",
              scheduledActionId,
              occurrenceId,
              scheduledFor: selection.occurrence.scheduledFor.toISOString(),
              seriesRevision: 0,
              retryCount: 0,
            },
            wakeAt: selection.occurrence.scheduledFor,
          })) === "UNCONFIRMED";
      } catch {
        /* reconciliation repairs projection */
      }
      if (deliveryPendingReconciliation) {
        warn(
          {
            event: "recurring_creation_delivery_pending",
            scheduledActionId,
            guildId: input.guildId,
            channelId: input.channelId,
          },
          "Recurring initial delivery is pending reconciliation",
        );
      }
      return {
        outcome: "SUCCESS",
        scheduledActionId,
        scheduledFor: selection.occurrence.scheduledFor,
        deliveryPendingReconciliation,
      };
    },

    async editRecurrence(input) {
      if (administration === undefined || recurring === undefined || recurringWorker === undefined)
        return { outcome: "UNAVAILABLE" };
      let kind;
      try {
        kind = await administration.findKind(
          input.scheduledActionId,
          input.guildId,
          input.channelId,
        );
      } catch {
        return { outcome: "UNAVAILABLE" };
      }
      if (kind === null) return { outcome: "NOT_FOUND_OR_WRONG_CONTEXT" };
      if (kind === "ONE_TIME") return { outcome: "WRONG_KIND" };
      const validationInput = validateRecurringCommandInput(input.recurrence);
      if (!validationInput.ok)
        return { outcome: "INVALID_RECURRENCE", field: validationInput.field };
      const parsed = validationInput.input;
      let series;
      try {
        series = await recurring.find(input.scheduledActionId);
      } catch {
        return { outcome: "UNAVAILABLE" };
      }
      if (series === undefined || series.action.status !== "ACTIVE") return { outcome: "CONFLICT" };
      const validation = validateRecurrence({
        frequency: parsed.frequency,
        weekdayMask: parsed.weekdayMask,
        localTime: parsed.localTime,
        timezone: parsed.explicitTimezone ?? series.recurrence.timezone,
      });
      if (!validation.ok) return { outcome: "INVALID_RECURRENCE" };
      const attempt: AdministrativeAttempt = { operationId: generateId() };
      const effectiveAt = now();
      const selection = findNextOccurrence(validation.definition, series.revision + 1, effectiveAt);
      const result = await recurring
        .editRecurrence({
          scheduledActionId: input.scheduledActionId,
          actorId: input.actorUserId,
          expectedRevision: series.revision,
          recurrence: validation.definition,
          effectiveAt,
          replacementOccurrenceId: generateId(),
          auditId: attempt.operationId,
          ...(failures ? { administrativeAttempt: attempt } : {}),
          gapAuditIds: selection.skippedGaps.map(() => generateId()),
        })
        .catch(() => ({ outcome: "PERSISTENCE_UNCONFIRMED" }) as const);
      if (result.outcome !== "COMMITTED") {
        await recordScheduleFailure(attempt, input, "RECURRING_MESSAGE_RECURRENCE_EDIT");
        if (result.outcome === "INVALID_RECURRENCE") return { outcome: "INVALID_RECURRENCE" };
        return {
          outcome: result.outcome === "NOT_FOUND" ? "NOT_FOUND_OR_WRONG_CONTEXT" : result.outcome,
        };
      }
      const { effect } = result;
      let deliveryPendingReconciliation = false;
      if (effect.replacementOccurrenceId !== null && effect.replacementScheduledFor !== null) {
        let eligible: RecurringAdministrationView | null;
        try {
          eligible = await administration.findRecurringStatus(
            input.scheduledActionId,
            input.guildId,
            input.channelId,
          );
        } catch {
          eligible = null;
          deliveryPendingReconciliation = true;
        }
        if (
          eligible?.status === "ACTIVE" &&
          eligible.currentOccurrenceId === effect.replacementOccurrenceId &&
          eligible.currentOccurrenceStatus === "PENDING"
        ) {
          try {
            deliveryPendingReconciliation =
              (await recurringWorker.project({
                delivery: {
                  kind: "recurring-message-occurrence",
                  scheduledActionId: input.scheduledActionId,
                  occurrenceId: effect.replacementOccurrenceId,
                  scheduledFor: effect.replacementScheduledFor.toISOString(),
                  seriesRevision: effect.committedRevision,
                  retryCount: 0,
                },
                wakeAt: effect.replacementScheduledFor,
              })) === "UNCONFIRMED";
          } catch {
            deliveryPendingReconciliation = true;
          }
        }
      }
      if (deliveryPendingReconciliation) {
        warn(
          {
            event: "recurrence_edit_delivery_pending",
            scheduledActionId: input.scheduledActionId,
            guildId: input.guildId,
            channelId: input.channelId,
            committedRevision: effect.committedRevision,
          },
          "Recurring replacement delivery is pending reconciliation",
        );
      }
      return { outcome: "COMMITTED", effect, deliveryPendingReconciliation };
    },

    async cancel(input) {
      let targetValidated = false;
      if (administration !== undefined && recurring !== undefined) {
        let kind;
        try {
          kind = await administration.findKind(
            input.scheduledActionId,
            input.guildId,
            input.channelId,
          );
        } catch {
          return { outcome: "PERSISTENCE_UNCONFIRMED" };
        }
        if (kind === null) return { outcome: "NOT_FOUND_OR_WRONG_CONTEXT" };
        targetValidated = true;
        if (kind === "RECURRING") {
          const attempt: AdministrativeAttempt = { operationId: generateId() };
          let series;
          try {
            series = await recurring.find(input.scheduledActionId);
          } catch {
            await failures
              ?.record(attempt, input.guildId, input.actorUserId, {
                operationCode: "RECURRING_MESSAGE_CANCEL",
                targetType: "SCHEDULE",
                targetId: input.scheduledActionId,
                failureStage: "DATABASE_READ",
                failureReasonCode: "REQUIRED_STATE_READ_FAILED",
              })
              .catch(() => undefined);
            return { outcome: "PERSISTENCE_UNCONFIRMED" };
          }
          if (series === undefined) return { outcome: "PERSISTENCE_UNCONFIRMED" };
          if (series.action.status === "CANCELLED")
            return {
              outcome: "ALREADY_CANCELLED",
              kind: "RECURRING",
              deliveryCleanupPending: false,
            };
          const result = await recurring
            .cancel({
              scheduledActionId: input.scheduledActionId,
              actorId: input.actorUserId,
              expectedRevision: series.revision,
              auditId: attempt.operationId,
              ...(failures ? { administrativeAttempt: attempt } : {}),
              occurredAt: now(),
            })
            .catch(() => ({ outcome: "PERSISTENCE_UNCONFIRMED" }) as const);
          if (result.outcome === "COMMITTED")
            return { outcome: "CANCELLED", kind: "RECURRING", deliveryCleanupPending: false };
          await recordScheduleFailure(attempt, input, "RECURRING_MESSAGE_CANCEL");
          return {
            outcome: result.outcome === "CONFLICT" ? "CONFLICT" : "PERSISTENCE_UNCONFIRMED",
          };
        }
      }
      if (failures && !targetValidated) {
        try {
          targetValidated =
            (await store.findStatus(input.scheduledActionId, input.guildId, input.channelId))
              .outcome === "FOUND";
        } catch {
          /* Unknown scope cannot qualify for administrative failure auditing. */
        }
      }
      const auditId = generateId();
      const attempt: AdministrativeAttempt = { operationId: auditId };
      const occurredAt = now();
      let result: Awaited<ReturnType<ScheduledMessageStore["cancel"]>>;
      try {
        result = await store.cancel({
          scheduledActionId: input.scheduledActionId,
          guildId: input.guildId,
          channelId: input.channelId,
          actorId: input.actorUserId,
          auditId,
          occurredAt,
          ...(failures && targetValidated ? { administrativeAttempt: attempt } : {}),
        });
      } catch {
        result = { outcome: "PERSISTENCE_UNCONFIRMED" } as const;
      }
      if (result.outcome !== "CANCELLED" && result.outcome !== "ALREADY_CANCELLED") {
        if (result.outcome === "PERSISTENCE_UNCONFIRMED")
          await recordScheduleFailure(attempt, input, "ONE_TIME_MESSAGE_CANCEL");
        return { outcome: result.outcome };
      }

      let cleanup;
      try {
        cleanup = await delivery.cancelScheduledMessageDeliveries(input.scheduledActionId);
      } catch {
        cleanup = { outcome: "UNCONFIRMED" } as const;
      }
      const deliveryCleanupPending = cleanup.outcome === "UNCONFIRMED";
      if (deliveryCleanupPending) {
        warn(
          {
            event: "scheduled_message_command_delivery_cleanup_pending",
            scheduledActionId: input.scheduledActionId,
            guildId: input.guildId,
            channelId: input.channelId,
          },
          "Cancelled scheduled message delivery cleanup could not be confirmed",
        );
      }
      return { outcome: result.outcome, kind: "ONE_TIME", deliveryCleanupPending };
    },

    async status(input) {
      try {
        if (administration !== undefined) {
          const kind = await administration.findKind(
            input.scheduledActionId,
            input.guildId,
            input.channelId,
          );
          if (kind === null) return { outcome: "NOT_FOUND_OR_WRONG_CONTEXT" };
          if (kind === "RECURRING") {
            const schedule = await administration.findRecurringStatus(
              input.scheduledActionId,
              input.guildId,
              input.channelId,
            );
            return schedule === null
              ? { outcome: "NOT_FOUND_OR_WRONG_CONTEXT" }
              : { outcome: "FOUND", schedule };
          }
        }
        return await store.findStatus(input.scheduledActionId, input.guildId, input.channelId);
      } catch {
        return { outcome: "UNAVAILABLE" };
      }
    },

    async list(input) {
      if (!Number.isSafeInteger(input.page) || input.page < 1) return { outcome: "INVALID_PAGE" };
      const offset = (input.page - 1) * 10;
      if (!Number.isSafeInteger(offset)) return { outcome: "INVALID_PAGE" };
      try {
        if (administration !== undefined)
          return {
            outcome: "FOUND",
            schedules: await administration.listCombined(input.guildId, input.channelId, offset),
          };
        return await store.listNonterminal(input.guildId, input.channelId, offset);
      } catch {
        return { outcome: "UNAVAILABLE" };
      }
    },

    async findEditable(input) {
      try {
        if (administration !== undefined && recurring !== undefined) {
          const kind = await administration.findKind(
            input.scheduledActionId,
            input.guildId,
            input.channelId,
          );
          if (kind === null) return { outcome: "NOT_FOUND_OR_WRONG_CONTEXT" };
          if (kind === "RECURRING") {
            const series = await recurring.find(input.scheduledActionId);
            if (series === undefined) return { outcome: "CORRUPT" };
            return series.action.status === "ACTIVE"
              ? { outcome: "ACTIVE", definition: series }
              : { outcome: series.action.status };
          }
        }
        return await store.findEditable(input.scheduledActionId, input.guildId, input.channelId);
      } catch {
        return { outcome: "UNAVAILABLE" };
      }
    },

    async edit(input) {
      const validation = validateManagedMessagePayload(input.payload);
      if (!validation.ok) return { outcome: "INVALID_PAYLOAD", code: validation.code };
      let targetValidated = false;
      if (administration !== undefined && recurring !== undefined) {
        let kind;
        try {
          kind = await administration.findKind(
            input.scheduledActionId,
            input.guildId,
            input.channelId,
          );
        } catch {
          return { outcome: "PERSISTENCE_UNCONFIRMED" };
        }
        if (kind === null) return { outcome: "NOT_FOUND_OR_WRONG_CONTEXT" };
        targetValidated = true;
        if (kind === "RECURRING") {
          const attempt: AdministrativeAttempt = { operationId: generateId() };
          let current;
          try {
            current = await recurring.find(input.scheduledActionId);
          } catch {
            await failures
              ?.record(attempt, input.guildId, input.actorUserId, {
                operationCode: "RECURRING_MESSAGE_PAYLOAD_EDIT",
                targetType: "SCHEDULE",
                targetId: input.scheduledActionId,
                failureStage: "DATABASE_READ",
                failureReasonCode: "REQUIRED_STATE_READ_FAILED",
              })
              .catch(() => undefined);
            return { outcome: "PERSISTENCE_UNCONFIRMED" };
          }
          if (current === undefined) return { outcome: "CORRUPT" };
          if (current.action.status === "CANCELLED") return { outcome: "CANCELLED" };
          const result = await recurring
            .editPayload({
              scheduledActionId: input.scheduledActionId,
              actorId: input.actorUserId,
              expectedRevision: input.expectedRevision,
              payload: validation.payload,
              auditId: attempt.operationId,
              ...(failures ? { administrativeAttempt: attempt } : {}),
              occurredAt: now(),
            })
            .catch(() => ({ outcome: "PERSISTENCE_UNCONFIRMED" }) as const);
          if (result.outcome === "COMMITTED")
            return { outcome: "EDITED", kind: "RECURRING", definition: result.series };
          if (result.outcome === "UNCHANGED")
            return { outcome: "UNCHANGED", kind: "RECURRING", definition: result.series };
          if (result.outcome === "CONFLICT") return { outcome: "CONFLICT" };
          if (result.outcome === "NOT_FOUND") return { outcome: "NOT_FOUND_OR_WRONG_CONTEXT" };
          await recordScheduleFailure(attempt, input, "RECURRING_MESSAGE_PAYLOAD_EDIT");
          return { outcome: "PERSISTENCE_UNCONFIRMED" };
        }
      }
      if (failures && !targetValidated) {
        try {
          targetValidated =
            (await store.findStatus(input.scheduledActionId, input.guildId, input.channelId))
              .outcome === "FOUND";
        } catch {
          /* Unknown scope cannot qualify for administrative failure auditing. */
        }
      }
      const attempt: AdministrativeAttempt = { operationId: generateId() };
      const result = await store.edit({
        scheduledActionId: input.scheduledActionId,
        guildId: input.guildId,
        channelId: input.channelId,
        actorId: input.actorUserId,
        expectedRevision: input.expectedRevision,
        payload: validation.payload,
        auditId: attempt.operationId,
        ...(failures && targetValidated ? { administrativeAttempt: attempt } : {}),
        occurredAt: now(),
      });
      if (result.outcome === "PERSISTENCE_UNCONFIRMED")
        await recordScheduleFailure(attempt, input, "ONE_TIME_MESSAGE_EDIT");
      return result.outcome === "EDITED" || result.outcome === "UNCHANGED"
        ? { ...result, kind: "ONE_TIME" }
        : result;
    },

    async reschedule(input) {
      if (administration !== undefined) {
        let kind;
        try {
          kind = await administration.findKind(
            input.scheduledActionId,
            input.guildId,
            input.channelId,
          );
        } catch {
          return { outcome: "UNAVAILABLE" };
        }
        if (kind === null) return { outcome: "NOT_FOUND_OR_WRONG_CONTEXT" };
        if (kind === "RECURRING") return { outcome: "WRONG_KIND" };
      }
      let current: ScheduledMessageEditableLoadResult;
      try {
        current = await store.findEditable(input.scheduledActionId, input.guildId, input.channelId);
      } catch {
        return { outcome: "UNAVAILABLE" };
      }
      if (current.outcome !== "ACTIVE") return current;
      const resolved = await establishSchedule(input.schedule, input.guildId);
      if (!resolved.ok) return { outcome: resolved.code };
      const { executeAt, establishedAt } = resolved;
      const attempt: AdministrativeAttempt = { operationId: generateId() };
      const result = await store.reschedule({
        scheduledActionId: input.scheduledActionId,
        guildId: input.guildId,
        channelId: input.channelId,
        actorId: input.actorUserId,
        expectedRevision: current.definition.revision,
        executeAt,
        auditId: attempt.operationId,
        ...(failures ? { administrativeAttempt: attempt } : {}),
        occurredAt: establishedAt,
      });
      if (result.outcome !== "RESCHEDULED") {
        if (result.outcome === "PERSISTENCE_UNCONFIRMED")
          await recordScheduleFailure(attempt, input, "ONE_TIME_MESSAGE_RESCHEDULE");
        return result;
      }

      let authoritative: ScheduledMessageDefinition | undefined;
      try {
        authoritative = await store.find(input.scheduledActionId);
      } catch {
        authoritative = undefined;
      }
      let deliveryPendingReconciliation = true;
      if (authoritative?.action.status === "ACTIVE") {
        try {
          deliveryPendingReconciliation =
            (await delivery.ensureScheduledMessageDelivery({
              scheduledActionId: authoritative.action.id,
              executeAt: authoritative.action.executeAt,
              revision: authoritative.revision,
            })) === "PENDING_RECONCILIATION";
        } catch {
          deliveryPendingReconciliation = true;
        }
      }
      if (deliveryPendingReconciliation) {
        warn(
          {
            event: "scheduled_message_reschedule_delivery_pending",
            scheduledActionId: input.scheduledActionId,
            guildId: input.guildId,
            channelId: input.channelId,
          },
          "Rescheduled message delivery is pending reconciliation",
        );
      }
      return { ...result, deliveryPendingReconciliation };
    },
  };
}
