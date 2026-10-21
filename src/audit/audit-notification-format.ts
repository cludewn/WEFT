import { translate, type AppLocale } from "../i18n/translate.js";
import type { MessageKey } from "../i18n/en-US.js";
import {
  MANAGED_EXECUTION_OPERATIONS,
  MANAGED_EXECUTION_STAGES,
  MANAGED_EXECUTION_REASONS,
  MANAGED_DISCORD_EVIDENCE,
  MANAGED_DATABASE_EFFECTS,
  MANAGED_COMPENSATION_EVIDENCE,
} from "../messages/managed-message-execution-evidence.js";
import { createHash } from "node:crypto";

export type AuditSource =
  | "THREAD"
  | "SCHEDULED_THREAD_CLOSE"
  | "MANAGED_MESSAGE"
  | "SCHEDULED_MESSAGE"
  | "RECURRING_MESSAGE"
  | "AUDIT_LOG_DESTINATION"
  | "LINK_PREVIEW"
  | "GUILD_CONFIGURATION"
  | "ADMINISTRATIVE_OPERATION_FAILURE"
  | "MANAGED_MESSAGE_EXECUTION_FAILURE";

export type AuditReference = Readonly<{ source: AuditSource; auditId: string }>;

export type AuditNotificationRecord = AuditReference & {
  guildId: string;
  event: string;
  outcome: string;
  actorType: "USER" | "SYSTEM";
  actorUserId?: string;
  occurredAt: Date;
  threadId?: string;
  channelId?: string;
  messageId?: string;
  scheduledActionId?: string;
  occurrenceId?: string;
  failureCode?: string;
  failureStage?: string;
  discordEvidence?: string;
  databaseEffect?: string;
  compensationEvidence?: string;
  skipReason?: string;
  previousDestinationId?: string;
  newDestinationId?: string;
  previousMode?: string;
  newMode?: string;
  settingType?: string;
  targetType?: string;
  targetId?: string;
};

const safeIdentifier = /^[A-Za-z0-9_-]{1,64}$/;

export function formatAuditNotification(
  record: AuditNotificationRecord,
  locale: AppLocale = "en-US",
): { content: string; nonce: string } | undefined {
  if (
    record.source === "MANAGED_MESSAGE_EXECUTION_FAILURE" &&
    (record.actorType !== "USER" ||
      !["FAILURE", "PARTIAL"].includes(record.outcome) ||
      !MANAGED_EXECUTION_OPERATIONS.includes(record.event as never) ||
      !MANAGED_EXECUTION_STAGES.includes(record.failureStage as never) ||
      !MANAGED_EXECUTION_REASONS.includes(record.failureCode as never) ||
      !MANAGED_DISCORD_EVIDENCE.includes(record.discordEvidence as never) ||
      !MANAGED_DATABASE_EFFECTS.includes(record.databaseEffect as never) ||
      !MANAGED_COMPENSATION_EVIDENCE.includes(record.compensationEvidence as never))
  )
    return undefined;
  const privateFailure =
    record.source === "ADMINISTRATIVE_OPERATION_FAILURE" ||
    record.source === "MANAGED_MESSAGE_EXECUTION_FAILURE";
  const fields: [Extract<MessageKey, `audit.label.${string}`>, string | undefined][] = [
    ["audit.label.source", record.source],
    ["audit.label.event", record.event],
    ["audit.label.outcome", record.outcome],
    ["audit.label.actor", record.actorType],
    ["audit.label.actorId", record.actorUserId],
    ["audit.label.threadId", privateFailure ? undefined : record.threadId],
    ["audit.label.channelId", privateFailure ? undefined : record.channelId],
    ["audit.label.messageId", privateFailure ? undefined : record.messageId],
    ["audit.label.scheduleId", privateFailure ? undefined : record.scheduledActionId],
    ["audit.label.occurrenceId", privateFailure ? undefined : record.occurrenceId],
    ["audit.label.failureCode", record.failureCode],
    ["audit.label.failureStage", record.failureStage],
    [
      "audit.label.discordEvidence",
      record.source === "MANAGED_MESSAGE_EXECUTION_FAILURE" ? record.discordEvidence : undefined,
    ],
    [
      "audit.label.databaseEffect",
      record.source === "MANAGED_MESSAGE_EXECUTION_FAILURE" ? record.databaseEffect : undefined,
    ],
    [
      "audit.label.compensationEvidence",
      record.source === "MANAGED_MESSAGE_EXECUTION_FAILURE"
        ? record.compensationEvidence
        : undefined,
    ],
    ["audit.label.skipReason", privateFailure ? undefined : record.skipReason],
    ["audit.label.previousDestination", privateFailure ? undefined : record.previousDestinationId],
    ["audit.label.newDestination", privateFailure ? undefined : record.newDestinationId],
    ["audit.label.previousMode", privateFailure ? undefined : record.previousMode],
    ["audit.label.newMode", privateFailure ? undefined : record.newMode],
    ["audit.label.setting", privateFailure ? undefined : record.settingType],
    ["audit.label.targetType", privateFailure ? undefined : record.targetType],
    ["audit.label.targetId", privateFailure ? undefined : record.targetId],
    ["audit.label.auditId", record.auditId],
  ];
  if (
    !safeIdentifier.test(record.guildId) ||
    fields.some(([, value]) => value !== undefined && !safeIdentifier.test(value)) ||
    (record.actorType === "USER") !== (record.actorUserId !== undefined) ||
    !Number.isFinite(record.occurredAt.getTime())
  ) {
    return undefined;
  }

  const content = [
    translate(locale, "audit.title"),
    ...fields.flatMap(([label, value]) =>
      value === undefined ? [] : [`${translate(locale, label)}: \`${value}\``],
    ),
    translate(locale, "audit.occurredAt", { when: record.occurredAt.toISOString() }),
  ].join("\n");
  if (content.length > 1800) return undefined;

  const nonce = `wa_${createHash("sha256")
    .update("weft:audit-notification:v1\0")
    .update(record.source)
    .update("\0")
    .update(record.auditId)
    .digest("base64url")
    .slice(0, 22)}`;
  return { content, nonce };
}
