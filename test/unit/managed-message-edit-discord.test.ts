import {
  ChannelType,
  DiscordAPIError,
  EmbedType,
  HTTPError,
  PermissionFlagsBits,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { Client, Embed, Message } from "discord.js";

import { createManagedMessageDiscord } from "../../src/managed-message-discord.js";

const input = {
  guildId: "700000000000000001",
  channelId: "800000000000000001",
  messageId: "900000000000000001",
  actorUserId: "600000000000000001",
  previousPayload: { content: "old content", embed: null },
  payload: {
    content: "<@123456789012345678> <@&234567890123456789> @everyone @here",
    embed: null,
  },
};
const firstEditedAt = new Date("2026-08-31T01:00:00.000Z");
const secondEditedAt = new Date("2026-08-31T01:01:00.000Z");

describe("managed-message edit Discord boundary", () => {
  it("fresh-fetches current state and returns UNCHANGED only after authorization and coherence", async () => {
    const fixture = createFixture({ newContent: input.previousPayload.content });

    await expect(
      createManagedMessageDiscord(fixture.client).editManagedMessage({
        ...input,
        payload: input.previousPayload,
      }),
    ).resolves.toEqual({ outcome: "UNCHANGED" });
    expect(fixture.fetchChannel).toHaveBeenCalledExactlyOnceWith(input.channelId, { force: true });
    expect(fixture.fetchMember).toHaveBeenCalledTimes(2);
    expect(fixture.fetchMessage).toHaveBeenCalledExactlyOnceWith({
      message: input.messageId,
      force: true,
      cache: false,
    });
    expect(fixture.edit).not.toHaveBeenCalled();
  });

  it("does not let an apparent no-op bypass current actor authorization", async () => {
    const fixture = createFixture({ actorCanManage: false });

    await expect(
      createManagedMessageDiscord(fixture.client).editManagedMessage({
        ...input,
        payload: input.previousPayload,
      }),
    ).resolves.toEqual({ outcome: "FAILURE", code: "ACTOR_PERMISSION_MISSING" });
    expect(fixture.fetchMessage).not.toHaveBeenCalled();
  });

  it("requires complete embed coherence before a full-payload no-op", async () => {
    const persisted = {
      content: "old content",
      embed: { title: "Persisted", color: 0 },
    };
    const coherent = createFixture({ oldEmbeds: [richEmbed({ title: "Persisted", color: 0 })] });
    await expect(
      createManagedMessageDiscord(coherent.client).editManagedMessage({
        ...input,
        previousPayload: persisted,
        payload: persisted,
      }),
    ).resolves.toEqual({ outcome: "UNCHANGED" });
    expect(coherent.edit).not.toHaveBeenCalled();

    const mismatch = createFixture({ oldEmbeds: [richEmbed({ title: "Manual difference" })] });
    await expect(
      createManagedMessageDiscord(mismatch.client).editManagedMessage({
        ...input,
        previousPayload: persisted,
        payload: persisted,
      }),
    ).resolves.toEqual({ outcome: "FAILURE", code: "STATE_MISMATCH" });
    expect(mismatch.edit).not.toHaveBeenCalled();
  });

  it("returns UNCHANGED for a coherent embed no-op after EmbedLinks is lost", async () => {
    const persisted = {
      content: "old content",
      embed: { title: "Persisted", color: 0 },
    };
    const fixture = createFixture({
      botCanEmbed: false,
      oldEmbeds: [richEmbed({ title: "Persisted", color: 0 })],
    });

    await expect(
      createManagedMessageDiscord(fixture.client).editManagedMessage({
        ...input,
        previousPayload: persisted,
        payload: persisted,
      }),
    ).resolves.toEqual({ outcome: "UNCHANGED" });
    expect(fixture.fetchMessage).toHaveBeenCalledOnce();
    expect(fixture.edit).not.toHaveBeenCalled();
  });

  it.each([
    [
      "adds an embed",
      [],
      input.previousPayload,
      { content: input.payload.content, embed: { title: "Added" } },
    ],
    [
      "maintains an embed while changing content",
      [richEmbed({ title: "Maintained" })],
      { content: input.previousPayload.content, embed: { title: "Maintained" } },
      { content: input.payload.content, embed: { title: "Maintained" } },
    ],
  ])("requires EmbedLinks when an actual PATCH %s", async (_label, oldEmbeds, previous, next) => {
    const fixture = createFixture({ botCanEmbed: false, oldEmbeds });

    await expect(
      createManagedMessageDiscord(fixture.client).editManagedMessage({
        ...input,
        previousPayload: previous,
        payload: next,
      }),
    ).resolves.toEqual({ outcome: "FAILURE", code: "BOT_PERMISSION_MISSING" });
    expect(fixture.fetchMessage).toHaveBeenCalledOnce();
    expect(fixture.edit).not.toHaveBeenCalled();
  });

  it("treats rich image alt text as a state mismatch without silently removing it", async () => {
    const persisted = {
      content: input.previousPayload.content,
      embed: { title: "Persisted", imageUrl: "https://example.invalid/image.png" },
    };
    const fixture = createFixture({
      oldEmbeds: [
        richEmbed({
          title: "Persisted",
          image: {
            url: "https://example.invalid/image.png",
            description: "meaningful alt text",
          },
        }),
      ],
    });

    await expect(
      createManagedMessageDiscord(fixture.client).editManagedMessage({
        ...input,
        previousPayload: persisted,
        payload: { content: input.payload.content, embed: null },
      }),
    ).resolves.toEqual({ outcome: "FAILURE", code: "STATE_MISMATCH" });
    expect(fixture.edit).not.toHaveBeenCalled();
  });

  it("classifies only Discord Unknown Message as confirmed deletion", async () => {
    const fixture = createFixture({ fetchFailure: unknownMessageError() });
    await expect(
      createManagedMessageDiscord(fixture.client).editManagedMessage(input),
    ).resolves.toEqual({
      outcome: "DELETED",
    });

    const transient = createFixture({ fetchFailure: new Error("transport") });
    await expect(
      createManagedMessageDiscord(transient.client).editManagedMessage(input),
    ).resolves.toEqual({
      outcome: "FAILURE",
      code: "CURRENT_STATE_CHECK_FAILED",
    });
  });

  it("blocks Discord/managed content mismatch without PATCH", async () => {
    const fixture = createFixture({ oldContent: "manual Discord change" });
    await expect(
      createManagedMessageDiscord(fixture.client).editManagedMessage(input),
    ).resolves.toEqual({
      outcome: "FAILURE",
      code: "STATE_MISMATCH",
    });
    expect(fixture.edit).not.toHaveBeenCalled();
  });

  it("edits only a current WEFT-authored editable message with mention suppression", async () => {
    const fixture = createFixture();
    await expect(
      createManagedMessageDiscord(fixture.client).editManagedMessage(input),
    ).resolves.toEqual({
      outcome: "EDITED",
      editedAt: secondEditedAt,
    });
    expect(fixture.edit).toHaveBeenCalledExactlyOnceWith({
      content: input.payload.content,
      embeds: [],
      allowedMentions: { parse: [] },
    });
  });

  it("adds, removes, and clears content with a complete explicit payload PATCH", async () => {
    const added = richEmbed({ title: "New embed", color: 0 });
    const addFixture = createFixture({ newEmbeds: [added] });
    await expect(
      createManagedMessageDiscord(addFixture.client).editManagedMessage({
        ...input,
        payload: { content: input.payload.content, embed: { title: "New embed", color: 0 } },
      }),
    ).resolves.toMatchObject({ outcome: "EDITED" });
    const addOptions = (
      addFixture.edit.mock.calls as unknown as Array<
        [{ content: string | null; embeds: unknown[]; allowedMentions: unknown }]
      >
    )[0]?.[0];
    expect(addOptions).toMatchObject({
      content: input.payload.content,
      allowedMentions: { parse: [] },
    });
    expect(addOptions?.embeds).toHaveLength(1);

    const old = richEmbed({ title: "Old embed" });
    const removeFixture = createFixture({ oldEmbeds: [old], newEmbeds: [] });
    await expect(
      createManagedMessageDiscord(removeFixture.client).editManagedMessage({
        ...input,
        previousPayload: { content: input.previousPayload.content, embed: { title: "Old embed" } },
      }),
    ).resolves.toMatchObject({ outcome: "EDITED" });
    expect(removeFixture.edit).toHaveBeenCalledWith(expect.objectContaining({ embeds: [] }));

    const embedOnlyFixture = createFixture({
      oldEmbeds: [old],
      newContent: "",
      newEmbeds: [old],
    });
    await expect(
      createManagedMessageDiscord(embedOnlyFixture.client).editManagedMessage({
        ...input,
        previousPayload: { content: input.previousPayload.content, embed: { title: "Old embed" } },
        payload: { content: "", embed: { title: "Old embed" } },
      }),
    ).resolves.toMatchObject({ outcome: "EDITED" });
    expect(embedOnlyFixture.edit).toHaveBeenCalledWith(expect.objectContaining({ content: null }));
  });

  it.each([
    ["wrong author", { authorId: "other-bot" }, "MESSAGE_INVALID"],
    ["wrong identity", { messageId: "900000000000000002" }, "MESSAGE_INVALID"],
    ["not editable", { editable: false }, "BOT_PERMISSION_MISSING"],
  ] as const)("rejects %s", async (_label, overrides, code) => {
    const fixture = createFixture(overrides);
    await expect(
      createManagedMessageDiscord(fixture.client).editManagedMessage(input),
    ).resolves.toEqual({
      outcome: "FAILURE",
      code,
    });
    expect(fixture.edit).not.toHaveBeenCalled();
  });

  it("rejects an archived thread without fetching the message", async () => {
    const fixture = createFixture({ type: ChannelType.PublicThread, archived: true });
    await expect(
      createManagedMessageDiscord(fixture.client).editManagedMessage(input),
    ).resolves.toEqual({
      outcome: "FAILURE",
      code: "ARCHIVED_THREAD",
    });
    expect(fixture.fetchMessage).not.toHaveBeenCalled();
  });

  it("reconciles one ambiguous PATCH as applied only with exact content and advanced timestamp", async () => {
    const fixture = createFixture({ editFailure: new Error("transport"), reconcile: "NEW" });
    await expect(
      createManagedMessageDiscord(fixture.client).editManagedMessage(input),
    ).resolves.toEqual({
      outcome: "EDITED",
      editedAt: secondEditedAt,
    });
    expect(fixture.edit).toHaveBeenCalledOnce();
    expect(fixture.fetchMessage).toHaveBeenCalledTimes(2);
  });

  it("reconciles an ambiguous embed PATCH only from the exact complete applied payload", async () => {
    const applied = richEmbed({
      title: "Applied",
      description: "Complete",
      color: 0x123456,
      image: { url: "https://example.invalid/applied.png" },
    });
    const fixture = createFixture({
      editFailure: new Error("transport"),
      reconcile: "NEW",
      newEmbeds: [applied],
    });

    await expect(
      createManagedMessageDiscord(fixture.client).editManagedMessage({
        ...input,
        payload: {
          content: input.payload.content,
          embed: {
            title: "Applied",
            description: "Complete",
            color: 0x123456,
            imageUrl: "https://example.invalid/applied.png",
          },
        },
      }),
    ).resolves.toEqual({ outcome: "EDITED", editedAt: secondEditedAt });
    expect(fixture.edit).toHaveBeenCalledOnce();
    expect(fixture.fetchMessage).toHaveBeenCalledTimes(2);
  });

  it("confirms ambiguous embed removal only when the reconciled rich embed is absent", async () => {
    const old = richEmbed({ title: "Removed", color: 0xabcdef });
    const fixture = createFixture({
      oldEmbeds: [old],
      editFailure: new Error("transport"),
      reconcile: "NEW",
      newEmbeds: [],
    });

    await expect(
      createManagedMessageDiscord(fixture.client).editManagedMessage({
        ...input,
        previousPayload: {
          content: input.previousPayload.content,
          embed: { title: "Removed", color: 0xabcdef },
        },
      }),
    ).resolves.toEqual({ outcome: "EDITED", editedAt: secondEditedAt });
    expect(fixture.edit).toHaveBeenCalledOnce();
    expect(fixture.fetchMessage).toHaveBeenCalledTimes(2);
  });

  it("classifies one ambiguous PATCH with exact old state as not applied and never patches twice", async () => {
    const fixture = createFixture({ editFailure: new Error("transport"), reconcile: "OLD" });
    await expect(
      createManagedMessageDiscord(fixture.client).editManagedMessage(input),
    ).resolves.toEqual({
      outcome: "FAILURE",
      code: "EDIT_NOT_APPLIED",
    });
    expect(fixture.edit).toHaveBeenCalledOnce();
    expect(fixture.fetchMessage).toHaveBeenCalledTimes(2);
  });

  it("keeps unexpected or unreadable ambiguous reconciliation unconfirmed", async () => {
    const unexpected = createFixture({
      editFailure: new Error("transport"),
      reconcile: "UNEXPECTED",
    });
    await expect(
      createManagedMessageDiscord(unexpected.client).editManagedMessage(input),
    ).resolves.toEqual({
      outcome: "FAILURE",
      code: "EDIT_UNCONFIRMED",
    });
    const unreadable = createFixture({
      editFailure: new Error("transport"),
      reconcileFailure: new Error("second transport"),
    });
    await expect(
      createManagedMessageDiscord(unreadable.client).editManagedMessage(input),
    ).resolves.toEqual({
      outcome: "FAILURE",
      code: "EDIT_UNCONFIRMED",
    });
    expect(unexpected.edit).toHaveBeenCalledOnce();
    expect(unreadable.edit).toHaveBeenCalledOnce();
  });

  it("keeps a mixed content/embed ambiguous result unconfirmed without a second PATCH", async () => {
    const fixture = createFixture({
      editFailure: new Error("transport"),
      reconcile: "NEW",
      reconcileEmbeds: [],
    });
    await expect(
      createManagedMessageDiscord(fixture.client).editManagedMessage({
        ...input,
        payload: { content: input.payload.content, embed: { title: "new embed" } },
      }),
    ).resolves.toEqual({ outcome: "FAILURE", code: "EDIT_UNCONFIRMED" });
    expect(fixture.edit).toHaveBeenCalledOnce();
  });

  it("keeps wrong content with the exact non-null embed unconfirmed without a second PATCH", async () => {
    const expectedEmbed = richEmbed({ title: "new embed", color: 0x123456 });
    const fixture = createFixture({
      editFailure: new Error("transport"),
      reconcile: "UNEXPECTED",
      newEmbeds: [expectedEmbed],
    });

    await expect(
      createManagedMessageDiscord(fixture.client).editManagedMessage({
        ...input,
        payload: {
          content: input.payload.content,
          embed: { title: "new embed", color: 0x123456 },
        },
      }),
    ).resolves.toEqual({ outcome: "FAILURE", code: "EDIT_UNCONFIRMED" });
    expect(fixture.edit).toHaveBeenCalledOnce();
    expect(fixture.fetchMessage).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["partial embed-field mismatch", richEmbed({ title: "new embed", color: 1 })],
    [
      "unexpected rich state",
      richEmbed({ title: "new embed", color: 0, fields: [{ name: "unexpected", value: "state" }] }),
    ],
  ])("keeps %s in ambiguous reconciliation unconfirmed", async (_label, reconciledEmbed) => {
    const fixture = createFixture({
      editFailure: new Error("transport"),
      reconcile: "NEW",
      reconcileEmbeds: [reconciledEmbed],
    });

    await expect(
      createManagedMessageDiscord(fixture.client).editManagedMessage({
        ...input,
        payload: { content: input.payload.content, embed: { title: "new embed", color: 0 } },
      }),
    ).resolves.toEqual({ outcome: "FAILURE", code: "EDIT_UNCONFIRMED" });
    expect(fixture.edit).toHaveBeenCalledOnce();
  });

  it("does not reconcile or retry a confirmed Discord 4xx edit rejection", async () => {
    const fixture = createFixture({
      editFailure: new HTTPError(403, "Forbidden", "PATCH", "https://discord.invalid", {
        body: undefined,
        files: undefined,
      }),
    });
    await expect(
      createManagedMessageDiscord(fixture.client).editManagedMessage(input),
    ).resolves.toEqual({
      outcome: "FAILURE",
      code: "EDIT_REJECTED",
    });
    expect(fixture.edit).toHaveBeenCalledOnce();
    expect(fixture.fetchMessage).toHaveBeenCalledOnce();
  });

  it("restores once only from the exact confirmed new Discord state with mention suppression", async () => {
    const restoreContent = "old <@123456789012345678> @everyone content";
    const fixture = createFixture({
      oldContent: input.payload.content,
      newContent: restoreContent,
      oldEditedAt: secondEditedAt,
    });
    const discord = createManagedMessageDiscord(fixture.client);
    await expect(
      discord.restoreManagedMessage({
        guildId: input.guildId,
        channelId: input.channelId,
        messageId: input.messageId,
        expectedPayload: input.payload,
        expectedEditedAt: secondEditedAt,
        restorePayload: { content: restoreContent, embed: null },
      }),
    ).resolves.toEqual({ outcome: "RESTORED" });
    expect(fixture.edit).toHaveBeenCalledExactlyOnceWith({
      content: restoreContent,
      embeds: [],
      allowedMentions: { parse: [] },
    });
  });

  it("restores the complete previous embed-only payload and confirms the returned projection", async () => {
    const expectedEmbed = richEmbed({ title: "Applied", color: 0xabcdef });
    const restoredEmbed = richEmbed({
      description: "Restored",
      image: { url: "https://example.invalid/restored.png" },
    });
    const fixture = createFixture({
      oldContent: "applied content",
      oldEmbeds: [expectedEmbed],
      oldEditedAt: secondEditedAt,
      newContent: "",
      newEmbeds: [restoredEmbed],
    });
    await expect(
      createManagedMessageDiscord(fixture.client).restoreManagedMessage({
        guildId: input.guildId,
        channelId: input.channelId,
        messageId: input.messageId,
        expectedPayload: {
          content: "applied content",
          embed: { title: "Applied", color: 0xabcdef },
        },
        expectedEditedAt: secondEditedAt,
        restorePayload: {
          content: "",
          embed: {
            description: "Restored",
            imageUrl: "https://example.invalid/restored.png",
          },
        },
      }),
    ).resolves.toEqual({ outcome: "RESTORED" });
    const options = (
      fixture.edit.mock.calls as unknown as Array<
        [{ content: string | null; embeds: Array<{ toJSON: () => unknown }> }]
      >
    )[0]?.[0];
    expect(options?.content).toBeNull();
    expect(options?.embeds).toHaveLength(1);
    expect(options?.embeds[0]?.toJSON()).toEqual({
      description: "Restored",
      image: { url: "https://example.invalid/restored.png" },
    });
  });

  it("restores a combined text-and-embed payload as one complete PATCH", async () => {
    const applied = richEmbed({ title: "Applied" });
    const restored = richEmbed({ title: "Restored", color: 0x123456 });
    const fixture = createFixture({
      oldContent: "applied content",
      oldEmbeds: [applied],
      oldEditedAt: secondEditedAt,
      newContent: "restored content",
      newEmbeds: [restored],
    });

    await expect(
      createManagedMessageDiscord(fixture.client).restoreManagedMessage({
        guildId: input.guildId,
        channelId: input.channelId,
        messageId: input.messageId,
        expectedPayload: { content: "applied content", embed: { title: "Applied" } },
        expectedEditedAt: secondEditedAt,
        restorePayload: {
          content: "restored content",
          embed: { title: "Restored", color: 0x123456 },
        },
      }),
    ).resolves.toEqual({ outcome: "RESTORED" });
    const options = (
      fixture.edit.mock.calls as unknown as Array<
        [{ content: string | null; embeds: Array<{ toJSON: () => unknown }> }]
      >
    )[0]?.[0];
    expect(options?.content).toBe("restored content");
    expect(options?.embeds[0]?.toJSON()).toEqual({ title: "Restored", color: 0x123456 });
  });

  it("restores a text-only old payload after a new embed was applied", async () => {
    const applied = richEmbed({ title: "Applied", color: 0xabcdef });
    const fixture = createFixture({
      oldContent: "applied content",
      oldEmbeds: [applied],
      oldEditedAt: secondEditedAt,
      newContent: "old text only",
      newEmbeds: [],
    });

    await expect(
      createManagedMessageDiscord(fixture.client).restoreManagedMessage({
        guildId: input.guildId,
        channelId: input.channelId,
        messageId: input.messageId,
        expectedPayload: {
          content: "applied content",
          embed: { title: "Applied", color: 0xabcdef },
        },
        expectedEditedAt: secondEditedAt,
        restorePayload: { content: "old text only", embed: null },
      }),
    ).resolves.toEqual({ outcome: "RESTORED" });
    expect(fixture.edit).toHaveBeenCalledExactlyOnceWith({
      content: "old text only",
      embeds: [],
      allowedMentions: { parse: [] },
    });
  });

  it("does not compensate when the current Discord embed differs from the expected new payload", async () => {
    const fixture = createFixture({
      oldContent: "applied content",
      oldEmbeds: [richEmbed({ title: "Manual difference", color: 0xabcdef })],
      oldEditedAt: secondEditedAt,
    });

    await expect(
      createManagedMessageDiscord(fixture.client).restoreManagedMessage({
        guildId: input.guildId,
        channelId: input.channelId,
        messageId: input.messageId,
        expectedPayload: {
          content: "applied content",
          embed: { title: "Applied", color: 0xabcdef },
        },
        expectedEditedAt: secondEditedAt,
        restorePayload: { content: "old content", embed: null },
      }),
    ).resolves.toEqual({ outcome: "PRECONDITION_FAILED" });
    expect(fixture.edit).not.toHaveBeenCalled();
  });
});

function unknownMessageError(): DiscordAPIError {
  return new DiscordAPIError(
    { message: "Unknown Message", code: 10_008 },
    10_008,
    404,
    "GET",
    "https://discord.invalid",
    { body: undefined, files: undefined },
  );
}

function createFixture(
  overrides: {
    type?: ChannelType;
    archived?: boolean;
    actorCanManage?: boolean;
    botCanView?: boolean;
    botCanEmbed?: boolean;
    authorId?: string;
    messageId?: string;
    editable?: boolean;
    oldContent?: string;
    newContent?: string;
    oldEditedAt?: Date;
    fetchFailure?: Error;
    editFailure?: Error;
    reconcile?: "NEW" | "OLD" | "UNEXPECTED";
    reconcileFailure?: Error;
    oldEmbeds?: Embed[];
    newEmbeds?: Embed[];
    reconcileEmbeds?: Embed[];
  } = {},
) {
  const type = overrides.type ?? ChannelType.GuildText;
  const thread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(type);
  const fetchMember = vi.fn(({ user }: { user: string }) => Promise.resolve({ id: user }));
  const permissionsFor = vi.fn((member: { id: string }) => ({
    has: (permission: unknown) => {
      if (member.id === input.actorUserId && permission === PermissionFlagsBits.ManageMessages) {
        return overrides.actorCanManage ?? true;
      }
      if (permission === PermissionFlagsBits.EmbedLinks) return overrides.botCanEmbed ?? true;
      return overrides.botCanView ?? true;
    },
  }));
  const edit = vi.fn((): Promise<Message> =>
    overrides.editFailure === undefined
      ? Promise.resolve(
          message({
            content: overrides.newContent ?? input.payload.content,
            embeds: overrides.newEmbeds ?? [],
            editedAt: secondEditedAt,
            edit,
            ...overrides,
          }),
        )
      : Promise.reject(overrides.editFailure),
  );
  const original = message({
    content: overrides.oldContent ?? input.previousPayload.content,
    embeds: overrides.oldEmbeds ?? [],
    editedAt: overrides.oldEditedAt ?? firstEditedAt,
    edit,
    ...overrides,
  });
  const reconciled = message({
    content:
      overrides.reconcile === "OLD"
        ? (overrides.oldContent ?? input.previousPayload.content)
        : overrides.reconcile === "UNEXPECTED"
          ? "unexpected"
          : input.payload.content,
    editedAt:
      overrides.reconcile === "OLD" ? (overrides.oldEditedAt ?? firstEditedAt) : secondEditedAt,
    embeds:
      overrides.reconcileEmbeds ??
      (overrides.reconcile === "OLD" ? (overrides.oldEmbeds ?? []) : (overrides.newEmbeds ?? [])),
    edit,
    ...overrides,
  });
  const fetchMessage = vi.fn(() => {
    if (overrides.fetchFailure !== undefined) return Promise.reject(overrides.fetchFailure);
    return Promise.resolve(original);
  });
  if (overrides.editFailure !== undefined) {
    fetchMessage.mockResolvedValueOnce(original);
    if (overrides.reconcileFailure === undefined) {
      fetchMessage.mockResolvedValueOnce(reconciled);
    } else {
      fetchMessage.mockRejectedValueOnce(overrides.reconcileFailure);
    }
  }
  const channel = {
    id: input.channelId,
    guildId: input.guildId,
    type,
    archived: overrides.archived ?? false,
    isThread: () => thread,
    guild: { members: { fetch: fetchMember } },
    permissionsFor,
    messages: { fetch: fetchMessage },
  };
  const fetchChannel = vi.fn(() => Promise.resolve(channel));
  const client = {
    user: { id: "bot-id" },
    channels: { fetch: fetchChannel },
  } as unknown as Client;
  return { client, fetchChannel, fetchMember, fetchMessage, edit };
}

function message(inputOverrides: {
  content: string;
  editedAt: Date;
  edit: ReturnType<typeof vi.fn>;
  embeds?: Embed[];
  authorId?: string;
  messageId?: string;
  editable?: boolean;
}): Message {
  return {
    id: inputOverrides.messageId ?? input.messageId,
    guildId: input.guildId,
    channelId: input.channelId,
    author: { id: inputOverrides.authorId ?? "bot-id" },
    content: inputOverrides.content,
    embeds: inputOverrides.embeds ?? [],
    editedAt: inputOverrides.editedAt,
    editable: inputOverrides.editable ?? true,
    edit: inputOverrides.edit,
  } as unknown as Message;
}

function richEmbed(data: Record<string, unknown>): Embed {
  return { data: { type: EmbedType.Rich, ...data } } as unknown as Embed;
}
