import { resolveLocale, translate, type AppLocale } from "../i18n/translate.js";
import {
  ButtonStyle,
  ChannelType,
  ChannelSelectMenuBuilder,
  ComponentType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  escapeMarkdown,
} from "discord.js";
import type {
  APIActionRowComponent,
  APIButtonComponent,
  APIStringSelectComponent,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  InteractionEditReplyOptions,
} from "discord.js";
import type { Logger } from "pino";

import { isSnowflake } from "../link-previews/link-preview.js";
import { OperationTimeoutError, withTimeout } from "../operation-timeout.js";
import { DEFAULT_INTERACTION_IO_TIMEOUT_MS } from "./thread-command.js";
import { DEFAULT_THREAD_LIFECYCLE_DEADLINE_MS } from "./thread-lifecycle.js";

import { BULK_PAGE_SIZE } from "./bulk-thread-close.js";
import type {
  BulkCloseCounts,
  BulkClosePreviewResult,
  BulkCloseService,
  BulkCloseSession,
  BulkCloseReadContext,
  BulkCloseReadStage,
} from "./bulk-thread-close.js";

export const BULK_COMPONENT_PREFIX = "btc:";
export const BULK_CONTROL_FAILURE = translate("en-US", "bulk.controlFailure");
export const BULK_PREPARATION_FAILURE = translate("en-US", "bulk.preparationFailure");
export const BULK_PREPARATION_MS = DEFAULT_THREAD_LIFECYCLE_DEADLINE_MS;
type PreviewPreparationOptions = {
  logger?: Pick<Logger, "debug" | "warn">;
  // The router retains raw work under the same admitted ingress operation after a caller timeout.
  retain?: (operation: Promise<unknown>) => void;
};
type PreviewPreparationStage =
  | BulkCloseReadStage
  | "acknowledgement"
  | "discovery"
  | "preparing_response"
  | "preview_queue"
  | "page_observation"
  | "candidate_render"
  | "candidate_update"
  | "validation_response"
  | "failure_response";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const customIdPattern = new RegExp(
  `^btc:(${UUID}):(setup|confirm|cancel|(?:page|previous|next|select|clear):[0-4]:[0-9]{1,6})$`,
);
export function parseBulkCloseCustomId(value: string) {
  const match = customIdPattern.exec(value);
  if (!match) return;
  const [action, page, revision] = match[2]!.split(":");
  return {
    id: match[1]!,
    action: action!,
    page: page === undefined ? undefined : Number(page),
    revision: revision === undefined ? undefined : Number(revision),
  };
}
function plainText(value: string, limit: number): string {
  const normalized = value
    .replace(/[\r\n\t\u0085\u2028\u2029]/g, " ")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/@/g, "@\u200b");
  let output = "";
  for (const character of normalized) {
    if (output.length + character.length > limit - 1) return output + "…";
    output += character.length === 1 && /[\uD800-\uDFFF]/.test(character) ? "�" : character;
  }
  return output;
}
function safeText(value: string, limit: number): string {
  // Escape every bracket, including repeated masked links and input cut inside link syntax.
  const escaped = escapeMarkdown(plainText(value, 4000))
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
  let output = "";
  for (const character of escaped) {
    if (output.length + character.length > limit - 1) return output.replace(/\\$/, "") + "…";
    // Invalid lone surrogates are never emitted.
    output += character.length === 1 && /[\uD800-\uDFFF]/.test(character) ? "�" : character;
  }
  return output;
}
export function renderBulkClosePage(
  view: NonNullable<Awaited<ReturnType<BulkCloseService["page"]>>>,
  locale: AppLocale = "en-US",
): InteractionEditReplyOptions {
  const { session, parent, threads, page, revision } = view;
  const pageCount = Math.ceil(session.candidateIds.length / BULK_PAGE_SIZE);
  const filterLines = [
    ...(session.filters.nameContains === undefined
      ? []
      : [
          translate(locale, "bulk.nameFilter", {
            name: safeText(session.filters.nameContains, 160),
          }),
        ]),
    ...(session.filters.ownerId === undefined
      ? []
      : [translate(locale, "bulk.ownerFilter", { id: session.filters.ownerId })]),
    ...(session.filters.creationAgeMs === undefined
      ? []
      : [
          translate(locale, "bulk.ageFilter", {
            minutes: session.filters.creationAgeMs / 60_000,
            cutoff: Math.floor(session.filters.creationCutoff! / 1000),
          }),
        ]),
  ];
  const button = (
    action: string,
    label: string,
    style: ButtonStyle.Secondary | ButtonStyle.Danger,
    disabled = false,
  ): APIButtonComponent => ({
    type: ComponentType.Button,
    custom_id: `${BULK_COMPONENT_PREFIX}${session.id}:${action}`,
    label,
    style,
    disabled,
  });
  const pageIds = session.candidateIds.slice(page * BULK_PAGE_SIZE, (page + 1) * BULK_PAGE_SIZE);
  const components: APIActionRowComponent<APIButtonComponent | APIStringSelectComponent>[] = [
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          custom_id: `${BULK_COMPONENT_PREFIX}${session.id}:select:${page}:${revision}`,
          placeholder: translate(locale, "bulk.selectPlaceholder"),
          min_values: 0,
          max_values: pageIds.length,
          options: pageIds.map((id, index) => ({
            label: threads[index]
              ? plainText(threads[index].name, 100) || translate(locale, "bulk.unnamedThread")
              : translate(locale, "bulk.targetUnavailable"),
            description: plainText(
              translate(locale, "bulk.candidate", { ordinal: page * BULK_PAGE_SIZE + index + 1 }),
              100,
            ),
            value: id,
            default: session.selectedIds.has(id),
          })),
        },
      ],
    },
    {
      type: ComponentType.ActionRow,
      components: [
        button(
          `previous:${Math.max(0, page - 1)}:${revision}`,
          translate(locale, "bulk.previous"),
          ButtonStyle.Secondary,
          page === 0,
        ),
        button(
          `next:${Math.min(pageCount - 1, page + 1)}:${revision}`,
          translate(locale, "bulk.next"),
          ButtonStyle.Secondary,
          page === pageCount - 1,
        ),
        button(
          `clear:${page}:${revision}`,
          translate(locale, "bulk.clearPage"),
          ButtonStyle.Secondary,
        ),
        button(
          "confirm",
          translate(locale, "bulk.confirm"),
          ButtonStyle.Danger,
          session.selectedIds.size === 0,
        ),
        button("cancel", translate(locale, "bulk.cancel"), ButtonStyle.Secondary),
      ],
    },
  ];
  return {
    content: translate(locale, "bulk.selectionGuidance"),
    allowedMentions: { parse: [] },
    components,
    embeds: [
      {
        title: translate(locale, "bulk.title"),
        description: threads
          .map((thread, index) => {
            const ordinal = page * BULK_PAGE_SIZE + index + 1;
            return thread && isSnowflake(session.guildId) && isSnowflake(thread.threadId)
              ? translate(locale, "bulk.threadLink", {
                  ordinal,
                  name: safeText(thread.name, 180),
                  guildId: session.guildId,
                  threadId: thread.threadId,
                })
              : translate(locale, "bulk.unavailableThread", { ordinal });
          })
          .join("\n"),
        fields: [
          { name: translate(locale, "bulk.parent"), value: safeText(parent.name, 160) },
          {
            name: translate(locale, "bulk.conditions"),
            value: filterLines.join("\n") || translate(locale, "bulk.noFilters"),
          },
          {
            name: translate(locale, "bulk.beforeConfirm"),
            value: [
              translate(locale, "bulk.closeWarning"),
              translate(locale, "bulk.cancelWarning"),
              translate(locale, "bulk.partialWarning"),
              translate(locale, "bulk.snapshotWarning"),
            ].join("\n"),
          },
          {
            name: translate(locale, "bulk.expires"),
            value: `<t:${Math.floor(session.expiresAt / 1000)}:F>`,
          },
        ],
        footer: {
          text: translate(locale, "bulk.footer", {
            page: page + 1,
            pages: pageCount,
            candidates: session.candidateIds.length,
            selected: session.selectedIds.size,
          }),
        },
      },
    ],
  };
}
export function renderBulkCloseCounts(
  counts: BulkCloseCounts,
  locale: AppLocale = "en-US",
): string {
  return translate(locale, "bulk.result", counts);
}
const failureMessageKeys = {
  INVALID_FILTER: "bulk.invalidFilter",
  UNAVAILABLE: "bulk.unavailable",
  EMPTY: "bulk.empty",
  TOO_MANY: "bulk.tooMany",
  CAPACITY: "bulk.capacity",
} as const satisfies Record<Extract<BulkClosePreviewResult, { ok: false }>["reason"], string>;
export function buildBulkCloseModal(ticket: string, locale: AppLocale = "en-US"): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${BULK_COMPONENT_PREFIX}${ticket}:setup`)
    .setTitle(translate(locale, "bulk.setupTitle"))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(translate(locale, "bulk.parent"))
        .setChannelSelectMenuComponent(
          new ChannelSelectMenuBuilder()
            .setCustomId("parent")
            .setRequired(true)
            .setMinValues(1)
            .setMaxValues(1)
            .setChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
              ChannelType.GuildForum,
            ),
        ),
      new LabelBuilder()
        .setLabel(translate(locale, "bulk.owner"))
        .setUserSelectMenuComponent(
          new UserSelectMenuBuilder()
            .setCustomId("owner")
            .setRequired(false)
            .setMinValues(0)
            .setMaxValues(1),
        ),
      new LabelBuilder()
        .setLabel(translate(locale, "bulk.nameContains"))
        .setDescription(translate(locale, "bulk.nameDescription"))
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("name")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(100),
        ),
      new LabelBuilder()
        .setLabel(translate(locale, "bulk.createdOlder"))
        .setDescription(translate(locale, "bulk.ageDescription"))
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("age")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(32),
        ),
    );
}
export async function handleBulkCloseCommand(
  interaction: ChatInputCommandInteraction,
  service: BulkCloseService,
): Promise<void> {
  const locale = resolveLocale(interaction.locale);
  const ticket =
    interaction.inGuild() && interaction.memberPermissions?.has(PermissionFlagsBits.ManageThreads)
      ? service.createSetup(interaction.guildId, interaction.user.id)
      : undefined;
  if (!ticket) {
    await interaction.reply({
      content: translate(locale, "bulk.controlFailure"),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }
  await interaction.showModal(buildBulkCloseModal(ticket, locale));
}
function selectedModalIds(value: unknown, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    throw new Error("Invalid selected values");
  const values: readonly unknown[] = value;
  return values.map((id) => {
    if (typeof id !== "string" || !isSnowflake(id)) throw new Error("Invalid selected ID");
    return id;
  });
}
export function parseBulkCloseModal(interaction: ModalSubmitInteraction) {
  const parentField = interaction.fields.getField("parent");
  const ownerField = interaction.fields.getField("owner");
  if (
    parentField.type !== ComponentType.ChannelSelect ||
    ownerField.type !== ComponentType.UserSelect ||
    !("values" in parentField) ||
    !("values" in ownerField)
  )
    throw new Error("Invalid select fields");
  const parent = selectedModalIds(parentField.values, 1, 1);
  const owner = selectedModalIds(ownerField.values, 0, 1);
  const nameContains = interaction.fields.getTextInputValue("name");
  const creationAge = interaction.fields.getTextInputValue("age");
  if (
    typeof nameContains !== "string" ||
    nameContains.length > 100 ||
    typeof creationAge !== "string" ||
    creationAge.length > 32
  )
    throw new Error("Invalid modal fields");
  return {
    parentId: parent[0]!,
    input: { nameContains, creationAge, ...(owner[0] === undefined ? {} : { ownerId: owner[0] }) },
  };
}
export async function handleBulkCloseModal(
  interaction: ModalSubmitInteraction,
  service: BulkCloseService,
  { logger, retain }: PreviewPreparationOptions = {},
): Promise<void> {
  const locale = resolveLocale(interaction.locale);
  const controller = new AbortController();
  let session: BulkCloseSession | undefined;
  let acknowledged = false;
  let deadline = Date.now() + BULK_PREPARATION_MS;
  async function boundary<T>(
    stage: PreviewPreparationStage,
    work: () => Promise<T>,
    io = false,
    recovery = false,
  ): Promise<T> {
    const startedAt = Date.now();
    logger?.debug(
      { event: "bulk_preview_boundary_started", stage },
      "Bulk preview boundary started",
    );
    try {
      if (!recovery && controller.signal.aborted)
        throw new Error("Bulk preview preparation stopped");
      const remaining = deadline - Date.now();
      if (!recovery && remaining <= 0) throw new OperationTimeoutError();
      const raw = work();
      retain?.(raw);
      const result = await withTimeout(
        raw,
        recovery
          ? DEFAULT_INTERACTION_IO_TIMEOUT_MS
          : Math.min(remaining, io ? DEFAULT_INTERACTION_IO_TIMEOUT_MS : BULK_PREPARATION_MS),
      );
      logger?.debug(
        { event: "bulk_preview_boundary_completed", stage, durationMs: Date.now() - startedAt },
        "Bulk preview boundary completed",
      );
      return result;
    } catch (error) {
      logger?.warn(
        {
          event: "bulk_preview_boundary_failed",
          stage,
          failureCode: error instanceof OperationTimeoutError ? "TIMEOUT" : "FAILED",
          durationMs: Date.now() - startedAt,
        },
        "Bulk preview boundary failed",
      );
      throw error;
    }
  }
  const context: BulkCloseReadContext = {
    signal: controller.signal,
    read: (stage, work) => boundary(stage, work),
  };
  try {
    await boundary(
      "acknowledgement",
      () => interaction.deferReply({ flags: MessageFlags.Ephemeral }),
      true,
    );
    acknowledged = true;
    deadline = Date.now() + BULK_PREPARATION_MS;
    const parsed = parseBulkCloseCustomId(interaction.customId);
    if (
      !parsed ||
      parsed.action !== "setup" ||
      !interaction.guildId ||
      !service.consumeSetup(parsed.id, interaction.guildId, interaction.user.id)
    ) {
      await boundary(
        "validation_response",
        () =>
          interaction.editReply({
            content: translate(locale, "bulk.controlFailure"),
            allowedMentions: { parse: [] },
          }),
        true,
      );
      return;
    }
    let payload: ReturnType<typeof parseBulkCloseModal>;
    try {
      payload = parseBulkCloseModal(interaction);
    } catch {
      await boundary(
        "validation_response",
        () =>
          interaction.editReply({
            content: translate(locale, "bulk.invalidSetup"),
            allowedMentions: { parse: [] },
          }),
        true,
      );
      return;
    }
    const guildId = interaction.guildId;
    const result = await boundary("discovery", () =>
      service.preview(guildId, payload.parentId, interaction.user.id, payload.input, context),
    );
    if (!result.ok) {
      if (result.reason === "UNAVAILABLE") throw new Error("Bulk preview observation unavailable");
      await boundary(
        "validation_response",
        () =>
          interaction.editReply({
            content: translate(locale, failureMessageKeys[result.reason]),
            allowedMentions: { parse: [] },
          }),
        true,
      );
      return;
    }
    session = result.session;
    const message = await boundary(
      "preparing_response",
      () =>
        interaction.editReply({
          content: translate(locale, "bulk.preparing"),
          allowedMentions: { parse: [] },
        }),
      true,
    );
    service.bind(session, message.id);
    const preview = session;
    await boundary("preview_queue", () =>
      service.updatePreview(preview, async () => {
        // Refresh authorization only after preceding raw message writes, without reentering responseTail.
        const view = await boundary("page_observation", () =>
          service.page(
            preview.id,
            { guildId, actorId: interaction.user.id, messageId: message.id },
            0,
            undefined,
            context,
          ),
        );
        if (!view) throw new Error("Bulk preview page unavailable");
        const rendered = await boundary("candidate_render", () =>
          Promise.resolve(renderBulkClosePage(view, locale)),
        );
        await boundary(
          "candidate_update",
          () => {
            if (
              service.findPreview(preview.id, {
                guildId,
                actorId: interaction.user.id,
                messageId: message.id,
              }) !== preview ||
              preview.revision !== view.revision
            )
              throw new Error("Bulk preview page no longer current");
            return interaction.editReply(rendered);
          },
          true,
        );
      }),
    );
  } catch {
    controller.abort();
    if (session) service.discardPreview(session);
    if (acknowledged) {
      // Never enqueue failure behind the renderer that may be waiting on raw REST work.
      // discord.js still serializes the webhook requests; late controls have no live session.
      try {
        await boundary(
          "failure_response",
          () =>
            interaction.editReply({
              content: translate(locale, "bulk.preparationFailure"),
              embeds: [],
              components: [],
              allowedMentions: { parse: [] },
            }),
          true,
          true,
        );
      } catch {
        // A bounded write failure is logged; delivery cannot be guaranteed when Discord is unavailable.
      }
    }
  }
}
export async function handleBulkCloseButton(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  service: BulkCloseService,
): Promise<void> {
  await interaction.deferUpdate(); // Acknowledge before any current REST authorization.
  const locale = resolveLocale(interaction.locale);
  const parsed = parseBulkCloseCustomId(interaction.customId);
  const fail = () =>
    interaction.followUp({
      content: translate(locale, "bulk.controlFailure"),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  if (!parsed || !interaction.guildId) {
    await fail();
    return;
  }
  const identity = {
    guildId: interaction.guildId,
    actorId: interaction.user.id,
    messageId: interaction.message.id,
  };
  if (["page", "previous", "next", "select", "clear"].includes(parsed.action)) {
    let session = service.findPreview(parsed.id, identity);
    if (
      !session ||
      parsed.page === undefined ||
      parsed.revision === undefined ||
      (parsed.action === "select" && !interaction.isStringSelectMenu()) ||
      (parsed.action !== "select" && !interaction.isButton())
    ) {
      await fail();
      return;
    }
    const page = parsed.page;
    const navigation = ["page", "previous", "next"].includes(parsed.action);
    if (!navigation) {
      session = service.select(
        parsed.id,
        identity,
        page,
        parsed.revision,
        parsed.action === "clear" ? [] : (interaction as StringSelectMenuInteraction).values,
      );
      if (!session) {
        await fail();
        return;
      }
    }
    const revision = navigation ? parsed.revision : session.revision;
    await service.updatePreview(session, async () => {
      const view = await service.page(parsed.id, identity, page, revision);
      if (view) await interaction.editReply(renderBulkClosePage(view, locale));
      else await fail();
    });
    return;
  }
  if (!interaction.isButton()) {
    await fail();
    return;
  }
  const confirmed =
    parsed.action === "confirm" ? await service.confirm(parsed.id, identity) : undefined;
  const session =
    confirmed?.session ??
    (parsed.action === "cancel" ? service.cancel(parsed.id, identity) : undefined);
  if (!session) {
    await fail();
    return;
  }
  const clear = service.updatePreview(
    session,
    () =>
      interaction.editReply({
        content: confirmed
          ? translate(locale, "bulk.confirmed")
          : translate(locale, "bulk.cancelled"),
        embeds: [],
        components: [],
        allowedMentions: { parse: [] },
      }),
    true,
  );
  // Keep both promises under ingress ownership, but do not delay the separate aggregate reply
  // behind a raw page edit or cancellation-preparation/finalization that remains unresolved.
  const response = (async () => {
    const content = confirmed
      ? renderBulkCloseCounts(await confirmed.result, locale)
      : translate(locale, "bulk.cancelledNoWork");
    await interaction.followUp({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  })();
  const results = await Promise.allSettled([clear, response]);
  if (results.some((result) => result.status === "rejected"))
    throw new Error("Bulk close interaction response unconfirmed");
}
