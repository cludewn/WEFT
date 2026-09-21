import { and, asc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";

import type { DatabaseClient } from "./database.js";
import {
  recurringMessageOccurrences,
  recurringMessageSchedules,
  type RecurringOccurrenceStatus,
} from "./recurring-message-persistence.js";
import type { RecurringMessageFrequency } from "./recurring-message.js";
import { scheduledActions } from "./scheduled-action-persistence.js";
import { scheduledMessageStates } from "./scheduled-message-persistence.js";

export type ScheduleKind = "ONE_TIME" | "RECURRING";
export type RecurringAdministrationView = {
  scheduledActionId: string;
  kind: "RECURRING";
  status: "ACTIVE" | "CANCELLED" | "EXECUTING" | "COMPLETED" | "FAILED";
  guildId: string;
  channelId: string;
  executeAt: Date;
  creatorUserId: string;
  revision: number;
  frequency: RecurringMessageFrequency;
  weekdayMask: number;
  localTime: string;
  timezone: string;
  currentOccurrenceId: string | null;
  currentOccurrenceStatus: RecurringOccurrenceStatus | null;
  retryCount: number | null;
};

export type CombinedScheduleListItem =
  | {
      kind: "ONE_TIME";
      scheduledActionId: string;
      status: "ACTIVE" | "EXECUTING";
      executeAt: Date;
      creatorUserId: string;
    }
  | Pick<
      RecurringAdministrationView,
      | "kind"
      | "scheduledActionId"
      | "status"
      | "executeAt"
      | "creatorUserId"
      | "frequency"
      | "weekdayMask"
      | "localTime"
      | "timezone"
      | "currentOccurrenceStatus"
    >;

export type ScheduledMessageAdministrationStore = {
  findKind: (id: string, guildId: string, channelId: string) => Promise<ScheduleKind | null>;
  findRecurringStatus: (
    id: string,
    guildId: string,
    channelId: string,
  ) => Promise<RecurringAdministrationView | null>;
  listCombined: (
    guildId: string,
    channelId: string,
    offset: number,
  ) => Promise<CombinedScheduleListItem[]>;
};

const currentOccurrence = inArray(recurringMessageOccurrences.status, [
  "PENDING",
  "EXECUTING",
  "RETRY_PENDING",
]);

export function createScheduledMessageAdministrationStore(
  database: DatabaseClient,
): ScheduledMessageAdministrationStore {
  return {
    async findKind(id, guildId, channelId) {
      const [row] = await database
        .select({ recurringId: recurringMessageSchedules.scheduledActionId })
        .from(scheduledActions)
        .innerJoin(
          scheduledMessageStates,
          eq(scheduledMessageStates.scheduledActionId, scheduledActions.id),
        )
        .leftJoin(
          recurringMessageSchedules,
          eq(recurringMessageSchedules.scheduledActionId, scheduledActions.id),
        )
        .where(
          and(
            eq(scheduledActions.id, id),
            eq(scheduledActions.guildId, guildId),
            eq(scheduledActions.targetId, channelId),
            eq(scheduledActions.actionType, "SEND_MESSAGE"),
          ),
        )
        .limit(1);
      return row === undefined ? null : row.recurringId === null ? "ONE_TIME" : "RECURRING";
    },
    async findRecurringStatus(id, guildId, channelId) {
      const [row] = await database
        .select({
          scheduledActionId: scheduledActions.id,
          status: scheduledActions.status,
          guildId: scheduledActions.guildId,
          channelId: scheduledActions.targetId,
          executeAt: scheduledActions.executeAt,
          creatorUserId: scheduledMessageStates.creatorUserId,
          revision: scheduledMessageStates.revision,
          frequency: recurringMessageSchedules.frequency,
          weekdayMask: recurringMessageSchedules.weekdayMask,
          localTime: recurringMessageSchedules.localTime,
          timezone: recurringMessageSchedules.timezone,
          currentOccurrenceId: recurringMessageOccurrences.id,
          currentOccurrenceStatus: recurringMessageOccurrences.status,
          retryCount: recurringMessageOccurrences.retryCount,
        })
        .from(scheduledActions)
        .innerJoin(
          scheduledMessageStates,
          eq(scheduledMessageStates.scheduledActionId, scheduledActions.id),
        )
        .innerJoin(
          recurringMessageSchedules,
          eq(recurringMessageSchedules.scheduledActionId, scheduledActions.id),
        )
        .leftJoin(
          recurringMessageOccurrences,
          and(
            eq(recurringMessageOccurrences.scheduledActionId, scheduledActions.id),
            currentOccurrence,
          ),
        )
        .where(
          and(
            eq(scheduledActions.id, id),
            eq(scheduledActions.guildId, guildId),
            eq(scheduledActions.targetId, channelId),
            eq(scheduledActions.actionType, "SEND_MESSAGE"),
          ),
        )
        .limit(1);
      return row === undefined ? null : { ...row, kind: "RECURRING" };
    },
    async listCombined(guildId, channelId, offset) {
      const rows = await database
        .select({
          scheduledActionId: scheduledActions.id,
          status: scheduledActions.status,
          executeAt: scheduledActions.executeAt,
          creatorUserId: scheduledMessageStates.creatorUserId,
          frequency: recurringMessageSchedules.frequency,
          weekdayMask: recurringMessageSchedules.weekdayMask,
          localTime: recurringMessageSchedules.localTime,
          timezone: recurringMessageSchedules.timezone,
          currentOccurrenceStatus: recurringMessageOccurrences.status,
        })
        .from(scheduledActions)
        .innerJoin(
          scheduledMessageStates,
          eq(scheduledMessageStates.scheduledActionId, scheduledActions.id),
        )
        .leftJoin(
          recurringMessageSchedules,
          eq(recurringMessageSchedules.scheduledActionId, scheduledActions.id),
        )
        .leftJoin(
          recurringMessageOccurrences,
          and(
            eq(recurringMessageOccurrences.scheduledActionId, scheduledActions.id),
            currentOccurrence,
          ),
        )
        .where(
          and(
            eq(scheduledActions.guildId, guildId),
            eq(scheduledActions.targetId, channelId),
            eq(scheduledActions.actionType, "SEND_MESSAGE"),
            or(
              and(
                isNull(recurringMessageSchedules.scheduledActionId),
                inArray(scheduledActions.status, ["ACTIVE", "EXECUTING"]),
              ),
              and(
                isNotNull(recurringMessageSchedules.scheduledActionId),
                eq(scheduledActions.status, "ACTIVE"),
              ),
            ),
          ),
        )
        .orderBy(asc(scheduledActions.executeAt), asc(scheduledActions.id))
        .limit(10)
        .offset(offset);
      return rows.map((row): CombinedScheduleListItem =>
        row.frequency === null
          ? {
              kind: "ONE_TIME",
              scheduledActionId: row.scheduledActionId,
              status: row.status as "ACTIVE" | "EXECUTING",
              executeAt: row.executeAt,
              creatorUserId: row.creatorUserId,
            }
          : {
              kind: "RECURRING",
              scheduledActionId: row.scheduledActionId,
              status: "ACTIVE",
              executeAt: row.executeAt,
              creatorUserId: row.creatorUserId,
              frequency: row.frequency,
              weekdayMask: row.weekdayMask!,
              localTime: row.localTime!,
              timezone: row.timezone!,
              currentOccurrenceStatus: row.currentOccurrenceStatus,
            },
      );
    },
  };
}
