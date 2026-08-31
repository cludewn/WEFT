import { ChannelType, DiscordAPIError, HTTPError, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { Client, Message } from "discord.js";

import { createManagedMessageDiscord } from "../../src/managed-message-discord.js";

const input = {
  guildId: "700000000000000001",
  channelId: "800000000000000001",
  messageId: "900000000000000001",
  actorUserId: "600000000000000001",
  previousContent: "old content",
  content: "<@123456789012345678> <@&234567890123456789> @everyone @here",
};
const firstEditedAt = new Date("2026-08-31T01:00:00.000Z");
const secondEditedAt = new Date("2026-08-31T01:01:00.000Z");

describe("managed-message edit Discord boundary", () => {
  it("fresh-fetches current state and returns UNCHANGED only after authorization and coherence", async () => {
    const fixture = createFixture({ newContent: input.previousContent });

    await expect(
      createManagedMessageDiscord(fixture.client).editManagedMessage({
        ...input,
        content: input.previousContent,
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
        content: input.previousContent,
      }),
    ).resolves.toEqual({ outcome: "FAILURE", code: "ACTOR_PERMISSION_MISSING" });
    expect(fixture.fetchMessage).not.toHaveBeenCalled();
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
      content: input.content,
      allowedMentions: { parse: [] },
    });
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
    const fixture = createFixture({ oldContent: input.content, oldEditedAt: secondEditedAt });
    const discord = createManagedMessageDiscord(fixture.client);
    await expect(
      discord.restoreManagedMessage({
        guildId: input.guildId,
        channelId: input.channelId,
        messageId: input.messageId,
        expectedContent: input.content,
        expectedEditedAt: secondEditedAt,
        restoreContent: "old <@123456789012345678> @everyone content",
      }),
    ).resolves.toEqual({ outcome: "RESTORED" });
    expect(fixture.edit).toHaveBeenCalledExactlyOnceWith({
      content: "old <@123456789012345678> @everyone content",
      allowedMentions: { parse: [] },
    });
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
      return overrides.botCanView ?? true;
    },
  }));
  const edit = vi.fn((): Promise<Message> =>
    overrides.editFailure === undefined
      ? Promise.resolve(
          message({
            content: overrides.newContent ?? input.content,
            editedAt: secondEditedAt,
            edit,
            ...overrides,
          }),
        )
      : Promise.reject(overrides.editFailure),
  );
  const original = message({
    content: overrides.oldContent ?? input.previousContent,
    editedAt: overrides.oldEditedAt ?? firstEditedAt,
    edit,
    ...overrides,
  });
  const reconciled = message({
    content:
      overrides.reconcile === "OLD"
        ? (overrides.oldContent ?? input.previousContent)
        : overrides.reconcile === "UNEXPECTED"
          ? "unexpected"
          : input.content,
    editedAt:
      overrides.reconcile === "OLD" ? (overrides.oldEditedAt ?? firstEditedAt) : secondEditedAt,
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
    editedAt: inputOverrides.editedAt,
    editable: inputOverrides.editable ?? true,
    edit: inputOverrides.edit,
  } as unknown as Message;
}
