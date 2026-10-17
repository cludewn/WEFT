import { randomUUID } from "node:crypto";

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  InteractionEditReplyOptions,
} from "discord.js";

import { OperationTimeoutError, withTimeout } from "../operation-timeout.js";
import type { ScheduledMessageCommandService } from "./scheduled-message-command.js";

export const SCHEDULED_LIST_PREFIX = "sml:";
export const SCHEDULED_LIST_TTL_MS = 5 * 60_000;
export const SCHEDULED_LIST_CAPACITY = 128;
const IO_TIMEOUT_MS = 2_500;
const UNAVAILABLE = "WEFT could not load scheduled messages. Please try again later.";
const RESTART = "These list controls are unavailable. Run /message schedule list again.";
const DISPLAY_ERROR =
  "WEFT could not display the complete scheduled-message page safely. No schedules were displayed.";

type ListResult = Awaited<ReturnType<ScheduledMessageCommandService["list"]>>;
type Session = {
  id: string;
  userId: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  page: number;
  revision: number;
  hasNext: boolean;
  expiresAt: number;
  state: "INITIALIZING" | "IDLE" | "BUSY" | "RETIRED";
  // Ownership survives retirement until every raw operation of this invocation settles.
  operation: symbol | undefined;
};

export function parseScheduledListCustomId(
  value: string,
): { sessionId: string; revision: number; action: "previous" | "next" } | undefined {
  if (value.length > 100) return undefined;
  const match =
    /^sml:1:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(0|[1-9][0-9]*):(previous|next)$/.exec(
      value,
    );
  if (match === null || match[0] !== value) return undefined;
  const revision = Number(match[2]);
  if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER) return undefined;
  return { sessionId: match[1]!, revision, action: match[3] as "previous" | "next" };
}

function validPage(page: number): boolean {
  return Number.isSafeInteger(page) && page >= 1 && Number.isSafeInteger((page - 1) * 10);
}

function response(result: ListResult, page: number, session: Session, revision: number) {
  const content = scheduledMessageListMessage(result, page);
  const usable = result.outcome === "FOUND" && content !== DISPLAY_ERROR;
  const controls = usable && (page > 1 || result.schedules.length > 0);
  return {
    usable: controls,
    options: {
      content,
      allowedMentions: { parse: [] },
      components: controls
        ? [
            new ActionRowBuilder<ButtonBuilder>()
              .addComponents(
                new ButtonBuilder()
                  .setCustomId(`sml:1:${session.id}:${revision}:previous`)
                  .setLabel("Previous")
                  .setStyle(ButtonStyle.Secondary)
                  .setDisabled(page === 1),
                new ButtonBuilder()
                  .setCustomId(`sml:1:${session.id}:${revision}:next`)
                  .setLabel("Next")
                  .setStyle(ButtonStyle.Secondary)
                  .setDisabled(!result.hasNext || !validPage(page + 1)),
              )
              .toJSON(),
          ]
        : [],
    } satisfies InteractionEditReplyOptions,
  };
}

export type ScheduledMessageListNavigation = {
  start: (interaction: ChatInputCommandInteraction) => Promise<void>;
  navigate: (interaction: ButtonInteraction) => Promise<void>;
};

export function createScheduledMessageListNavigation(
  service: Pick<ScheduledMessageCommandService, "list">,
  options: { now?: () => number } = {},
): ScheduledMessageListNavigation {
  const now = options.now ?? Date.now;
  const sessions = new Map<string, Session>();
  function cleanup() {
    for (const [id, session] of sessions) {
      if (now() >= session.expiresAt) session.state = "RETIRED";
      if (session.state === "RETIRED" && session.operation === undefined) sessions.delete(id);
    }
  }
  function current(session: Session, operation: symbol, revision: number) {
    return (
      session.operation === operation &&
      session.state !== "RETIRED" &&
      session.revision === revision &&
      now() < session.expiresAt
    );
  }

  // All raw work is retained locally by its admitted handler, never in session metadata.
  async function perform(
    interaction: ChatInputCommandInteraction | ButtonInteraction,
    session: Session,
    operation: symbol,
    page: number,
    initial: boolean,
  ) {
    const retained: Promise<unknown>[] = [];
    async function observe<T>(work: () => Promise<T>, budget = IO_TIMEOUT_MS): Promise<T> {
      const started = performance.now();
      const raw = (async () => work())();
      retained.push(raw);
      const value = await withTimeout(raw, Math.max(0, budget));
      if (performance.now() - started >= budget) throw new OperationTimeoutError();
      return value;
    }
    const revision = session.revision;
    let ackConfirmed = false;
    let editAttempted = false;
    try {
      const ackBudget = Math.max(
        0,
        IO_TIMEOUT_MS - Math.max(0, Date.now() - interaction.createdTimestamp),
      );
      if (ackBudget === 0) throw new OperationTimeoutError();
      await observe(
        () =>
          initial
            ? (interaction as ChatInputCommandInteraction).deferReply({
                flags: MessageFlags.Ephemeral,
              })
            : (interaction as ButtonInteraction).deferUpdate(),
        ackBudget,
      );
      ackConfirmed = true;
      if (!current(session, operation, revision)) throw new Error("List session expired");
      const result = await observe(() =>
        service.list({
          guildId: session.guildId,
          channelId: session.channelId,
          page,
        }),
      );
      if (!current(session, operation, revision)) throw new Error("List session expired");
      if (!initial && result.outcome !== "FOUND") throw new Error("List read unavailable");
      const nextRevision = initial ? revision : revision + 1;
      const rendered = response(result, page, session, nextRevision);
      if (!current(session, operation, revision)) throw new Error("List session expired");
      // Reserve the next revision in the outgoing controls, while BUSY remains exclusive.
      editAttempted = true;
      const message = await observe(() => interaction.editReply(rendered.options));
      if (!current(session, operation, revision)) throw new Error("List session expired");
      if (
        typeof message.id !== "string" ||
        message.id.length === 0 ||
        (!initial && message.id !== session.messageId)
      )
        throw new Error("List response identity mismatch");
      session.messageId = message.id;
      session.page = page;
      session.revision = nextRevision;
      session.hasNext = result.outcome === "FOUND" && result.hasNext;
      session.state = rendered.usable ? "IDLE" : "RETIRED";
    } catch {
      session.state = "RETIRED";
      if (ackConfirmed) {
        try {
          if (initial && !editAttempted) {
            // The initial read failed before any message edit was attempted.
            await observe(() =>
              interaction.editReply({
                content: UNAVAILABLE,
                components: [],
                allowedMentions: { parse: [] },
              }),
            );
          } else if (!initial) {
            // Only Button follow-ups are safe here: a slash follow-up can edit the deferred
            // original. After an initial edit attempt, retire without any recovery write.
            await observe(() =>
              interaction.followUp({
                content: RESTART,
                flags: MessageFlags.Ephemeral,
                components: [],
                allowedMentions: { parse: [] },
              }),
            );
          }
        } catch {
          // Response loss is terminal for this session; no replay or second initial response.
        }
      }
    } finally {
      await Promise.allSettled(retained);
      session.operation = undefined;
      cleanup();
    }
  }

  async function reject(
    interaction: ButtonInteraction | ChatInputCommandInteraction,
    content = RESTART,
  ) {
    // One initial-response attempt, owned through raw settlement even after its wait expires.
    const raw = (async () =>
      interaction.reply({
        content,
        flags: MessageFlags.Ephemeral,
        components: [],
        allowedMentions: { parse: [] },
      }))();
    try {
      await withTimeout(raw, IO_TIMEOUT_MS);
    } catch {
      /* no retry */
    } finally {
      await Promise.allSettled([raw]);
    }
  }

  return {
    async start(interaction) {
      cleanup();
      if (sessions.size >= SCHEDULED_LIST_CAPACITY) {
        await reject(
          interaction,
          "WEFT cannot open another schedule list right now. Please try again later.",
        );
        return;
      }
      const operation = Symbol();
      const session: Session = {
        id: randomUUID(),
        userId: interaction.user.id,
        guildId: interaction.guildId!,
        channelId: interaction.channelId,
        messageId: null,
        page: 1,
        revision: 0,
        hasNext: false,
        expiresAt: now() + SCHEDULED_LIST_TTL_MS,
        state: "INITIALIZING",
        operation,
      };
      sessions.set(session.id, session);
      await perform(interaction, session, operation, 1, true);
    },
    async navigate(interaction) {
      cleanup();
      const target = parseScheduledListCustomId(interaction.customId);
      const session = target === undefined ? undefined : sessions.get(target.sessionId);
      if (
        !interaction.isButton() ||
        target === undefined ||
        session === undefined ||
        !interaction.inGuild() ||
        !interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ||
        session.userId !== interaction.user.id ||
        session.guildId !== interaction.guildId ||
        session.channelId !== interaction.channelId ||
        session.messageId !== interaction.message.id ||
        session.state !== "IDLE" ||
        session.operation !== undefined ||
        session.revision !== target.revision ||
        now() >= session.expiresAt ||
        (target.action === "previous" ? session.page <= 1 : !session.hasNext)
      ) {
        await reject(interaction);
        return;
      }
      const page = session.page + (target.action === "previous" ? -1 : 1);
      if (!validPage(page) || session.revision >= Number.MAX_SAFE_INTEGER - 1) {
        session.state = "RETIRED";
        await reject(interaction);
        return;
      }
      // Synchronous ownership acquisition before the first await. No queued navigation.
      const operation = Symbol();
      session.state = "BUSY";
      session.operation = operation;
      await perform(interaction, session, operation, page, false);
    },
  };
}
export function scheduleStateLabel(state: string): string {
  switch (state) {
    case "ACTIVE":
    case "PENDING":
    case "EXECUTING":
    case "RETRY_PENDING":
    case "CANCELLED":
    case "COMPLETED":
    case "FAILED":
    case "SKIPPED":
      return `**${state}**`;
    default:
      return "**UNKNOWN**";
  }
}

export function recurringTimeLabel(
  status: string,
  occurrence: string | null,
  compact = false,
): string {
  if (status === "CANCELLED") return compact ? "Historical" : "Historical scheduled time";
  if (occurrence === "PENDING") return compact ? "Next" : "Next scheduled occurrence";
  if (occurrence === null)
    return compact ? "Last materialized" : "Last materialized scheduled time";
  return compact ? "Current" : "Current occurrence scheduled time";
}

export function scheduledMessageListMessage(
  result: Awaited<ReturnType<ScheduledMessageCommandService["list"]>>,
  page: number,
): string {
  if (result.outcome === "INVALID_PAGE") return "Page must be a positive integer.";
  if (result.outcome === "UNAVAILABLE") {
    return "WEFT could not load scheduled messages. Please try again later.";
  }
  if (result.schedules.length === 0) {
    return `No active or executing scheduled messages were found on page ${page}.`;
  }
  if (result.schedules.some((schedule) => !Number.isFinite(schedule.executeAt.getTime()))) {
    return DISPLAY_ERROR;
  }
  const rows = result.schedules.map((schedule) => {
    const when = Math.floor(schedule.executeAt.getTime() / 1_000);
    const creator = `<@${schedule.creatorUserId}> \`${schedule.creatorUserId}\``;
    if ("kind" in schedule && schedule.kind === "RECURRING") {
      const label = recurringTimeLabel(schedule.status, schedule.currentOccurrenceStatus, true);
      const occurrence =
        schedule.currentOccurrenceStatus === null
          ? "none"
          : scheduleStateLabel(schedule.currentOccurrenceStatus);
      return `- \`${schedule.scheduledActionId}\` Recurring ${schedule.frequency === "DAILY" ? "daily" : "weekly"}\nSeries: ${scheduleStateLabel(schedule.status)} · Occurrence: ${occurrence}\n${label}: <t:${when}:F> · By ${creator}`;
    }
    return `- \`${schedule.scheduledActionId}\` One-time · ${scheduleStateLabel(schedule.status)}\n  Scheduled: <t:${when}:F> · By: ${creator}`;
  });
  const content = [
    `Scheduled messages — page ${page}`,
    ...rows,
    "/message schedule status id:<schedule-id>",
  ].join("\n");
  return content.length <= 2000 ? content : DISPLAY_ERROR;
}
