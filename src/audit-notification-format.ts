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
  | "ADMINISTRATIVE_OPERATION_FAILURE";

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
): { content: string; nonce: string } | undefined {
  const privateFailure = record.source === "ADMINISTRATIVE_OPERATION_FAILURE";
  const fields: [string, string | undefined][] = [
    ["Source", record.source],
    ["Event", record.event],
    ["Outcome", record.outcome],
    ["Actor", record.actorType],
    ["Actor ID", record.actorUserId],
    ["Thread ID", privateFailure ? undefined : record.threadId],
    ["Channel ID", privateFailure ? undefined : record.channelId],
    ["Message ID", privateFailure ? undefined : record.messageId],
    ["Scheduled action ID", privateFailure ? undefined : record.scheduledActionId],
    ["Occurrence ID", privateFailure ? undefined : record.occurrenceId],
    ["Failure code", record.failureCode],
    ["Failure stage", record.failureStage],
    ["Skip reason", privateFailure ? undefined : record.skipReason],
    ["Previous destination ID", privateFailure ? undefined : record.previousDestinationId],
    ["New destination ID", privateFailure ? undefined : record.newDestinationId],
    ["Previous mode", privateFailure ? undefined : record.previousMode],
    ["New mode", privateFailure ? undefined : record.newMode],
    ["Setting", privateFailure ? undefined : record.settingType],
    ["Target type", privateFailure ? undefined : record.targetType],
    ["Target ID", privateFailure ? undefined : record.targetId],
    ["Audit ID", record.auditId],
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
    "WEFT audit",
    ...fields.flatMap(([label, value]) => (value === undefined ? [] : [`${label}: \`${value}\``])),
    `Occurred at: \`${record.occurredAt.toISOString()}\``,
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
