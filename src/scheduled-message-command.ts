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
} from "./scheduled-message-administration-persistence.js";
import type {
  RecurringMessageStore,
  RecurrenceEditEffect,
} from "./recurring-message-persistence.js";
import type { RecurringMessageWorker } from "./recurring-message-worker.js";
import type { GuildSettingsStore } from "./guild-settings.js";
import {
  findNextOccurrence,
  normalizeRecurringTimezone,
  parseRecurringCommandInput,
  validateRecurrence,
  type RecurringCommandInput,
} from "./recurring-message.js";
import {
  validateManagedMessagePayload,
  type ManagedMessagePayloadInput,
  type ManagedMessagePayloadValidationCode,
} from "./managed-message-payload.js";
import { addRelativeDuration, InvalidRelativeDurationError } from "./relative-duration.js";

export type CreateScheduledMessageCommandInput = {
  guildId: string;
  channelId: string;
  actorUserId: string;
  durationMs: number;
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
        | "INVALID_DURATION"
        | "PERSISTENCE_UNCONFIRMED";
    };

export type CancelScheduledMessageCommandResult =
  | { outcome: "CANCELLED" | "ALREADY_CANCELLED"; deliveryCleanupPending: boolean }
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
  | { outcome: "INVALID_DURATION" | "UNAVAILABLE" | "WRONG_KIND" };

export type CreateRecurringCommandResult =
  | {
      outcome: "SUCCESS";
      scheduledActionId: string;
      scheduledFor: Date;
      deliveryPendingReconciliation: boolean;
    }
  | {
      outcome:
        "INVALID_RECURRENCE" | "INVALID_GUILD_TIMEZONE" | "PERSISTENCE_UNCONFIRMED" | "UNAVAILABLE";
    }
  | {
      outcome: "FAILURE";
      code: ManagedMessagePayloadValidationCode | ScheduledMessageCreationAuthorizationFailureCode;
    };

export type EditRecurrenceCommandResult =
  | { outcome: "COMMITTED"; effect: RecurrenceEditEffect; deliveryPendingReconciliation: boolean }
  | {
      outcome:
        | "UNCHANGED"
        | "CONFLICT"
        | "WRONG_KIND"
        | "NOT_FOUND_OR_WRONG_CONTEXT"
        | "INVALID_RECURRENCE"
        | "PERSISTENCE_UNCONFIRMED"
        | "UNAVAILABLE";
    };

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
    input: Omit<CreateScheduledMessageCommandInput, "durationMs"> & {
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
    | EditScheduledMessageResult
    | { outcome: "INVALID_PAYLOAD"; code: ManagedMessagePayloadValidationCode }
  >;
  reschedule: (input: {
    scheduledActionId: string;
    guildId: string;
    channelId: string;
    actorUserId: string;
    durationMs: number;
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
  guildSettings?: Pick<GuildSettingsStore, "getOrCreate">;
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
  generateId = randomUUID,
  now = () => new Date(),
}: Dependencies): ScheduledMessageCommandService {
  return {
    async create(input) {
      const validation = validateManagedMessagePayload(input.payload);
      if (!validation.ok) return { outcome: "FAILURE", code: validation.code };

      let authorization;
      try {
        authorization = await discord.authorizeCreation({
          guildId: input.guildId,
          channelId: input.channelId,
          actorUserId: input.actorUserId,
          payload: validation.payload,
        });
      } catch {
        return { outcome: "FAILURE", code: "CURRENT_STATE_CHECK_FAILED" };
      }
      if (authorization.outcome === "FAILURE") return authorization;

      const scheduledActionId = generateId();
      const auditId = generateId();
      const establishedAt = now();
      let executeAt: Date;
      try {
        executeAt = addRelativeDuration(establishedAt, input.durationMs);
      } catch (error) {
        if (!(error instanceof InvalidRelativeDurationError)) throw error;
        return { outcome: "FAILURE", code: "INVALID_DURATION" };
      }

      let definition: ScheduledMessageDefinition;
      try {
        definition = await store.create({
          scheduledActionId,
          auditId,
          guildId: input.guildId,
          channelId: input.channelId,
          actorId: input.actorUserId,
          executeAt,
          payload: validation.payload,
          occurredAt: establishedAt,
        });
      } catch {
        logger.warn(
          {
            event: "scheduled_message_command_creation_unconfirmed",
            scheduledActionId,
            guildId: input.guildId,
            channelId: input.channelId,
            auditId,
          },
          "Scheduled message command creation could not be confirmed",
        );
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
        logger.warn(
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
      const parsed = parseRecurringCommandInput(input.recurrence);
      if (parsed === undefined) return { outcome: "INVALID_RECURRENCE" };
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
      try {
        const authorization = await discord.authorizeCreation({
          guildId: input.guildId,
          channelId: input.channelId,
          actorUserId: input.actorUserId,
          payload: payload.payload,
        });
        if (authorization.outcome === "FAILURE") return authorization;
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
      const result = await recurring
        .create({
          scheduledActionId,
          occurrenceId,
          auditId: generateId(),
          gapAuditIds: selection.skippedGaps.map(() => generateId()),
          guildId: input.guildId,
          channelId: input.channelId,
          actorId: input.actorUserId,
          payload: payload.payload,
          recurrence: recurrence.definition,
          effectiveAt,
        })
        .catch(() => ({ outcome: "PERSISTENCE_UNCONFIRMED" }) as const);
      if (result.outcome !== "COMMITTED")
        return {
          outcome:
            result.outcome === "INVALID_RECURRENCE"
              ? "INVALID_RECURRENCE"
              : "PERSISTENCE_UNCONFIRMED",
        };
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
        logger.warn(
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
      const parsed = parseRecurringCommandInput(input.recurrence);
      if (parsed === undefined) return { outcome: "INVALID_RECURRENCE" };
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
          auditId: generateId(),
          gapAuditIds: selection.skippedGaps.map(() => generateId()),
        })
        .catch(() => ({ outcome: "PERSISTENCE_UNCONFIRMED" }) as const);
      if (result.outcome !== "COMMITTED")
        return {
          outcome: result.outcome === "NOT_FOUND" ? "NOT_FOUND_OR_WRONG_CONTEXT" : result.outcome,
        };
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
        logger.warn(
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
        if (kind === "RECURRING") {
          let series;
          try {
            series = await recurring.find(input.scheduledActionId);
          } catch {
            return { outcome: "PERSISTENCE_UNCONFIRMED" };
          }
          if (series === undefined) return { outcome: "PERSISTENCE_UNCONFIRMED" };
          if (series.action.status === "CANCELLED")
            return { outcome: "ALREADY_CANCELLED", deliveryCleanupPending: false };
          const result = await recurring
            .cancel({
              scheduledActionId: input.scheduledActionId,
              actorId: input.actorUserId,
              expectedRevision: series.revision,
              auditId: generateId(),
              occurredAt: now(),
            })
            .catch(() => ({ outcome: "PERSISTENCE_UNCONFIRMED" }) as const);
          if (result.outcome === "COMMITTED")
            return { outcome: "CANCELLED", deliveryCleanupPending: false };
          return {
            outcome: result.outcome === "CONFLICT" ? "CONFLICT" : "PERSISTENCE_UNCONFIRMED",
          };
        }
      }
      const auditId = generateId();
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
        });
      } catch {
        result = { outcome: "PERSISTENCE_UNCONFIRMED" } as const;
      }
      if (result.outcome !== "CANCELLED" && result.outcome !== "ALREADY_CANCELLED") {
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
        logger.warn(
          {
            event: "scheduled_message_command_delivery_cleanup_pending",
            scheduledActionId: input.scheduledActionId,
            guildId: input.guildId,
            channelId: input.channelId,
          },
          "Cancelled scheduled message delivery cleanup could not be confirmed",
        );
      }
      return { outcome: result.outcome, deliveryCleanupPending };
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
        if (kind === "RECURRING") {
          let current;
          try {
            current = await recurring.find(input.scheduledActionId);
          } catch {
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
              auditId: generateId(),
              occurredAt: now(),
            })
            .catch(() => ({ outcome: "PERSISTENCE_UNCONFIRMED" }) as const);
          if (result.outcome === "COMMITTED")
            return { outcome: "EDITED", definition: result.series };
          if (result.outcome === "UNCHANGED")
            return { outcome: "UNCHANGED", definition: result.series };
          if (result.outcome === "CONFLICT") return { outcome: "CONFLICT" };
          if (result.outcome === "NOT_FOUND") return { outcome: "NOT_FOUND_OR_WRONG_CONTEXT" };
          return { outcome: "PERSISTENCE_UNCONFIRMED" };
        }
      }
      return store.edit({
        scheduledActionId: input.scheduledActionId,
        guildId: input.guildId,
        channelId: input.channelId,
        actorId: input.actorUserId,
        expectedRevision: input.expectedRevision,
        payload: validation.payload,
        auditId: generateId(),
        occurredAt: now(),
      });
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
      const establishedAt = now();
      let executeAt: Date;
      try {
        executeAt = addRelativeDuration(establishedAt, input.durationMs);
      } catch (error) {
        if (!(error instanceof InvalidRelativeDurationError)) throw error;
        return { outcome: "INVALID_DURATION" };
      }
      const result = await store.reschedule({
        scheduledActionId: input.scheduledActionId,
        guildId: input.guildId,
        channelId: input.channelId,
        actorId: input.actorUserId,
        expectedRevision: current.definition.revision,
        executeAt,
        auditId: generateId(),
        occurredAt: establishedAt,
      });
      if (result.outcome !== "RESCHEDULED") return result;

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
        logger.warn(
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
