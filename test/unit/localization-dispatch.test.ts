import { ChannelType, ComponentType, Events, MessageFlags } from "discord.js";
import type { Interaction, InteractionEditReplyOptions } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { ApplicationIngress } from "../../src/application-runtime.js";
import type { CommandDependencies } from "../../src/commands.js";
import {
  createDiscordClient,
  registerDiscordCommandHandler,
  registerManagedMessageModalHandler,
  type DiscordDependencies,
} from "../../src/discord.js";
import { createScheduledMessageListNavigation } from "../../src/messages/scheduled-message-list.js";
import {
  MANAGED_MESSAGE_SEND_MODAL_ID,
  MANAGED_MESSAGE_CONTENT_INPUT_ID,
  createManagedMessageEditModal,
  createScheduledMessageCreateModalId,
  createScheduledMessageEditModalId,
  createRecurringMessageCreateModalId,
} from "../../src/messages/message-command.js";
import type { ScheduledMessageCommandService } from "../../src/messages/scheduled-message-command.js";
import {
  createThreadLifecycleService,
  type ThreadLifecycleDiscord,
} from "../../src/threads/thread-lifecycle.js";
import type { ManagedThread } from "../../src/threads/thread-persistence.js";

const guildId = "123456789012345678";
const channelId = "123456789012345679";
const actorId = "123456789012345680";
const messageId = "123456789012345681";
const scheduleId = "11111111-1111-4111-8111-111111111111";
const ticket = "22222222-2222-4222-8222-222222222222";
const when = new Date("2030-01-01T00:00:00Z");
const payload = { content: "User-authored 🌸 **content**", embed: null };

function fixture() {
  const logger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  const client = createDiscordClient(logger, {} as DiscordDependencies);
  const rest = [
    vi.spyOn(client.rest, "get"),
    vi.spyOn(client.rest, "post"),
    vi.spyOn(client.rest, "patch"),
    vi.spyOn(client.rest, "delete"),
  ];
  const admitted: Promise<unknown>[] = [];
  const ingress: ApplicationIngress = {
    run: <T>(operation: () => T | Promise<T>) => {
      const result = Promise.resolve().then(operation);
      admitted.push(result);
      return result;
    },
  };
  const managed = {
    send: vi.fn().mockResolvedValue({ outcome: "SUCCESS", messageId }),
    edit: vi.fn().mockResolvedValue({ outcome: "UNCHANGED", messageId }),
    findForEdit: vi.fn().mockResolvedValue({ outcome: "FOUND", messageId, revision: 1, payload }),
  };
  const definition = {
    action: { id: scheduleId, targetId: channelId, executeAt: when },
    payload,
    revision: 1,
  };
  const scheduled = {
    create: vi
      .fn()
      .mockResolvedValue({ outcome: "SUCCESS", definition, deliveryPendingReconciliation: true }),
    createRecurring: vi.fn().mockResolvedValue({
      outcome: "SUCCESS",
      scheduledActionId: scheduleId,
      scheduledFor: when,
      deliveryPendingReconciliation: true,
    }),
    edit: vi.fn().mockResolvedValue({ outcome: "EDITED", kind: "RECURRING", definition }),
    findEditable: vi.fn().mockResolvedValue({ outcome: "ACTIVE", definition }),
    cancel: vi
      .fn()
      .mockResolvedValue({ outcome: "CANCELLED", kind: "RECURRING", deliveryCleanupPending: true }),
    reschedule: vi.fn().mockResolvedValue({
      outcome: "RESCHEDULED",
      definition,
      deliveryPendingReconciliation: true,
    }),
    editRecurrence: vi.fn().mockResolvedValue({
      outcome: "COMMITTED",
      effect: { deferredMaterialization: true },
      deliveryPendingReconciliation: true,
    }),
    status: vi.fn().mockResolvedValue({
      outcome: "FOUND",
      schedule: {
        scheduledActionId: scheduleId,
        status: "EXECUTING",
        executeAt: when,
        creatorUserId: actorId,
        channelId,
        guildId,
        retryCount: 2,
        resultMessageId: null,
      },
    }),
    list: vi.fn<ScheduledMessageCommandService["list"]>().mockResolvedValue({
      outcome: "FOUND",
      hasNext: true,
      schedules: [
        {
          scheduledActionId: scheduleId,
          status: "ACTIVE",
          executeAt: when,
          creatorUserId: actorId,
        },
      ],
    }),
  };
  const close = {
    closeManually: vi
      .fn()
      .mockResolvedValue({ outcome: "LIFECYCLE", result: { ok: true, changed: true } }),
    schedule: vi.fn().mockResolvedValue({
      ok: true,
      outcome: "CREATED",
      action: { id: scheduleId, executeAt: when },
    }),
    cancel: vi.fn().mockResolvedValue({ ok: true, outcome: "NOT_SCHEDULED" }),
  };
  const lifecycle = { open: vi.fn().mockResolvedValue({ ok: true, changed: true }) };
  const maintenance = {
    track: vi.fn().mockResolvedValue({ ok: true, outcome: "TRACKED", parentEnabled: false }),
    untrack: vi.fn().mockResolvedValue({ ok: true, outcome: "EXCLUDED" }),
    status: vi.fn().mockResolvedValue({
      ok: true,
      status: {
        lastActivityAt: null,
        scheduledClose: undefined,
        effectiveEnabled: false,
        parentEnabled: false,
        excluded: true,
        inactivitySeconds: 604800,
      },
    }),
  };
  const session = {
    id: ticket,
    guildId,
    revision: 0,
    expiresAt: when.getTime(),
    candidateIds: [channelId],
    selectedIds: new Set([channelId]),
    filters: {},
  };
  const view = {
    session,
    parent: { name: "User parent" },
    threads: [{ threadId: channelId, name: "User thread 🌸" }],
    page: 0,
    revision: 0,
  };
  const counts = {
    selected: 1,
    attempted: 1,
    closed: 0,
    alreadyClosed: 0,
    pending: 1,
    failed: 0,
    skipped: 0,
  };
  const bulk = {
    createSetup: vi.fn().mockReturnValue(ticket),
    consumeSetup: vi.fn().mockReturnValue(true),
    preview: vi.fn().mockResolvedValue({ ok: true, session }),
    bind: vi.fn(),
    page: vi.fn().mockResolvedValue(view),
    findPreview: vi.fn().mockReturnValue(session),
    select: vi.fn().mockReturnValue(session),
    updatePreview: vi.fn(async (_session: unknown, work: () => Promise<unknown>) => work()),
    confirm: vi.fn().mockResolvedValue({ session, result: Promise.resolve(counts) }),
    cancel: vi.fn().mockReturnValue(session),
    discardPreview: vi.fn(),
  };
  const settings = {
    guildId,
    timezone: "Asia/Tokyo",
    closedPrefix: "",
    auditLogChannelId: null,
    linkPreviewMode: "off",
  };
  const previewSet = vi.fn().mockResolvedValue({ outcome: "NO_CHANGE" });
  const deps = {
    guildSettings: {
      getOrCreate: vi.fn().mockResolvedValue(settings),
      setTimezone: vi.fn().mockResolvedValue({ outcome: "NO_CHANGE", settings }),
      disableClosedPrefix: vi.fn().mockResolvedValue({ outcome: "NO_CHANGE", settings }),
      setClosedPrefix: vi.fn(),
    },
    linkPreview: {
      show: vi.fn().mockResolvedValue("off"),
      set: previewSet,
    },
    automaticCloseConfiguration: {
      show: vi.fn().mockResolvedValue({
        inactivitySeconds: 604800,
        botMessagesCountAsActivity: false,
        parentChannelIds: [],
      }),
    },
    auditLogDestination: { show: vi.fn().mockResolvedValue(null) },
    managedMessages: managed,
    scheduledMessages: scheduled,
    scheduledMessageLists: createScheduledMessageListNavigation(scheduled),
    threadLifecycle: lifecycle,
    automaticCloseMaintenance: maintenance,
    scheduledThreadClose: close,
    bulkClose: bulk,
    logger,
  } as unknown as CommandDependencies;
  registerDiscordCommandHandler(client, deps, ingress);
  registerManagedMessageModalHandler(
    client,
    deps.managedMessages,
    deps.scheduledMessages,
    logger,
    ingress,
  );
  function interaction(
    locale: string,
    command = "message",
    group: string | null = null,
    subcommand = "send",
    strings: Record<string, string | null> = {},
  ) {
    return {
      locale,
      guildLocale: locale === "ja" ? "en-US" : "ja",
      createdTimestamp: Date.now(),
      commandName: command,
      customId: "",
      guildId,
      channelId,
      user: { id: actorId },
      channel: { type: ChannelType.GuildText, isThread: () => false },
      message: { id: "response-id" },
      inGuild: () => true,
      memberPermissions: { has: () => true },
      isChatInputCommand: () => true,
      isButton: () => false,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      options: {
        getSubcommand: () => subcommand,
        getSubcommandGroup: () => group,
        getString: (name: string) => (name in strings ? strings[name] : null),
      },
      fields: {
        getTextInputValue: (name: string) =>
          name === MANAGED_MESSAGE_CONTENT_INPUT_ID ? payload.content : "",
        getField: (name: string) => ({
          type: name === "parent" ? ComponentType.ChannelSelect : ComponentType.UserSelect,
          values: name === "parent" ? [channelId] : [],
        }),
      },
      reply: vi.fn().mockResolvedValue(undefined),
      deferReply: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi
        .fn<(options: InteractionEditReplyOptions) => Promise<{ id: string }>>()
        .mockResolvedValue({ id: "response-id" }),
      showModal: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
    };
  }
  async function dispatch(value: ReturnType<typeof interaction>) {
    client.emit(Events.InteractionCreate, value as unknown as Interaction);
    return Promise.all(admitted.splice(0));
  }
  async function finish() {
    for (const method of rest) expect(method).not.toHaveBeenCalled();
    await client.destroy();
  }
  return {
    client,
    previewSet,
    logger,
    managed,
    scheduled,
    close,
    lifecycle,
    maintenance,
    bulk,
    deps,
    interaction,
    dispatch,
    finish,
  };
}

function modal(f: ReturnType<typeof fixture>, locale: string, customId: string) {
  const value = f.interaction(locale);
  value.customId = customId;
  value.isChatInputCommand = () => false;
  value.isModalSubmit = () => true;
  return value;
}
function content(value: ReturnType<ReturnType<typeof fixture>["interaction"]>) {
  expect(value.editReply).toHaveBeenCalledOnce();
  expect(value.editReply.mock.calls[0]![0].allowedMentions).toEqual({ parse: [] });
  expect(value.editReply.mock.calls[0]![0].content!.length).toBeLessThanOrEqual(2000);
  return value.editReply.mock.calls[0]![0].content;
}

function activeThreadLifecycle(
  f: ReturnType<typeof fixture>,
  mode: "missing" | "open" | "state-only" | "prefix" = "prefix",
  held?: "mutation" | "state" | "audit",
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let state: ManagedThread | undefined =
    mode === "missing"
      ? undefined
      : {
          guildId,
          threadId: channelId,
          appliedPrefix: mode === "state-only" ? "" : "[CLOSED]",
          lifecycleState: mode === "open" ? "OPEN" : "CLOSED",
          createdAt: when,
          updatedAt: when,
        };
  const thread = {
    guildId,
    threadId: channelId,
    type: ChannelType.PublicThread as const,
    name: mode === "prefix" ? "[CLOSED] topic" : "topic",
    archived: false,
    locked: false,
  };
  const rename = vi.fn(async (_guild: string, _thread: string, name: string) => {
    if (held === "mutation") await gate;
    thread.name = name;
  });
  const archive = vi.fn();
  const markOpen = vi.fn(async () => {
    if (held === "state") await gate;
    if (!state) throw new Error("Unexpected missing managed record");
    state = { ...state, lifecycleState: "OPEN" };
    return state;
  });
  const audit = vi.fn(async () => {
    if (held === "audit") await gate;
  });
  const service = createThreadLifecycleService({
    discord: {
      fetchThread: () => Promise.resolve({ ...thread }),
      actorCanManage: () => Promise.resolve(true),
      botCanManage: () => Promise.resolve(true),
      renameThread: rename,
      archiveThread: archive,
      classifyMutationFailure: () => "RETRYABLE",
      classifyReconciliationReadFailure: () => "RETRYABLE",
    } satisfies ThreadLifecycleDiscord,
    guildSettings: f.deps.guildSettings,
    managedThreads: { find: () => Promise.resolve(state), markOpen, saveClosed: vi.fn() },
    audits: { record: audit },
    logger: f.logger,
    deadlineMs: 1000,
    mutationWaitMs: 5,
    reconciliationRetryBaseMs: 1,
    reconciliationRetryMaxMs: 1,
  });
  f.deps.threadLifecycle = service;
  return { service, rename, archive, markOpen, audit, release, thread, state: () => state };
}

describe.each(["en-US", "ja"])("complete localization dispatch (%s)", (locale) => {
  it.each(["missing", "open", "state-only", "prefix"] as const)(
    "describes open with %s state using the real lifecycle without unarchiving",
    async (mode) => {
      const f = fixture();
      const actual = activeThreadLifecycle(f, mode);
      try {
        const value = f.interaction(locale, "thread", null, "open");
        await f.dispatch(value);
        const changed = mode === "state-only" || mode === "prefix";
        expect(content(value)).toBe(
          locale === "ja"
            ? changed
              ? "開いているスレッドの状態をWEFTに反映しました。"
              : "スレッドは開いています。変更はありません。"
            : changed
              ? "Updated WEFT's state for this active thread."
              : "This thread is active. No changes were needed.",
        );
        expect(actual.archive).not.toHaveBeenCalled();
        expect(actual.rename).toHaveBeenCalledTimes(mode === "prefix" ? 1 : 0);
        expect(actual.markOpen).toHaveBeenCalledTimes(changed ? 1 : 0);
        expect(actual.audit).toHaveBeenCalledOnce();
        expect(actual.thread).toMatchObject({ name: "topic", archived: false });
        expect(actual.state()?.lifecycleState).toBe(mode === "missing" ? undefined : "OPEN");
      } finally {
        actual.release();
        await actual.service.drain();
        await f.finish();
      }
    },
  );

  it.each(["mutation", "state", "audit"] as const)(
    "describes real PENDING at the %s boundary without assigning all waiting to Discord",
    async (held) => {
      const f = fixture();
      const actual = activeThreadLifecycle(f, "prefix", held);
      try {
        const value = f.interaction(locale, "thread", null, "open");
        await f.dispatch(value);
        expect(content(value)).toBe(
          locale === "ja"
            ? "WEFTが処理や結果確認を続けています。Discordのレート制限などで数分かかる場合があります。"
            : "WEFT is still processing or confirming this operation. Discord rate limits may delay completion by several minutes.",
        );
        expect(actual.rename).toHaveBeenCalledOnce();
        actual.release();
        await actual.service.drain();
        expect(actual.rename).toHaveBeenCalledOnce();
        expect(actual.markOpen).toHaveBeenCalledOnce();
        expect(actual.audit).toHaveBeenCalledOnce();
        expect(actual.archive).not.toHaveBeenCalled();
        expect(value.editReply).toHaveBeenCalledOnce();
        expect(value.followUp).not.toHaveBeenCalled();
      } finally {
        actual.release();
        await actual.service.drain();
        await f.finish();
      }
    },
  );
  it.each([
    [
      "config",
      "link-preview",
      "mode",
      "Link preview mode: Off (unchanged)",
      "リンクプレビューモード: オフ（変更なし）",
    ],
    [
      "config",
      "closed-prefix",
      "disable",
      "The closed prefix is already disabled.",
      "クローズ用プレフィックスはすでに無効です。",
    ],
    ["thread", null, "close", "Thread closed.", "スレッドを閉じました。"],
    [
      "thread",
      null,
      "open",
      "Updated WEFT's state for this active thread.",
      "開いているスレッドの状態をWEFTに反映しました。",
    ],
    ["thread", null, "cancel-close", "No thread close is scheduled.", "予約クローズはありません。"],
  ] as const)(
    "localizes /%s %s %s without changing service or reply ownership",
    async (command, group, subcommand, en, ja) => {
      const f = fixture();
      try {
        const value = f.interaction(locale, command, group, subcommand, { value: "off" });
        await f.dispatch(value);
        expect(content(value)).toBe(locale === "ja" ? ja : en);
        expect(value.followUp).not.toHaveBeenCalled();
        expect(value.showModal).not.toHaveBeenCalled();
        if (command === "thread") {
          expect(value.reply).toHaveBeenCalledOnce();
          expect(value.reply.mock.calls[0]).toMatchObject([
            { flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } },
          ]);
        } else
          expect(value.deferReply).toHaveBeenCalledExactlyOnceWith({
            flags: MessageFlags.Ephemeral,
          });
        const service =
          subcommand === "mode"
            ? f.previewSet
            : subcommand === "disable"
              ? f.deps.guildSettings.disableClosedPrefix
              : subcommand === "close"
                ? f.close.closeManually
                : subcommand === "open"
                  ? f.lifecycle.open
                  : f.close.cancel;
        expect(service).toHaveBeenCalledOnce();
      } finally {
        await f.finish();
      }
    },
  );

  it("localizes thread tracking, status and a saved close awaiting delivery confirmation", async () => {
    const f = fixture();
    try {
      const track = f.interaction(locale, "thread", null, "track");
      await f.dispatch(track);
      expect(content(track)).toBe(
        locale === "ja"
          ? "除外設定を解除しました。親チャンネルの自動クローズが無効なため、このスレッドは対象外です。"
          : "Exclusion removed. Automatic close is still disabled for the parent channel.",
      );
      const status = f.interaction(locale, "thread", null, "status");
      await f.dispatch(status);
      expect(content(status)).toContain(
        locale === "ja" ? "除外設定: あり" : "Thread exclusion: set",
      );
      f.close.schedule.mockResolvedValue({
        ok: true,
        outcome: "SAVED_DELIVERY_PENDING",
        action: { id: scheduleId, executeAt: when },
      });
      const scheduled = f.interaction(locale, "thread", null, "close-after", { after: "1h" });
      await f.dispatch(scheduled);
      expect(content(scheduled)).toBe(
        locale === "ja"
          ? `予約クローズ\`${scheduleId}\`を保存しました。日時: <t:1893456000:F> (<t:1893456000:R>)
実行登録は未確認です。WEFTが自動で確認・調整します。`
          : `Thread close schedule \`${scheduleId}\` saved for <t:1893456000:F> (<t:1893456000:R>). Execution setup is unconfirmed; WEFT will check and repair it automatically.`,
      );
      expect(f.close.schedule).toHaveBeenCalledExactlyOnceWith(guildId, channelId, actorId, "1h");
    } finally {
      await f.finish();
    }
  });

  it.each([
    [
      { ok: false, pending: true },
      "WEFT is still processing or confirming this operation. Discord rate limits may delay completion by several minutes.",
      "WEFTが処理や結果確認を続けています。Discordのレート制限などで数分かかる場合があります。",
    ],
    [
      { ok: false, code: "STATE_WRITE_OUTCOME_UNKNOWN" },
      "Could not confirm the final outcome. Check the current thread state before retrying.",
      "最終結果を確認できませんでした。再試行する前にスレッドの現在の状態を確認してください。",
    ],
    [
      { ok: false, code: "ACTOR_PERMISSION_MISSING" },
      "You need the Manage Threads permission to use this command.",
      "このコマンドには「スレッドの管理」権限が必要です。",
    ],
  ])("preserves thread outcome certainty %j", async (result, en, ja) => {
    const f = fixture();
    try {
      f.close.closeManually.mockResolvedValue({ outcome: "LIFECYCLE", result });
      const value = f.interaction(locale, "thread", null, "close");
      await f.dispatch(value);
      expect(content(value)).toBe(locale === "ja" ? ja : en);
      expect(f.close.closeManually).toHaveBeenCalledExactlyOnceWith(guildId, channelId, actorId);
    } finally {
      await f.finish();
    }
  });

  it.each([
    [
      "MISSING_SELECTOR",
      {},
      "Specify either after or at.",
      "afterとatのいずれかを指定してください。",
    ],
    [
      "INVALID_AT_FORMAT",
      { at: "2026-10-18T10:00" },
      "Use YYYY-MM-DD HH:mm in WEFT's default timezone.",
      "WEFTの既定タイムゾーンでYYYY-MM-DD HH:mm形式を指定してください。",
    ],
  ])("localizes %s validation before service access", async (_code, options, en, ja) => {
    const f = fixture();
    try {
      const value = f.interaction(locale, "message", "schedule", "create", options);
      await f.dispatch(value);
      expect(value.reply).toHaveBeenCalledExactlyOnceWith({
        content: locale === "ja" ? ja : en,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      expect(value.deferReply).not.toHaveBeenCalled();
      expect(value.showModal).not.toHaveBeenCalled();
      expect(f.scheduled.create).not.toHaveBeenCalled();
    } finally {
      await f.finish();
    }
  });

  it.each(["send", "edit", "create", "recurring-create", "scheduled-edit"] as const)(
    "localizes the %s Modal without translating fields, identity or prefills",
    async (kind) => {
      const f = fixture();
      try {
        const scheduled = !["send", "edit"].includes(kind);
        const sub = kind === "scheduled-edit" ? "edit" : kind;
        const value = f.interaction(locale, "message", scheduled ? "schedule" : null, sub, {
          message: messageId,
          id: scheduleId,
          after: "1h",
          frequency: "daily",
          time: "09:30",
        });
        await f.dispatch(value);
        expect(value.showModal).toHaveBeenCalledOnce();
        const built = value.showModal.mock.calls[0]![0] as { toJSON?: () => unknown };
        const json = (built.toJSON ? built.toJSON() : built) as {
          custom_id: string;
          title: string;
          components: {
            label: string;
            description?: string;
            component: { custom_id: string; value?: string; max_length?: number };
          }[];
        };
        expect(json.title).toBe(
          (locale === "ja"
            ? {
                send: "管理メッセージの送信",
                edit: "管理メッセージの編集",
                create: "投稿を予約",
                "recurring-create": "定期投稿の設定",
                "scheduled-edit": "予約投稿の編集",
              }
            : {
                send: "Send a managed message",
                edit: "Edit a managed message",
                create: "Schedule a post",
                "recurring-create": "Set up recurring posts",
                "scheduled-edit": "Edit scheduled post",
              })[kind],
        );
        expect(json.components[0]!.label).toBe(locale === "ja" ? "本文" : "Message content");
        expect(json.components[3]).toMatchObject({
          label: locale === "ja" ? "カラーコード" : "Color code",
          description: locale === "ja" ? "例：#FF0000、FF0000" : "e.g. #FF0000 or FF0000",
          component: { custom_id: "managed-message:embed-color", max_length: 7 },
        });
        expect(json.components.map((label) => label.component.custom_id)).toEqual([
          "managed-message:content",
          "managed-message:embed-title",
          "managed-message:embed-description",
          "managed-message:embed-color",
          "managed-message:embed-image-url",
        ]);
        if (kind === "edit" || kind === "scheduled-edit")
          expect(json.components[0]!.component.value).toBe(payload.content);
        expect(value.reply).not.toHaveBeenCalled();
        expect(value.deferReply).not.toHaveBeenCalled();
      } finally {
        await f.finish();
      }
    },
  );

  it.each([
    [
      "DELETED",
      "The managed message has been deleted.",
      "指定した管理メッセージは削除されています。",
    ],
    [
      "FAILURE",
      "Could not load the managed message. Try again later.",
      "管理メッセージを取得できませんでした。時間をおいて再試行してください。",
    ],
    [
      "NOT_FOUND",
      "No WEFT management record was found for that message in this channel.",
      "このチャンネルでは、指定したメッセージの管理記録が見つかりません。",
    ],
  ])("describes edit lookup %s without widening message eligibility", async (outcome, en, ja) => {
    const f = fixture();
    try {
      f.managed.findForEdit.mockResolvedValue({ outcome });
      const value = f.interaction(locale, "message", null, "edit", { message: messageId });
      await f.dispatch(value);
      expect(value.reply).toHaveBeenCalledExactlyOnceWith({
        content: locale === "ja" ? ja : en,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      expect(f.managed.findForEdit).toHaveBeenCalledExactlyOnceWith({
        guildId,
        channelId,
        messageId,
      });
      expect(value.deferReply).not.toHaveBeenCalled();
      expect(value.showModal).not.toHaveBeenCalled();
      expect(value.editReply).not.toHaveBeenCalled();
      expect(f.managed.send).not.toHaveBeenCalled();
      expect(f.managed.edit).not.toHaveBeenCalled();
    } finally {
      await f.finish();
    }
  });

  it.each(["send", "edit", "create", "recurring", "scheduled-edit"] as const)(
    "uses submit locale for the %s form result",
    async (kind) => {
      const f = fixture();
      try {
        const id =
          kind === "send"
            ? MANAGED_MESSAGE_SEND_MODAL_ID
            : kind === "edit"
              ? createManagedMessageEditModal(
                  messageId,
                  1,
                  payload,
                  locale === "ja" ? "en-US" : "ja",
                ).data.custom_id!
              : kind === "create"
                ? createScheduledMessageCreateModalId({ kind: "AFTER", durationMs: 60000 })
                : kind === "recurring"
                  ? createRecurringMessageCreateModalId({ frequency: "daily", time: "09:30" })
                  : createScheduledMessageEditModalId(scheduleId, 1);
        const value = modal(f, locale, id);
        await f.dispatch(value);
        const expected =
          locale === "ja"
            ? {
                send: `管理メッセージ\`${messageId}\`を送信しました。`,
                edit: `管理メッセージ\`${messageId}\`の内容に変更はありません。`,
                create: `単発予約\`${scheduleId}\`を保存しました。送信先: <#${channelId}>
送信日時: <t:1893456000:F> (<t:1893456000:R>)
実行登録は未確認です。WEFTが自動で確認・調整します。`,
                recurring: `定期投稿\`${scheduleId}\`を設定しました。初回: <t:1893456000:F>
実行登録は未確認です。WEFTが自動で確認・調整します。`,
                "scheduled-edit": `定期投稿\`${scheduleId}\`の内容を変更しました。実行中・再試行待ちの回の内容は変わりません。`,
              }
            : {
                send: `Managed message \`${messageId}\` sent.`,
                edit: `Managed message \`${messageId}\` is unchanged.`,
                create: `One-time schedule \`${scheduleId}\` saved. Channel: <#${channelId}>. Send time: <t:1893456000:F> (<t:1893456000:R>). Execution setup is unconfirmed; WEFT will check and repair it automatically.`,
                recurring: `Recurring schedule \`${scheduleId}\` saved. First send: <t:1893456000:F>. Execution setup is unconfirmed; WEFT will check and repair it automatically.`,
                "scheduled-edit": `Recurring schedule \`${scheduleId}\` content updated. Running or retrying occurrences keep their previous content.`,
              };
        expect(content(value)).toBe(expected[kind]);
        expect(value.deferReply).toHaveBeenCalledExactlyOnceWith({ flags: MessageFlags.Ephemeral });
        expect(value.reply).not.toHaveBeenCalled();
        const service =
          kind === "send"
            ? f.managed.send
            : kind === "edit"
              ? f.managed.edit
              : kind === "create"
                ? f.scheduled.create
                : kind === "recurring"
                  ? f.scheduled.createRecurring
                  : f.scheduled.edit;
        expect(service).toHaveBeenCalledOnce();
        expect(service.mock.calls[0]![0]).toMatchObject({
          guildId,
          channelId,
          actorUserId: actorId,
          payload,
        });
      } finally {
        await f.finish();
      }
    },
  );

  it.each([
    [
      { outcome: "UNCONFIRMED", messageId },
      `Message \`${messageId}\` was sent, but WEFT registration is unconfirmed. No deletion was attempted. Check its state before retrying or deleting it.`,
      `メッセージ\`${messageId}\`は送信済みですが、WEFTへの登録は未確認です。削除は試みていません。再試行や削除の前に状態を確認してください。`,
    ],
    [
      { outcome: "PARTIAL_FAILURE", messageId, deletionOutcome: "REJECTED" },
      `Message \`${messageId}\` was sent, but WEFT could not finish checking and recording it. Discord rejected the deletion. Inspect it before taking further action; manual deletion may be needed.`,
      `メッセージ\`${messageId}\`は送信済みですが、WEFTでの確認・記録を完了できませんでした。取り消すための削除も拒否されました。次の操作の前に状態を確認し、必要なら手動で削除してください。`,
    ],
    [
      { outcome: "PARTIAL_FAILURE", messageId, deletionOutcome: "UNCONFIRMED" },
      `Message \`${messageId}\` was sent, but WEFT could not finish checking and recording it. Its deletion is unconfirmed. It may still exist; check before retrying or deleting it.`,
      `メッセージ\`${messageId}\`は送信済みですが、WEFTでの確認・記録を完了できませんでした。削除結果も未確認です。残っている可能性があるため、再試行や削除の前に確認してください。`,
    ],
    [
      { outcome: "FAILURE", code: "PERSISTENCE_UNCONFIRMED_COMPENSATED" },
      "WEFT could not finish checking and recording the sent message, so it was deleted to undo the send.",
      "送信後の確認・記録を完了できなかったため、メッセージを削除しました。",
    ],
    [
      { outcome: "FAILURE", code: "SEND_UNCONFIRMED" },
      "Could not confirm whether Discord sent the message. Check the channel before retrying.",
      "Discordでメッセージが送信されたか確認できませんでした。再試行する前にチャンネルを確認してください。",
    ],
  ])("preserves send outcome %j without replay after response failure", async (result, en, ja) => {
    const f = fixture();
    try {
      f.managed.send.mockResolvedValue(result);
      const value = modal(f, locale, MANAGED_MESSAGE_SEND_MODAL_ID);
      const error = new Error("response lost");
      value.editReply.mockRejectedValue(error);
      await expect(f.dispatch(value)).rejects.toBe(error);
      expect(content(value)).toBe(locale === "ja" ? ja : en);
      expect(content(value)).not.toMatch(/管理メッセージ|managed message/i);
      expect(f.managed.send).toHaveBeenCalledOnce();
      expect(value.reply).not.toHaveBeenCalled();
      expect(value.followUp).not.toHaveBeenCalled();
    } finally {
      await f.finish();
    }
  });

  it("changes list controls and subsequent errors with the Button interaction locale", async () => {
    const f = fixture();
    try {
      const start = f.interaction(locale, "message", "schedule", "list");
      await f.dispatch(start);
      const first = start.editReply.mock.calls[0]![0];
      expect(first.content).toContain(
        locale === "ja" ? "予約投稿 — 1ページ" : "Scheduled posts — page 1",
      );
      const components = first.components as unknown as {
        components: { label: string; custom_id: string }[];
      }[];
      expect(components[0]!.components.map((b) => b.label)).toEqual(
        locale === "ja" ? ["前へ", "次へ"] : ["Previous", "Next"],
      );
      const button = f.interaction(locale === "ja" ? "en-US" : "ja");
      button.isChatInputCommand = () => false;
      button.isButton = () => true;
      button.customId = components[0]!.components[1]!.custom_id;
      await f.dispatch(button);
      expect(content(button)).toContain(
        locale === "ja" ? "Scheduled posts — page 2" : "予約投稿 — 2ページ",
      );
      expect(f.scheduled.list).toHaveBeenCalledTimes(2);
      await f.dispatch(button);
      expect(button.reply).toHaveBeenCalledExactlyOnceWith({
        content:
          locale === "ja"
            ? "These list controls are invalid. Run /message schedule list again."
            : "この一覧操作は無効です。/message schedule listを再実行してください。",
        flags: MessageFlags.Ephemeral,
        components: [],
        allowedMentions: { parse: [] },
      });
      expect(f.scheduled.list).toHaveBeenCalledTimes(2);
    } finally {
      await f.finish();
    }
  });

  it("localizes bulk setup, Modal preview, Select, navigation, confirmation and counts through ingress", async () => {
    const f = fixture();
    try {
      const start = f.interaction(locale, "thread", null, "bulk-close");
      await f.dispatch(start);
      const submitted = modal(f, locale === "ja" ? "en-US" : "ja", `btc:${ticket}:setup`);
      await f.dispatch(submitted);
      const response = submitted.editReply.mock.calls.at(-1)![0];
      expect(response.content).toBe(
        locale === "ja"
          ? "Select threads, then close them. Selections on other pages are included."
          : "対象を選択して一括クローズを実行してください。他ページの選択も対象です。",
      );
      const select = f.interaction(locale);
      select.isChatInputCommand = () => false;
      select.isStringSelectMenu = () => true;
      select.customId = `btc:${ticket}:select:0:0`;
      Object.assign(select, { values: [channelId] });
      await f.dispatch(select);
      expect(f.bulk.select).toHaveBeenCalledExactlyOnceWith(
        ticket,
        { guildId, actorId, messageId: "response-id" },
        0,
        0,
        [channelId],
      );
      expect(select.editReply.mock.calls[0]![0].content).toBe(
        locale === "ja"
          ? "対象を選択して一括クローズを実行してください。他ページの選択も対象です。"
          : "Select threads, then close them. Selections on other pages are included.",
      );
      const confirm = f.interaction(locale);
      confirm.isChatInputCommand = () => false;
      confirm.isButton = () => true;
      confirm.customId = `btc:${ticket}:confirm`;
      await f.dispatch(confirm);
      expect(confirm.deferUpdate).toHaveBeenCalledOnce();
      expect(confirm.editReply).toHaveBeenCalledExactlyOnceWith({
        content:
          locale === "ja"
            ? "一括クローズを開始しました。結果は別のメッセージで表示します。"
            : "Bulk close started. Results will follow in a separate message.",
        embeds: [],
        components: [],
        allowedMentions: { parse: [] },
      });
      expect(confirm.followUp).toHaveBeenCalledExactlyOnceWith({
        content:
          locale === "ja"
            ? "一括クローズの結果\n選択: 1件\n開始: 1件\n閉じた対象: 0件\nすでに閉じていた対象: 0件\n処理継続中: 1件\n失敗または結果未確認: 0件\nスキップ: 0件\n処理継続中の対象はWEFTが対応を続けます。失敗または結果未確認でも変更済みの場合があります。再試行前に確認してください。スキップした対象の操作は開始していません。"
            : "Bulk thread close result\nSelected: 1\nAttempted: 1\nClosed: 0\nAlready closed: 0\nPending: 1\nFailed or unconfirmed: 0\nSkipped: 0\nWEFT is still handling pending work. Failed or unconfirmed targets may have changed; inspect them before retrying. Skipped targets were not started.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      expect(f.bulk.confirm).toHaveBeenCalledExactlyOnceWith(ticket, {
        guildId,
        actorId,
        messageId: "response-id",
      });
    } finally {
      await f.finish();
    }
  });
  it.each(["cancel", "reschedule", "recurrence-edit"])(
    "preserves the %s saved/cancelled result and delivery qualification",
    async (operation) => {
      const f = fixture();
      try {
        const value = f.interaction(locale, "message", "schedule", operation, {
          id: scheduleId,
          after: "1h",
          frequency: "daily",
          time: "09:30",
        });
        await f.dispatch(value);
        const expected: Record<string, string> =
          locale === "ja"
            ? {
                cancel: `定期投稿\`${scheduleId}\`を取り消しました。今後の投稿は予約されません。実行中の回は完了する場合があります。実行待ち処理の停止は未確認です。WEFTが自動で確認・調整します。`,
                reschedule: `単発予約\`${scheduleId}\`の送信日時を変更しました。
<t:1893456000:F> (<t:1893456000:R>)
実行登録は未確認です。WEFTが自動で確認・調整します。`,
                "recurrence-edit": `定期投稿\`${scheduleId}\`の繰り返し設定を変更しました。実行中・再試行待ちの回には適用されません。次回はその処理が終わってから準備します。実行登録は未確認です。WEFTが自動で確認・調整します。`,
              }
            : {
                cancel: `Recurring schedule \`${scheduleId}\` cancelled. No future occurrences will be scheduled. Work already running may still finish. Stopping queued work is unconfirmed; WEFT will check it automatically.`,
                reschedule: `One-time schedule \`${scheduleId}\` moved to <t:1893456000:F> (<t:1893456000:R>). Execution setup is unconfirmed; WEFT will check and repair it automatically.`,
                "recurrence-edit": `Recurring schedule \`${scheduleId}\` updated. Running or retrying occurrences keep the old settings. The next occurrence will be prepared after they finish. Execution setup is unconfirmed; WEFT will check and repair it automatically.`,
              };
        expect(content(value)).toBe(expected[operation]);
        expect(value.deferReply).toHaveBeenCalledExactlyOnceWith({ flags: MessageFlags.Ephemeral });
        expect(value.reply).not.toHaveBeenCalled();
        const service =
          operation === "cancel"
            ? f.scheduled.cancel
            : operation === "reschedule"
              ? f.scheduled.reschedule
              : f.scheduled.editRecurrence;
        expect(service).toHaveBeenCalledOnce();
        expect(service.mock.calls[0]![0]).toMatchObject({
          scheduledActionId: scheduleId,
          guildId,
          channelId,
          actorUserId: actorId,
        });
      } finally {
        await f.finish();
      }
    },
  );

  it("retains uppercase states, full identities and timestamp meaning in both schedule kinds", async () => {
    const f = fixture();
    try {
      const oneTime = f.interaction(locale, "message", "schedule", "status", { id: scheduleId });
      await f.dispatch(oneTime);
      expect(content(oneTime)).toBe(
        locale === "ja"
          ? `単発予約\`${scheduleId}\`\n状態: **EXECUTING**\n送信先: <#${channelId}>\n実行中の送信予定日時: <t:1893456000:F> (<t:1893456000:R>)\n作成者: <@${actorId}> (\`${actorId}\`)\n再試行回数: 2`
          : `One-time schedule \`${scheduleId}\`\nStatus: **EXECUTING**\nTarget: <#${channelId}>\nCurrent execution scheduled for: <t:1893456000:F> (<t:1893456000:R>)\nCreator: <@${actorId}> (\`${actorId}\`)\nRetry count: 2`,
      );
      f.scheduled.status.mockResolvedValue({
        outcome: "FOUND",
        schedule: {
          kind: "RECURRING",
          scheduledActionId: scheduleId,
          status: "ACTIVE",
          executeAt: when,
          creatorUserId: actorId,
          channelId,
          guildId,
          retryCount: 2,
          revision: 3,
          resultMessageId: null,
          frequency: "WEEKLY",
          weekdayMask: 5,
          localTime: "09:30",
          timezone: "Asia/Tokyo",
          currentOccurrenceId: scheduleId,
          currentOccurrenceStatus: "RETRY_PENDING",
        },
      });
      const recurring = f.interaction(locale, "message", "schedule", "status", { id: scheduleId });
      await f.dispatch(recurring);
      expect(content(recurring)).toContain(
        locale === "ja" ? "予約のタイムゾーン: Asia/Tokyo" : "Scheduling timezone: Asia/Tokyo",
      );
      expect(content(recurring)).toContain(
        locale === "ja"
          ? "今回の予定日時: <t:1893456000:F>"
          : "Current occurrence scheduled time: <t:1893456000:F>",
      );
      expect(content(recurring)).toContain("**RETRY_PENDING**");
      expect(content(recurring)).toContain(scheduleId);
      expect(content(recurring)).not.toContain(payload.content);
      expect(f.scheduled.status).toHaveBeenCalledTimes(2);
    } finally {
      await f.finish();
    }
  });

  it.each([
    [
      "DST_GAP",
      "That time does not exist in the configured timezone. Choose another time.",
      "設定されたタイムゾーンには存在しない時刻です。別の時刻を指定してください。",
    ],
    [
      "DST_OVERLAP",
      "That time occurs twice in the configured timezone. Choose another time or use after.",
      "設定されたタイムゾーンで2回現れる時刻です。別の時刻を選ぶか、afterを使ってください。",
    ],
    [
      "INVALID_GUILD_TIMEZONE",
      "Set WEFT's default IANA timezone before using at.",
      "日時を指定する前に、WEFTの既定タイムゾーンを設定してください。",
    ],
    [
      "TIMEZONE_UNAVAILABLE",
      "Could not load WEFT's default timezone. Try again later.",
      "WEFTの既定タイムゾーンを取得できませんでした。時間をおいて再試行してください。",
    ],
    [
      "TOO_SOON",
      "Schedule the message at least one minute ahead.",
      "メッセージは1分以上先の日時に予約してください。",
    ],
    [
      "TOO_FAR",
      "Choose a time within the next 365 days.",
      "現在時刻から365日以内の日時を指定してください。",
    ],
  ])(
    "localizes formal one-time scheduling failure %s after the existing ACK",
    async (code, en, ja) => {
      const f = fixture();
      try {
        f.scheduled.create.mockResolvedValue({ outcome: "FAILURE", code });
        const value = modal(
          f,
          locale,
          createScheduledMessageCreateModalId({ kind: "AT", localDateTime: "2030-01-01 09:30" }),
        );
        await f.dispatch(value);
        expect(content(value)).toBe(locale === "ja" ? ja : en);
        expect(f.scheduled.create).toHaveBeenCalledOnce();
        expect(value.deferReply).toHaveBeenCalledExactlyOnceWith({ flags: MessageFlags.Ephemeral });
        expect(value.reply).not.toHaveBeenCalled();
      } finally {
        await f.finish();
      }
    },
  );

  it("does not call send or retry a response when Modal acknowledgement fails", async () => {
    const f = fixture();
    try {
      const value = modal(f, locale, MANAGED_MESSAGE_SEND_MODAL_ID);
      const error = new Error("ACK response lost");
      value.deferReply.mockRejectedValue(error);
      await expect(f.dispatch(value)).rejects.toBe(error);
      expect(value.deferReply).toHaveBeenCalledOnce();
      expect(f.managed.send).not.toHaveBeenCalled();
      expect(value.editReply).not.toHaveBeenCalled();
      expect(value.reply).not.toHaveBeenCalled();
      expect(value.followUp).not.toHaveBeenCalled();
    } finally {
      await f.finish();
    }
  });

  it("localizes payload and authorization rejection before any service operation", async () => {
    const f = fixture();
    try {
      const invalid = modal(f, locale, MANAGED_MESSAGE_SEND_MODAL_ID);
      invalid.fields.getTextInputValue = () => "";
      await f.dispatch(invalid);
      expect(invalid.reply).toHaveBeenCalledExactlyOnceWith({
        content:
          locale === "ja"
            ? "本文、埋め込みのタイトル・説明文・画像URLのいずれかを入力してください。"
            : "Enter text or an embed title, description or image URL. To omit text, leave its field empty without spaces.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      expect(invalid.deferReply).not.toHaveBeenCalled();
      expect(f.managed.send).not.toHaveBeenCalled();
      const denied = f.interaction(locale);
      denied.memberPermissions.has = () => false;
      await f.dispatch(denied);
      expect(denied.reply).toHaveBeenCalledExactlyOnceWith({
        content:
          locale === "ja"
            ? "「メッセージの管理」権限が必要です。"
            : "The Manage Messages permission is required.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      expect(denied.showModal).not.toHaveBeenCalled();
      expect(f.managed.send).not.toHaveBeenCalled();
    } finally {
      await f.finish();
    }
  });
});

describe.each(["en-US", "ja"])("quality regression dispatch (%s)", (locale) => {
  it("accepts announcement channels for message and scheduling forms and submission", async () => {
    const f = fixture();
    try {
      const send = f.interaction(locale);
      send.channel.type = ChannelType.GuildAnnouncement;
      await f.dispatch(send);
      expect(send.showModal).toHaveBeenCalledOnce();
      const submit = modal(f, locale, MANAGED_MESSAGE_SEND_MODAL_ID);
      submit.channel.type = ChannelType.GuildAnnouncement;
      await f.dispatch(submit);
      expect(f.managed.send).toHaveBeenCalledExactlyOnceWith({
        guildId,
        channelId,
        actorUserId: actorId,
        payload,
      });
      expect(content(submit)).toBe(
        locale === "ja"
          ? `管理メッセージ\`${messageId}\`を送信しました。`
          : `Managed message \`${messageId}\` sent.`,
      );
      const schedule = f.interaction(locale, "message", "schedule", "create", { after: "1h" });
      schedule.channel.type = ChannelType.GuildAnnouncement;
      await f.dispatch(schedule);
      expect(schedule.showModal).toHaveBeenCalledOnce();
      expect(f.scheduled.create).not.toHaveBeenCalled();
    } finally {
      await f.finish();
    }
  });

  it.each(["edit", "reschedule"])(
    "reports an unrecognized %s result as unconfirmed without retrying",
    async (operation) => {
      const f = fixture();
      try {
        const submit =
          operation === "edit"
            ? modal(f, locale, createScheduledMessageEditModalId(scheduleId, 1))
            : f.interaction(locale, "message", "schedule", "reschedule", {
                id: scheduleId,
                after: "1h",
              });
        const service = operation === "edit" ? f.scheduled.edit : f.scheduled.reschedule;
        service.mockResolvedValue({ outcome: "UNRECOGNIZED" });
        await f.dispatch(submit);
        expect(content(submit)).toBe(
          locale === "ja"
            ? operation === "edit"
              ? "予約内容の編集結果を確認できませんでした。再試行する前に現在の予約を確認してください。"
              : "送信日時の変更結果を確認できませんでした。再試行する前に現在の予約を確認してください。"
            : operation === "edit"
              ? "Could not confirm the scheduled content edit result. Check the current schedule before retrying."
              : "Could not confirm the send-time change result. Check the current schedule before retrying.",
        );
        expect(service).toHaveBeenCalledOnce();
        expect(submit.reply).not.toHaveBeenCalled();
        expect(submit.followUp).not.toHaveBeenCalled();
      } finally {
        await f.finish();
      }
    },
  );

  it.each(["EDIT", "DELETION_DETECTION"])(
    "preserves %s partial facts after response loss",
    async (kind) => {
      const f = fixture();
      try {
        f.managed.edit.mockResolvedValue({ outcome: "PARTIAL_FAILURE", messageId, kind });
        const value = modal(
          f,
          locale,
          createManagedMessageEditModal(messageId, 1, payload).data.custom_id!,
        );
        const lost = new Error("Final response lost");
        value.editReply.mockRejectedValue(lost);
        await expect(f.dispatch(value)).rejects.toBe(lost);
        expect(content(value)).toBe(
          locale === "ja"
            ? kind === "EDIT"
              ? `メッセージ\`${messageId}\`は編集済みですが、WEFTへの記録も元の内容への復元も未確認です。管理者にメッセージと記録の確認を依頼してください。`
              : `メッセージ\`${messageId}\`は見つかりませんでしたが、WEFTへの削除記録は未確認です。管理者に確認を依頼してください。`
            : kind === "EDIT"
              ? `Message \`${messageId}\` was edited, but neither its WEFT record nor a safe restoration is confirmed. Ask an administrator to check the message and record.`
              : `Message \`${messageId}\` was missing, but WEFT could not confirm its deletion record. Ask an administrator to check.`,
        );
        expect(f.managed.edit).toHaveBeenCalledOnce();
        expect(f.managed.send).not.toHaveBeenCalled();
        expect(value.followUp).not.toHaveBeenCalled();
      } finally {
        await f.finish();
      }
    },
  );
});

describe.each(["en-US", "ja"])("input wording through production dispatch (%s)", (locale) => {
  it.each([
    ["empty", "", "", "", ""],
    ["whitespace-with-embed", " \t\n", "User 🌸 title", "", ""],
    ["color-only", "", "", "#FF0000", ""],
    ["text-with-color-only-embed", "User text", "", "#FF0000", ""],
    ["invalid-color", "", "User 🌸 title", "red", ""],
  ])(
    "explains %s without claiming text is mandatory or starting a send",
    async (kind, text, title, color, image) => {
      const f = fixture();
      try {
        const value = modal(f, locale, MANAGED_MESSAGE_SEND_MODAL_ID);
        const fields: Record<string, string> = {
          "managed-message:content": text,
          "managed-message:embed-title": title,
          "managed-message:embed-color": color,
          "managed-message:embed-image-url": image,
        };
        value.fields.getTextInputValue = (name) => fields[name] ?? "";
        await f.dispatch(value);
        const expected =
          kind === "invalid-color"
            ? locale === "ja"
              ? "カラーコードは6桁の16進数で指定してください（例：#FF0000、FF0000）。"
              : "Enter a 6-digit hexadecimal color code, e.g. #FF0000 or FF0000."
            : kind === "color-only" || kind === "text-with-color-only-embed"
              ? locale === "ja"
                ? "埋め込みは色の指定のみでは送信できません。タイトル・説明文・画像URLのいずれかも入力してください。"
                : "A color code alone cannot create an embed. Add an embed title, description or image URL."
              : locale === "ja"
                ? "本文、埋め込みのタイトル・説明文・画像URLのいずれかを入力してください。"
                : "Enter text or an embed title, description or image URL. To omit text, leave its field empty without spaces.";
        expect(value.reply).toHaveBeenCalledExactlyOnceWith({
          content: expected,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
        expect(expected.length).toBeLessThanOrEqual(2000);
        expect(value.deferReply).not.toHaveBeenCalled();
        expect(value.editReply).not.toHaveBeenCalled();
        expect(f.managed.send).not.toHaveBeenCalled();
        expect(f.managed.edit).not.toHaveBeenCalled();
      } finally {
        await f.finish();
      }
    },
  );

  it.each(["title-only", "image-only", "hex-with-hash", "hex-without-hash"])(
    "accepts omitted text with %s and reports the actual send",
    async (kind) => {
      const f = fixture();
      try {
        const value = modal(f, locale, MANAGED_MESSAGE_SEND_MODAL_ID);
        const title = kind === "image-only" ? "" : "User 🌸 title";
        const color =
          kind === "hex-with-hash" ? "#ff0000" : kind === "hex-without-hash" ? "FF0000" : "";
        const image = kind === "image-only" ? "https://example.invalid/image.png" : "";
        const fields: Record<string, string> = {
          "managed-message:content": "",
          "managed-message:embed-title": title,
          "managed-message:embed-color": color,
          "managed-message:embed-image-url": image,
        };
        value.fields.getTextInputValue = (name) => fields[name] ?? "";
        await f.dispatch(value);
        expect(value.deferReply).toHaveBeenCalledExactlyOnceWith({ flags: MessageFlags.Ephemeral });
        expect(f.managed.send).toHaveBeenCalledExactlyOnceWith({
          guildId,
          channelId,
          actorUserId: actorId,
          payload: {
            content: "",
            embed: {
              ...(title ? { title } : {}),
              ...(image ? { imageUrl: image } : {}),
              ...(color ? { color: 0xff0000 } : {}),
            },
          },
        });
        expect(f.managed.send.mock.invocationCallOrder[0]).toBeGreaterThan(
          value.deferReply.mock.invocationCallOrder[0]!,
        );
        expect(value.editReply).toHaveBeenCalledExactlyOnceWith({
          content:
            locale === "ja"
              ? "管理メッセージ`123456789012345681`を送信しました。"
              : "Managed message `123456789012345681` sent.",
          allowedMentions: { parse: [] },
        });
        expect(value.reply).not.toHaveBeenCalled();
      } finally {
        await f.finish();
      }
    },
  );

  it.each([
    ["frequency", { frequency: "DAILY", time: "09:30" }],
    ["weekdays", { frequency: "daily", time: "09:30", weekdays: "mon" }],
    ["weekdays", { frequency: "weekly", time: "09:30" }],
    ["weekdays", { frequency: "weekly", time: "09:30", weekdays: "mon,MON" }],
    ["time", { frequency: "daily", time: "9:30" }],
    ["timezone", { frequency: "daily", time: "09:30", timezone: "+09:00" }],
  ] as const)("uses option identifiers for invalid %s input %j", async (field, options) => {
    const f = fixture();
    try {
      const value = f.interaction(locale, "message", "schedule", "recurring-create", options);
      await f.dispatch(value);
      const expected = (
        locale === "ja"
          ? {
              frequency: "frequencyはdailyまたはweeklyを指定してください。",
              weekdays:
                "weekdaysにはmon,tue,wed,thu,fri,sat,sunを使用できます。frequency=weeklyでは1つ以上を重複なしでカンマ区切りにし、frequency=dailyでは省略してください。",
              time: "timeはHH:MM形式で指定してください（例：09:30）。",
              timezone:
                "timezoneはIANAタイムゾーンを指定してください（例：Asia/Tokyo、UTC）。数値オフセットは使用できません。",
            }
          : {
              frequency: "Set frequency to daily or weekly.",
              weekdays:
                "frequency=weekly requires one or more unique comma-separated weekdays (mon,tue,wed,thu,fri,sat,sun). Omit weekdays for frequency=daily.",
              time: "Set time as a 24-hour HH:MM value, e.g. 09:30.",
              timezone:
                "Set timezone to an IANA timezone, e.g. Asia/Tokyo or UTC. Numeric offsets are not supported.",
            }
      )[field];
      expect(value.reply).toHaveBeenCalledExactlyOnceWith({
        content: expected,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      expect(value.showModal).not.toHaveBeenCalled();
      expect(value.deferReply).not.toHaveBeenCalled();
      expect(f.scheduled.createRecurring).not.toHaveBeenCalled();
      expect(expected.length).toBeLessThanOrEqual(2000);
    } finally {
      await f.finish();
    }
  });

  it.each(["create", "reschedule"])(
    "states the same exclusive selector rule for %s",
    async (operation) => {
      for (const conflicting of [false, true]) {
        const f = fixture();
        try {
          const value = f.interaction(locale, "message", "schedule", operation, {
            id: scheduleId,
            ...(conflicting ? { after: "1h", at: "2030-01-01 09:30" } : {}),
          });
          await f.dispatch(value);
          expect(value.reply).toHaveBeenCalledExactlyOnceWith({
            content:
              locale === "ja"
                ? conflicting
                  ? "afterとatのいずれかを指定してください。両方は指定できません。"
                  : "afterとatのいずれかを指定してください。"
                : conflicting
                  ? "Specify either after or at; they cannot be combined."
                  : "Specify either after or at.",
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          });
          expect(value.deferReply).not.toHaveBeenCalled();
          expect(value.showModal).not.toHaveBeenCalled();
          expect(f.scheduled.create).not.toHaveBeenCalled();
          expect(f.scheduled.reschedule).not.toHaveBeenCalled();
        } finally {
          await f.finish();
        }
      }
    },
  );
});

it.each(["en-US", "ja"])(
  "renders the recurrence combination error through dispatch in %s",
  async (locale) => {
    const f = fixture();
    try {
      f.scheduled.editRecurrence.mockResolvedValue({ outcome: "INVALID_RECURRENCE" });
      const value = f.interaction(locale, "message", "schedule", "recurrence-edit", {
        id: scheduleId,
        frequency: "daily",
        time: "09:30",
      });
      await f.dispatch(value);
      expect(value.deferReply).toHaveBeenCalledExactlyOnceWith({ flags: MessageFlags.Ephemeral });
      expect(f.scheduled.editRecurrence).toHaveBeenCalledExactlyOnceWith({
        scheduledActionId: scheduleId,
        guildId,
        channelId,
        actorUserId: actorId,
        recurrence: { frequency: "daily", time: "09:30" },
      });
      expect(value.editReply).toHaveBeenCalledExactlyOnceWith({
        content:
          locale === "ja"
            ? "frequency、time（HH:MM）、weekdays、timezoneの入力を確認してください。"
            : "Check frequency, time (HH:MM), weekdays and timezone.",
        allowedMentions: { parse: [] },
      });
      expect(value.reply).not.toHaveBeenCalled();
      expect(f.scheduled.reschedule).not.toHaveBeenCalled();
      expect(f.managed.edit).not.toHaveBeenCalled();
    } finally {
      await f.finish();
    }
  },
);
