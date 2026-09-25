import { createHash } from "node:crypto";

export type AuditSource =
  | "THREAD"
  | "SCHEDULED_THREAD_CLOSE"
  | "MANAGED_MESSAGE"
  | "SCHEDULED_MESSAGE"
  | "RECURRING_MESSAGE"
  | "AUDIT_LOG_DESTINATION";

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
  skipReason?: string;
  previousDestinationId?: string;
  newDestinationId?: string;
};

const safeIdentifier = /^[A-Za-z0-9_-]{1,64}$/;

export function formatAuditNotification(
  record: AuditNotificationRecord,
): { content: string; nonce: string } | undefined {
  const fields: [string, string | undefined][] = [
    ["Source", record.source],
    ["Event", record.event],
    ["Outcome", record.outcome],
    ["Actor", record.actorType],
    ["Actor ID", record.actorUserId],
    ["Thread ID", record.threadId],
    ["Channel ID", record.channelId],
    ["Message ID", record.messageId],
    ["Scheduled action ID", record.scheduledActionId],
    ["Occurrence ID", record.occurrenceId],
    ["Failure code", record.failureCode],
    ["Skip reason", record.skipReason],
    ["Previous destination ID", record.previousDestinationId],
    ["New destination ID", record.newDestinationId],
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
