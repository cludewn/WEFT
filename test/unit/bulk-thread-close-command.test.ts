import { ChannelType as C, ComponentType, MessageFlags, PermissionFlagsBits } from "discord.js";
import type {
  APIActionRowComponent,
  APIButtonComponentWithCustomId,
  APIStringSelectComponent,
  ModalSubmitInteraction,
  ModalBuilder,
  StringSelectMenuInteraction,
  APIEmbed,
  ButtonInteraction,
  ChatInputCommandInteraction,
} from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BULK_CONTROL_FAILURE,
  BULK_PREPARATION_FAILURE,
  BULK_PREPARATION_MS,
  handleBulkCloseButton,
  handleBulkCloseCommand,
  handleBulkCloseModal,
  buildBulkCloseModal,
  parseBulkCloseCustomId,
  renderBulkCloseCounts,
  renderBulkClosePage,
} from "../../src/bulk-thread-close-command.js";
import type { BulkThreadCloseHooks } from "../../src/thread-lifecycle.js";
import { createBulkCloseDiscord } from "../../src/bulk-thread-close-discord.js";
import { DEFAULT_INTERACTION_IO_TIMEOUT_MS } from "../../src/thread-command.js";
import { createBulkCloseService } from "../../src/bulk-thread-close.js";
import type { BulkCloseDiscord, BulkCloseThread } from "../../src/bulk-thread-close.js";
import { threadCommandDefinition } from "../../src/thread-command.js";
import { commandDefinitions, handleCommand } from "../../src/commands.js";
import type { CommandDependencies } from "../../src/commands.js";
import { registerDiscordCommandHandler } from "../../src/discord.js";
import { EventEmitter } from "node:events";
import type { Client } from "discord.js";

const parent = { id: "2", guildId: "1", type: C.GuildText, name: "Parent" };
const hostile = "😀@everyone <@9> [a](https://host) `_*\\\n";
function fixture(count = 11) {
  const threads: BulkCloseThread[] = Array.from({ length: count }, (_, i) => ({
    guildId: "1",
    threadId: String(i + 10),
    type: C.PublicThread,
    name: hostile.repeat(20),
    archived: false,
    locked: false,
    parentId: "2",
    ownerId: "9",
    createdTimestamp: Date.parse("2026-01-01T00:00:00Z"),
  }));
  const discord: BulkCloseDiscord = {
    discover: vi.fn(() => Promise.resolve({ parent, threads })),
    observe: vi.fn<BulkCloseDiscord["observe"]>((_g, _p, _a, ids) =>
      Promise.resolve({ parent, threads: threads.filter((t) => ids.includes(t.threadId)) }),
    ),
  };
  const closeManually = vi.fn((_g: string, _t: string, _a: string, bulk?: BulkThreadCloseHooks) => {
    bulk!.onAttemptStarted();
    bulk!.onLogicalSettled();
    return Promise.resolve({ outcome: "LIFECYCLE", result: { ok: true, changed: true } } as const);
  });
  const service = createBulkCloseService({
    discord,
    manualClose: { closeManually },
    isReady: () => true,
  });
  const deferReply = vi.fn(() => Promise.resolve());
  const editReply = vi.fn((options: unknown) => {
    void options;
    return Promise.resolve({ id: "100" });
  });
  const showModal = vi.fn(() => Promise.resolve());
  const slash = {
    showModal,
    memberPermissions: { has: () => true },
    inGuild: () => true,
    guildId: "1",
    user: { id: "9" },
    commandName: "thread",
    deferReply,
    editReply,
    options: {
      getSubcommand: () => "bulk-close",
    },
  } as unknown as ChatInputCommandInteraction;
  const deferUpdate = vi.fn(() => Promise.resolve());
  const followUp = vi.fn((options: unknown) => {
    void options;
    return Promise.resolve({});
  });
  const button = (customId: string, userId = "9") =>
    ({
      isChatInputCommand: () => false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId,
      guildId: "1",
      user: { id: userId },
      message: { id: "100" },
      deferUpdate,
      editReply,
      followUp,
    }) as unknown as ButtonInteraction;
  return {
    showModal,
    modal: (customId: string, values: Record<string, unknown> = {}) =>
      ({
        isChatInputCommand: () => false,
        isButton: () => false,
        isModalSubmit: () => true,
        isStringSelectMenu: () => false,
        customId,
        guildId: "1",
        user: { id: "9" },
        deferReply,
        editReply,
        fields: {
          getField: (key: string) => ({
            type: key === "parent" ? ComponentType.ChannelSelect : ComponentType.UserSelect,
            values: key in values ? values[key] : key === "parent" ? ["2"] : [],
          }),
          getTextInputValue: (key: string) =>
            key in values ? values[key] : key === "name" ? "😀" : "",
        },
      }) as unknown as ModalSubmitInteraction,
    select: (customId: string, values: string[]) =>
      ({
        ...button(customId),
        isButton: () => false,
        isStringSelectMenu: () => true,
        values,
      }) as unknown as StringSelectMenuInteraction,
    service,
    discord,
    threads,
    slash,
    button,
    deferReply,
    editReply,
    deferUpdate,
    followUp,
    closeManually,
  };
}
afterEach(() => vi.useRealTimers());

describe("bulk interaction surface and safe payloads", () => {
  it("keeps ManageThreads with no bulk slash options and four current Label inputs", () => {
    const definition = threadCommandDefinition.toJSON();
    expect(definition.default_member_permissions).toBe(
      PermissionFlagsBits.ManageThreads.toString(),
    );
    expect(definition.description).toBe("Manage Discord threads");
    expect(definition.options?.find((o) => o.name === "bulk-close")).toMatchObject({ options: [] });
    expect(commandDefinitions.find((c) => c.name === "thread")).toEqual(definition);
    const modal = buildBulkCloseModal("ticket").toJSON();
    expect(modal.components).toHaveLength(4);
    expect(modal.components).toMatchObject([
      {
        type: ComponentType.Label,
        label: "Parent",
        component: {
          type: ComponentType.ChannelSelect,
          custom_id: "parent",
          required: true,
          min_values: 1,
          max_values: 1,
          channel_types: [C.GuildText, C.GuildAnnouncement, C.GuildForum],
        },
      },
      {
        type: ComponentType.Label,
        label: "Owner",
        component: {
          type: ComponentType.UserSelect,
          required: false,
          min_values: 0,
          max_values: 1,
        },
      },
      {
        type: ComponentType.Label,
        label: "Name contains",
        component: { type: ComponentType.TextInput, required: false },
      },
      {
        type: ComponentType.Label,
        label: "Created older than",
        component: { type: ComponentType.TextInput, required: false },
      },
    ]);
  });
  it("opens Modal as the initial response, then defers submit ephemerally before discovery", async () => {
    const f = fixture();
    await handleBulkCloseCommand(f.slash, f.service);
    expect(f.showModal).toHaveBeenCalledOnce();
    expect(f.deferReply).not.toHaveBeenCalled();
    expect(f.discord.discover).not.toHaveBeenCalled();
    const customId = (f.showModal.mock.calls[0] as unknown as [ModalBuilder])[0].toJSON().custom_id;
    await handleBulkCloseModal(f.modal(customId), f.service);
    expect(f.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(f.deferReply.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(f.discord.discover).mock.invocationCallOrder[0]!,
    );
    expect(f.editReply.mock.calls.at(-1)?.[0]).toMatchObject({
      allowedMentions: { parse: [] },
      embeds: [{ footer: { text: "Page 1/2 • Candidates: 11 • Selected: 11" } }],
    });
    expect(f.closeManually).not.toHaveBeenCalled();
    await handleBulkCloseModal(f.modal(customId), f.service);
    expect(f.discord.discover).toHaveBeenCalledOnce();
  });
  it.each([
    { parent: [] },
    { parent: ["2", "3"] },
    { parent: ["not-id"] },
    { parent: null },
    { owner: ["9", "8"] },
    { owner: ["bad"] },
    { owner: undefined },
    { name: 4 },
    { age: "0m" },
  ])("rejects malformed/invalid submit %j without enumeration", async (values) => {
    const f = fixture();
    const ticket = f.service.createSetup("1", "9")!;
    await handleBulkCloseModal(f.modal(`btc:${ticket}:setup`, values), f.service);
    expect(f.discord.discover).not.toHaveBeenCalled();
    expect(f.closeManually).not.toHaveBeenCalled();
    expect(f.editReply.mock.calls[0]?.[0]).toMatchObject({ allowedMentions: { parse: [] } });
  });
  it("accepts empty Owner and whitespace text as unfiltered with zero defaults", async () => {
    const f = fixture(1);
    const ticket = f.service.createSetup("1", "9")!;
    await handleBulkCloseModal(
      f.modal(`btc:${ticket}:setup`, { owner: [], name: " ", age: "\t" }),
      f.service,
    );
    const payload = f.editReply.mock.calls.at(-1)![0] as {
      components: APIActionRowComponent<APIStringSelectComponent>[];
    };
    expect(payload.components[0]!.components[0]).toMatchObject({
      min_values: 0,
      max_values: 1,
      options: [{ default: false }],
    });
    expect(f.closeManually).not.toHaveBeenCalled();
  });
  it("routes slash and owned buttons through the existing command ingress and leaves lp: alone", async () => {
    const f = fixture(1);
    const dependencies = {
      bulkClose: f.service,
      logger: { warn: vi.fn(), error: vi.fn() },
    } as unknown as CommandDependencies;
    expect(await handleCommand(f.slash, dependencies)).toBe(true);
    const client = new EventEmitter() as unknown as Client;
    const run = vi.fn(() => undefined);
    registerDiscordCommandHandler(client, dependencies, { run });
    client.emit("interactionCreate", f.button("btc:invalid"));
    expect(run).toHaveBeenCalledOnce();
    expect(f.deferUpdate).not.toHaveBeenCalled();
    client.emit("interactionCreate", f.button("lp:1:2:3"));
    expect(run).toHaveBeenCalledOnce();
  });
  it.each([
    "btc:",
    "btc:bad:confirm",
    "btc:12345678-1234-1234-1234-123456789abc:confirm",
    "btc:12345678-1234-4234-8234-123456789abc:page:5",
    "btc:12345678-1234-4234-8234-123456789abc:confirm:extra",
    "lp:1:2:3",
  ])("rejects malformed namespace/UUID/action %s", (value) => {
    expect(parseBulkCloseCustomId(value)).toBeUndefined();
  });
  it("makes all 50 identities inspectable in five safe pages within UTF-16/embed/component limits", async () => {
    const f = fixture(50);
    const result = await f.service.preview("1", "2", "9", {
      nameContains: hostile.repeat(100),
      ownerId: "9",
      creationAge: "1m",
    });
    // Use an adversarial matching string that itself exceeds ordinary Discord's command limits.
    f.threads.forEach((t) => {
      t.name = hostile.repeat(200);
    });
    const preview = result.ok
      ? result
      : await f.service.preview("1", "2", "9", {
          nameContains: hostile.repeat(100),
          ownerId: "9",
          creationAge: "1m",
        });
    if (!preview.ok) throw new Error(preview.reason);
    f.service.bind(preview.session, "100");
    const links: string[] = [];
    for (let page = 0; page < 5; page++) {
      const view = await f.service.page(
        preview.session.id,
        { guildId: "1", actorId: "9", messageId: "100" },
        page,
      );
      const payload = renderBulkClosePage(view!);
      const embed = payload.embeds![0] as APIEmbed;
      expect(embed.description!.length).toBeLessThanOrEqual(4096);
      const allText = [
        embed.title!,
        embed.description!,
        ...embed.fields!.flatMap((field) => [field.name, field.value]),
        embed.footer!.text,
      ].join("");
      expect(allText.length).toBeLessThan(6000);
      expect(allText).not.toContain("@everyone");
      expect(allText).not.toContain("<@9>");
      expect(allText).not.toMatch(
        /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u,
      );
      const components = payload
        .components![1] as APIActionRowComponent<APIButtonComponentWithCustomId>;
      expect(components.components).toHaveLength(5);
      for (const button of components.components)
        expect(button.custom_id.length).toBeLessThanOrEqual(100);
      links.push(...embed.description!.match(/https:\/\/discord\.com\/channels\/1\/\d+/g)!);
      expect(embed.description!.split("\n")).toHaveLength(10);
      expect(payload.allowedMentions).toEqual({ parse: [] });
    }
    expect(new Set(links).size).toBe(50);
  });
  it("redacts current inaccessible targets and aggregate results contain no protected identity", async () => {
    const f = fixture(1);
    const preview = await f.service.preview("1", "2", "9", { ownerId: "9" });
    if (!preview.ok) throw new Error("Preview failed");
    f.service.bind(preview.session, "100");
    vi.mocked(f.discord.observe).mockResolvedValueOnce({ parent, threads: [] });
    const page = await f.service.page(
      preview.session.id,
      { guildId: "1", actorId: "9", messageId: "100" },
      0,
    );
    const rendered = JSON.stringify(renderBulkClosePage(page!));
    expect(rendered).toContain("Target unavailable");
    expect(rendered).not.toContain("/channels/1/10");
    const counts = renderBulkCloseCounts({
      selected: 1,
      attempted: 0,
      closed: 0,
      alreadyClosed: 0,
      pending: 0,
      failed: 0,
      skipped: 1,
    });
    expect(counts).not.toContain("10");
    expect(counts).not.toContain(hostile);
  });
  it("refreshes pagination authorization after waiting for an earlier raw preview edit", async () => {
    const f = fixture();
    const preview = await f.service.preview("1", "2", "9", { ownerId: "9" });
    if (!preview.ok) throw new Error(preview.reason);
    f.service.bind(preview.session, "100");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preceding = f.service.updatePreview(preview.session, () => gate);
    await Promise.resolve();
    const paging = handleBulkCloseButton(f.button(`btc:${preview.session.id}:page:1:0`), f.service);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.discord.observe).not.toHaveBeenCalled();
    vi.mocked(f.discord.observe).mockResolvedValueOnce(undefined);
    release();
    await preceding;
    await paging;
    expect(f.editReply).not.toHaveBeenCalled();
    expect(f.followUp).toHaveBeenCalledWith({
      content: BULK_CONTROL_FAILURE,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  });
  it("sends aggregate results without waiting for raw page edits while retaining both promises", async () => {
    const f = fixture(1);
    const preview = await f.service.preview("1", "2", "9", { ownerId: "9" });
    if (!preview.ok) throw new Error(preview.reason);
    f.service.bind(preview.session, "100");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preceding = f.service.updatePreview(preview.session, () => gate);
    await Promise.resolve();
    let handlerDone = false;
    const confirmation = handleBulkCloseButton(
      f.button(`btc:${preview.session.id}:confirm`),
      f.service,
    ).then(() => {
      handlerDone = true;
    });
    await vi.waitFor(() => expect(f.followUp).toHaveBeenCalledOnce());
    expect(f.followUp.mock.calls[0]?.[0]).toMatchObject({
      flags: MessageFlags.Ephemeral,
    });
    expect(f.followUp.mock.calls[0]?.[0]).toHaveProperty(
      "content",
      expect.stringContaining("Closed: 1"),
    );
    expect(handlerDone).toBe(false);
    expect(f.editReply).not.toHaveBeenCalled();
    release();
    await preceding;
    await confirmation;
    expect(f.editReply).toHaveBeenCalledOnce();
    expect(handlerDone).toBe(true);
  });

  it("requires explicit Confirm even for one match; stranger and double Confirm never mutate", async () => {
    const f = fixture(1);
    const preview = await f.service.preview("1", "2", "9", { ownerId: "9" });
    if (!preview.ok) throw new Error("Preview failed");
    f.service.bind(preview.session, "100");
    const id = `btc:${preview.session.id}:confirm`;
    await handleBulkCloseButton(f.button(id, "8"), f.service);
    expect(f.closeManually).not.toHaveBeenCalled();
    expect(f.followUp).toHaveBeenLastCalledWith({
      content: BULK_CONTROL_FAILURE,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    await handleBulkCloseButton(f.button(id), f.service);
    expect(f.closeManually).toHaveBeenCalledOnce();
    expect(f.deferUpdate.mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(f.discord.observe).mock.invocationCallOrder[0]!,
    );
    await handleBulkCloseButton(f.button(id), f.service);
    expect(f.closeManually).toHaveBeenCalledOnce();
    expect(f.editReply.mock.calls).toContainEqual([
      {
        content: "Bulk close confirmed.",
        embeds: [],
        components: [],
        allowedMentions: { parse: [] },
      },
    ]);
  });
});

describe("interactive controls and payload safety", () => {
  it("renders current defaults after page revisits and Clear page retains other selections", async () => {
    const f = fixture(12);
    const p = await f.service.preview("1", "2", "9", { ownerId: "9" });
    if (!p.ok) throw new Error(p.reason);
    f.service.bind(p.session, "100");
    const identity = { guildId: "1", actorId: "9", messageId: "100" };
    const selectId = (page: number) => `btc:${p.session.id}:select:${page}:${p.session.revision}`;
    await handleBulkCloseButton(f.select(selectId(0), ["10"]), f.service);
    expect(p.session.selectedIds.size).toBe(3);
    await handleBulkCloseButton(
      f.button(`btc:${p.session.id}:next:1:${p.session.revision}`),
      f.service,
    );
    await handleBulkCloseButton(
      f.button(`btc:${p.session.id}:clear:1:${p.session.revision}`),
      f.service,
    );
    expect([...p.session.selectedIds]).toEqual(["10"]);
    await handleBulkCloseButton(
      f.button(`btc:${p.session.id}:previous:0:${p.session.revision}`),
      f.service,
    );
    const view = await f.service.page(p.session.id, identity, 0);
    const payload = renderBulkClosePage(view!);
    const menu = (payload.components![0] as APIActionRowComponent<APIStringSelectComponent>)
      .components[0]!;
    expect(menu.options.map((o) => o.default)).toEqual([true, ...Array<boolean>(9).fill(false)]);
    expect(menu.min_values).toBe(0);
    expect(menu.max_values).toBe(10);
    expect((payload.embeds![0] as APIEmbed).footer?.text).toContain("Selected: 1");
    await handleBulkCloseButton(f.select(selectId(0), []), f.service);
    expect(p.session.selectedIds.size).toBe(0);
    await handleBulkCloseButton(f.button(`btc:${p.session.id}:confirm`), f.service);
    expect(f.closeManually).not.toHaveBeenCalled();
  });
  it("wrong users and stale select controls reveal no candidate metadata", async () => {
    const f = fixture(1);
    const p = await f.service.preview("1", "2", "9", { ownerId: "9" });
    if (!p.ok) throw new Error(p.reason);
    f.service.bind(p.session, "100");
    const wrong = f.select(`btc:${p.session.id}:select:0:0`, []);
    Object.assign(wrong, { user: { id: "8" } });
    await handleBulkCloseButton(wrong, f.service);
    await handleBulkCloseButton(f.select(`btc:${p.session.id}:select:0:5`, []), f.service);
    expect(f.editReply).not.toHaveBeenCalled();
    expect(p.session.selectedIds.size).toBe(1);
    for (const [payload] of f.followUp.mock.calls)
      expect(payload).toMatchObject({
        content: BULK_CONTROL_FAILURE,
        allowedMentions: { parse: [] },
      });
  });
  it("escapes masked links in prose while options remain bounded plain text", async () => {
    const f = fixture(10);
    const name = "[click](https://evil.example) @everyone <@9> 😀\n_*";
    f.threads.forEach((t) => {
      t.name = (name + "\ud800").repeat(10);
    });
    const p = await f.service.preview("1", "2", "9", {
      nameContains: "[click](https://evil.example)",
    });
    if (!p.ok) throw new Error(p.reason);
    f.service.bind(p.session, "100");
    const view = await f.service.page(
      p.session.id,
      { guildId: "1", actorId: "9", messageId: "100" },
      0,
    );
    const payload = renderBulkClosePage(view!);
    const embed = payload.embeds![0] as APIEmbed;
    const prose = JSON.stringify(embed);
    expect(prose).not.toContain("[click](https://evil.example)");
    expect(embed.description).toContain("\\[click\\]");
    expect(embed.fields![1]!.value).toContain("\\[click\\]");
    const menu = (payload.components![0] as APIActionRowComponent<APIStringSelectComponent>)
      .components[0]!;
    expect(menu.options).toHaveLength(10);
    for (const option of menu.options) {
      expect(option.label.length).toBeLessThanOrEqual(100);
      expect(option.description!.length).toBeLessThanOrEqual(100);
      expect(option.label).toContain("[click](https://evil.example)");
      expect(option.label).not.toContain("\\[");
      expect(option.label).not.toMatch(/[\r\n]/);
      expect(option.label).not.toContain("@everyone");
      expect(option.label).not.toMatch(
        /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u,
      );
    }
    expect(embed.description!.length).toBeLessThan(4096);
    expect(prose.length).toBeLessThan(6000);
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });
  it("all btc modal/select/button routing uses blocked READY ingress and leaves lp untouched", () => {
    const f = fixture();
    const client = new EventEmitter() as unknown as Client;
    const run = vi.fn(() => undefined);
    registerDiscordCommandHandler(
      client,
      {
        bulkClose: f.service,
        logger: { error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
      } as unknown as CommandDependencies,
      { run },
    );
    client.emit("interactionCreate", f.modal("btc:lost:setup"));
    client.emit("interactionCreate", f.select("btc:lost:select:0:0", []));
    client.emit("interactionCreate", f.button("btc:lost:confirm"));
    expect(run).toHaveBeenCalledTimes(3);
    expect(f.deferReply).not.toHaveBeenCalled();
    expect(f.deferUpdate).not.toHaveBeenCalled();
    expect(f.discord.discover).not.toHaveBeenCalled();
    client.emit("interactionCreate", f.modal("lp:lost"));
    expect(run).toHaveBeenCalledTimes(3);
  });
});

it("routes admitted Modal and String Select work to the correct handlers", async () => {
  const f = fixture(1);
  const client = new EventEmitter() as unknown as Client;
  const owned: Promise<unknown>[] = [];
  registerDiscordCommandHandler(
    client,
    {
      bulkClose: f.service,
      logger: { error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
    } as unknown as CommandDependencies,
    {
      run: (handler) => {
        const result = Promise.resolve(handler());
        owned.push(result);
        return result;
      },
    },
  );
  const ticket = f.service.createSetup("1", "9")!;
  client.emit(
    "interactionCreate",
    f.modal(`btc:${ticket}:setup`, { owner: ["9"], name: "", age: "" }),
  );
  await owned[0];
  expect(f.discord.discover).toHaveBeenCalledWith(
    "1",
    "2",
    "9",
    expect.objectContaining({
      signal: expect.any(AbortSignal) as unknown,
      read: expect.any(Function) as unknown,
    }),
  );
  const payload = f.editReply.mock.calls.at(-1)![0] as {
    components: APIActionRowComponent<APIStringSelectComponent>[];
  };
  const selectId = payload.components[0]!.components[0]!.custom_id;
  client.emit("interactionCreate", f.select(selectId, []));
  await owned[1];
  expect(f.deferUpdate).toHaveBeenCalledOnce();
  const edited = f.editReply.mock.calls.at(-1)![0] as { embeds: APIEmbed[] };
  expect(edited.embeds[0]!.footer?.text).toContain("Selected: 0");
  expect(f.closeManually).not.toHaveBeenCalled();
});

it("rejects invocation without guild management permission and rejects missing/wrong Modal fields", async () => {
  const f = fixture();
  Object.assign(f.slash, {
    memberPermissions: { has: () => false },
    reply: vi.fn(() => Promise.resolve()),
  });
  await handleBulkCloseCommand(f.slash, f.service);
  expect(f.showModal).not.toHaveBeenCalled();
  expect(f.deferReply).not.toHaveBeenCalled();
  for (const missing of [true, false]) {
    const ticket = f.service.createSetup("1", "9")!;
    const modal = f.modal(`btc:${ticket}:setup`);
    Object.assign(modal.fields, {
      getField: () => {
        if (missing) throw new Error("Missing parent");
        return { type: ComponentType.TextInput, value: "2" };
      },
    });
    await handleBulkCloseModal(modal, f.service);
  }
  expect(f.discord.discover).not.toHaveBeenCalled();
  expect(f.closeManually).not.toHaveBeenCalled();
});

function componentCustomIds(payload: unknown): string[] {
  const message = payload as {
    components?: APIActionRowComponent<APIButtonComponentWithCustomId | APIStringSelectComponent>[];
  };
  return (
    message.components?.flatMap((row) => row.components.map((component) => component.custom_id)) ??
    []
  );
}

it.each([1, 10])(
  "completes the %s-candidate Modal preview with unique Discord component custom IDs",
  async (count) => {
    const f = fixture(count);
    let visible: unknown;
    f.editReply.mockImplementation((payload) => {
      const ids = componentCustomIds(payload);
      if (new Set(ids).size !== ids.length)
        return Promise.reject(new Error("Invalid form: duplicate component custom_id"));
      visible = payload;
      return Promise.resolve({ id: "100" });
    });
    const ticket = f.service.createSetup("1", "9")!;
    await expect(
      handleBulkCloseModal(f.modal(`btc:${ticket}:setup`), f.service),
    ).resolves.toBeUndefined();
    expect(visible).toMatchObject({
      content: "Select or deselect candidates, then confirm the selected subset.",
      components: expect.any(Array) as unknown,
    });
    expect(f.closeManually).not.toHaveBeenCalled();
  },
);

function controlled<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function liveShapeFixture() {
  const f = fixture(1);
  const data = new Map<string, unknown>([
    ["/guilds/1", { id: "1", owner_id: "7" }],
    [
      "/guilds/1/roles",
      [
        {
          id: "1",
          permissions: (
            PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ManageThreads
          ).toString(),
        },
      ],
    ],
    ["/guilds/1/members/9", { user: { id: "9" }, roles: [] }],
    ["/guilds/1/members/8", { user: { id: "8" }, roles: [] }],
    [
      "/channels/2",
      {
        id: "2",
        guild_id: "1",
        type: C.GuildText,
        name: "Protected parent",
        permission_overwrites: [],
      },
    ],
  ]);
  const raw = f.threads.map((thread) => ({
    id: thread.threadId,
    guild_id: thread.guildId,
    parent_id: thread.parentId,
    type: thread.type,
    name: thread.name,
    owner_id: thread.ownerId,
    thread_metadata: { archived: false, locked: false, create_timestamp: "2026-01-01T00:00:00Z" },
  }));
  data.set("/guilds/1/threads/active", { threads: raw });
  for (const thread of raw) data.set(`/channels/${thread.id}`, thread);
  const get = vi.fn((route: string) => Promise.resolve(data.get(route)));
  const mutation = vi.fn();
  const adapter = createBulkCloseDiscord({
    user: { id: "8" },
    rest: { get, patch: mutation, post: mutation, put: mutation, delete: mutation },
  } as unknown as Client);
  vi.mocked(f.discord.discover).mockImplementation(adapter.discover);
  vi.mocked(f.discord.observe).mockImplementation(adapter.observe);
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const retained: Promise<unknown>[] = [];
  const submit = () => {
    const ticket = f.service.createSetup("1", "9")!;
    return handleBulkCloseModal(f.modal(`btc:${ticket}:setup`), f.service, {
      logger,
      retain: (promise) => retained.push(promise),
    });
  };
  return { ...f, data, get, mutation, logger, retained, submit };
}

describe("bounded Modal preview preparation", () => {
  it("finishes real-shaped authorization, enumeration and rendering in order without write side effects", async () => {
    const f = liveShapeFixture();
    await f.submit();
    expect(f.get.mock.calls.slice(0, 5).map(([route]) => route)).toEqual([
      "/channels/2",
      "/guilds/1",
      "/guilds/1/roles",
      "/guilds/1/members/9",
      "/guilds/1/members/8",
    ]);
    expect(f.get.mock.calls[5]).toEqual(["/guilds/1/threads/active"]);
    expect(f.editReply.mock.calls.at(-1)?.[0]).toMatchObject({
      components: expect.any(Array) as unknown,
      embeds: expect.any(Array) as unknown,
    });
    const stages = f.logger.debug.mock.calls.map(([event]) => (event as { stage: string }).stage);
    expect(stages).toContain("candidate_render");
    expect(stages).toContain("candidate_update");
    expect(f.logger.warn).not.toHaveBeenCalled();
    expect(f.mutation).not.toHaveBeenCalled();
    expect(f.closeManually).not.toHaveBeenCalled();
    await Promise.allSettled(f.retained);
  });
  it.each([
    ["/guilds/1", "guild_fetch"],
    ["/guilds/1/roles", "roles_fetch"],
    ["/guilds/1/members/9", "actor_member_fetch"],
    ["/guilds/1/members/8", "bot_member_fetch"],
    ["/channels/2", "parent_fetch"],
    ["/guilds/1/threads/active", "active_enumeration"],
  ])(
    "bounds stalled %s, logs its stage and never renders a late snapshot",
    async (route, stage) => {
      vi.useFakeTimers();
      const f = liveShapeFixture();
      const gate = controlled<unknown>();
      f.get.mockImplementation((path) =>
        path === route ? gate.promise : Promise.resolve(f.data.get(path)),
      );
      const submitting = f.submit();
      let done = false;
      const completed = submitting.then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(BULK_PREPARATION_MS);
      await completed;
      expect(done).toBe(true);
      expect(f.editReply.mock.calls.at(-1)?.[0]).toMatchObject({
        content: BULK_PREPARATION_FAILURE,
        components: [],
        embeds: [],
        allowedMentions: { parse: [] },
      });
      expect(f.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "bulk_preview_boundary_failed",
          stage,
          failureCode: "TIMEOUT",
        }),
        "Bulk preview boundary failed",
      );
      if (stage !== "active_enumeration")
        expect(f.get).not.toHaveBeenCalledWith("/guilds/1/threads/active");
      const editCount = f.editReply.mock.calls.length;
      gate.resolve(f.data.get(route));
      await Promise.allSettled(f.retained);
      expect(f.editReply).toHaveBeenCalledTimes(editCount);
      if (stage !== "active_enumeration")
        expect(f.get).not.toHaveBeenCalledWith("/guilds/1/threads/active");
      expect(f.mutation).not.toHaveBeenCalled();
      expect(f.closeManually).not.toHaveBeenCalled();
      for (const [fields] of f.logger.warn.mock.calls)
        expect(Object.keys(fields as object).sort()).toEqual([
          "durationMs",
          "event",
          "failureCode",
          "stage",
        ]);
    },
  );
  it("replaces Preparing when the second fresh page authorization stalls", async () => {
    vi.useFakeTimers();
    const f = liveShapeFixture();
    const gate = controlled<unknown>();
    let rolesReads = 0;
    f.get.mockImplementation((route) =>
      route === "/guilds/1/roles" && ++rolesReads === 2
        ? gate.promise
        : Promise.resolve(f.data.get(route)),
    );
    const submitting = f.submit();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.editReply.mock.calls.at(-1)?.[0]).toMatchObject({
      content: "Preparing bulk-close preview…",
    });
    await vi.advanceTimersByTimeAsync(BULK_PREPARATION_MS);
    await submitting;
    expect(f.editReply.mock.calls.at(-1)?.[0]).toMatchObject({ content: BULK_PREPARATION_FAILURE });
    gate.resolve(f.data.get("/guilds/1/roles"));
    await Promise.allSettled(f.retained);
    expect(f.editReply.mock.calls.at(-1)?.[0]).toMatchObject({ content: BULK_PREPARATION_FAILURE });
    expect(f.closeManually).not.toHaveBeenCalled();
  });
  it("handles a rejected candidate update with a generic replacement and invalid session", async () => {
    const f = liveShapeFixture();
    let sessionId!: string;
    f.editReply.mockImplementation((payload) => {
      const ids = componentCustomIds(payload);
      if (ids.length) {
        sessionId = parseBulkCloseCustomId(ids[0]!)!.id;
        return Promise.reject(new Error(hostile));
      }
      return Promise.resolve({ id: "100" });
    });
    await f.submit();
    expect(
      f.service.findPreview(sessionId, { guildId: "1", actorId: "9", messageId: "100" }),
    ).toBeUndefined();
    expect(f.editReply.mock.calls.at(-1)?.[0]).toMatchObject({
      content: BULK_PREPARATION_FAILURE,
      components: [],
    });
    expect(f.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "candidate_update", failureCode: "FAILED" }),
      "Bulk preview boundary failed",
    );
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain(hostile);
    expect(f.closeManually).not.toHaveBeenCalled();
  });
  it("bounds a stalled candidate edit and a stalled failure edit while retaining both raw promises", async () => {
    vi.useFakeTimers();
    const f = liveShapeFixture();
    const gate = controlled<{ id: string }>();
    f.editReply.mockImplementation((payload) =>
      componentCustomIds(payload).length ||
      (payload as { content: string }).content === BULK_PREPARATION_FAILURE
        ? gate.promise
        : Promise.resolve({ id: "100" }),
    );
    const submitting = f.submit();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.editReply.mock.calls.at(-1)?.[0]).toMatchObject({
      components: expect.any(Array) as unknown,
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_INTERACTION_IO_TIMEOUT_MS * 2);
    await submitting;
    expect(f.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "candidate_update", failureCode: "TIMEOUT" }),
      "Bulk preview boundary failed",
    );
    expect(f.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "failure_response", failureCode: "TIMEOUT" }),
      "Bulk preview boundary failed",
    );
    let settled = false;
    const owned = Promise.allSettled(f.retained).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    gate.resolve({ id: "100" });
    await owned;
    expect(settled).toBe(true);
    expect(f.closeManually).not.toHaveBeenCalled();
  });
});

it("bounds the preparing-message edit without waiting on it to bind a session", async () => {
  vi.useFakeTimers();
  const f = liveShapeFixture();
  const gate = controlled<{ id: string }>();
  f.editReply.mockImplementation((payload) =>
    (payload as { content: string }).content === "Preparing bulk-close preview…"
      ? gate.promise
      : Promise.resolve({ id: "100" }),
  );
  const submitting = f.submit();
  await vi.advanceTimersByTimeAsync(DEFAULT_INTERACTION_IO_TIMEOUT_MS);
  await submitting;
  expect(f.logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ stage: "preparing_response", failureCode: "TIMEOUT" }),
    "Bulk preview boundary failed",
  );
  expect(f.editReply.mock.calls.at(-1)?.[0]).toMatchObject({ content: BULK_PREPARATION_FAILURE });
  gate.resolve({ id: "100" });
  await Promise.allSettled(f.retained);
  expect(f.discord.observe).not.toHaveBeenCalled();
  expect(f.closeManually).not.toHaveBeenCalled();
});

it("uses one preparation deadline across discovery and first-page reauthorization", async () => {
  vi.useFakeTimers();
  const f = liveShapeFixture();
  const discovery = controlled<unknown>();
  const page = controlled<unknown>();
  let rolesReads = 0;
  f.get.mockImplementation((route) =>
    route === "/guilds/1"
      ? discovery.promise
      : route === "/guilds/1/roles" && ++rolesReads === 2
        ? page.promise
        : Promise.resolve(f.data.get(route)),
  );
  const submitting = f.submit();
  await vi.advanceTimersByTimeAsync(BULK_PREPARATION_MS - 1000);
  discovery.resolve(f.data.get("/guilds/1"));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.editReply.mock.calls.at(-1)?.[0]).toMatchObject({
    content: "Preparing bulk-close preview…",
  });
  await vi.advanceTimersByTimeAsync(1000);
  await submitting;
  expect(f.editReply.mock.calls.at(-1)?.[0]).toMatchObject({ content: BULK_PREPARATION_FAILURE });
  page.resolve(f.data.get("/guilds/1/roles"));
  await Promise.allSettled(f.retained);
  expect(f.closeManually).not.toHaveBeenCalled();
});
