import { EventEmitter } from "node:events";
import {
  ButtonStyle,
  ChannelType as C,
  Events,
  MessageFlags,
  PermissionFlagsBits as P,
} from "discord.js";
import type { ButtonInteraction, Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  createLinkPreviewDiscord,
  handlePreviewButton,
  PREVIEW_FAILURE,
  registerLinkPreviewHandlers,
} from "../../src/link-preview-discord.js";
import {
  createLinkPreviewService,
  originalUrl,
  previewCustomId,
  previewNonce,
} from "../../src/link-preview.js";
import type { LinkPreviewService } from "../../src/link-preview.js";
import {
  memberPermissions,
  previewChannelSchema,
  previewMemberSchema,
  previewRolesSchema,
  READ_BITS,
  safePublicPermissions,
} from "../../src/link-preview-permissions.js";
import { registerAutomaticCloseActivityHandlers } from "../../src/discord.js";

const target = { guildId: "1", channelId: "2", messageId: "3" };
const readable = READ_BITS | P.SendMessages | P.SendMessagesInThreads | P.EmbedLinks;
const channel = () => ({
  id: "2",
  guild_id: "1",
  name: "SECRET_CHANNEL",
  type: C.GuildText,
  nsfw: false,
  permission_overwrites: [] as { id: string; type: number; allow: string; deny: string }[],
});
function fixture() {
  const data = new Map<string, unknown>([
    ["/channels/2", channel()],
    ["/channels/4", { ...channel(), id: "4" }],
    ["/guilds/1", { id: "1", owner_id: "10" }],
    [
      "/guilds/1/roles",
      [
        { id: "1", permissions: readable.toString() },
        { id: "6", permissions: "0" },
      ],
    ],
    ["/guilds/1/members/9", { user: { id: "9" }, roles: [] }],
    ["/guilds/1/members/8", { user: { id: "8" }, roles: [] }],
    ["/channels/2/thread-members/9", { id: "2", user_id: "9" }],
    ["/channels/2/thread-members/8", { id: "2", user_id: "8" }],
    [
      "/channels/2/messages/3",
      {
        id: "3",
        channel_id: "2",
        author: {
          id: "7",
          username: "SECRET_USER",
          global_name: "SECRET_GLOBAL",
          avatar: "SECRET_AVATAR",
        },
        content: "SECRET_CONTENT",
        timestamp: "2026-01-01T00:00:00Z",
        type: 0,
        attachments: [],
        embeds: [],
      },
    ],
    ["/guilds/1/members/7", { nick: "SECRET_NICK", avatar: "SECRET_GUILD_AVATAR" }],
  ]);
  const get = vi.fn((route: string) => {
    if (!data.has(route)) return Promise.reject(new Error("SECRET_FAILURE"));
    return Promise.resolve(data.get(route));
  });
  const post = vi.fn<
    (route: string, options: { body: Record<string, unknown> }) => Promise<object>
  >(() => Promise.resolve({}));
  const client = Object.assign(new EventEmitter(), {
    user: { id: "8" },
    application: { id: "11" },
    rest: { get, post },
    channels: { cache: new Map() },
  }) as unknown as Client;
  return { data, get, post, client, discord: createLinkPreviewDiscord(client) };
}
function thread(f: ReturnType<typeof fixture>, type: C, parentType = C.GuildText) {
  f.data.set("/channels/2", {
    ...channel(),
    type,
    parent_id: "4",
    thread_metadata: { archived: true, locked: true },
  });
  f.data.set("/channels/4", { ...channel(), id: "4", type: parentType });
}
describe("source reply membership policy and no explicit thread mutations", () => {
  const source = { guildId: "1", channelId: "14", messageId: "15", content: originalUrl(target) };
  const membershipRoute = "/channels/14/thread-members/8";
  function sourceFixture(type = C.PublicThread, parentType = C.GuildText) {
    const f = fixture();
    const mutations = {
      put: vi.fn(() => Promise.resolve({})),
      patch: vi.fn(() => Promise.resolve({})),
      delete: vi.fn(() => Promise.resolve({})),
    };
    Object.assign(f.client.rest, mutations);
    f.data.set("/channels/14", {
      ...channel(),
      id: "14",
      type,
      parent_id: "16",
      thread_metadata: { archived: false, locked: false },
    });
    f.data.set("/channels/16", { ...channel(), id: "16", type: parentType });
    f.data.set(membershipRoute, { id: "14", user_id: "8" });
    const log = vi.fn();
    const service = createLinkPreviewService({
      readMode: () => Promise.resolve("hybrid" as const),
      discord: f.discord,
      log,
    });
    return { ...f, service, log, mutations };
  }
  function expectNoMutation(f: ReturnType<typeof sourceFixture>, sends = 0) {
    // Track all write verbs, including join (PUT) and unarchive/unlock (PATCH).
    expect(f.post.mock.calls.map(([route]) => route)).toEqual(
      Array.from({ length: sends }, () => "/channels/14/messages"),
    );
    for (const mutation of Object.values(f.mutations)) expect(mutation).not.toHaveBeenCalled();
    expect(JSON.stringify(f.log.mock.calls)).not.toContain("SECRET_");
  }
  it("also revalidates current source permissions for ordinary channels", async () => {
    const f = sourceFixture(C.GuildText);
    const fetchMessage = f.discord.fetchMessage;
    f.discord.fetchMessage = async (link) => {
      const message = await fetchMessage(link);
      f.data.set("/guilds/1/roles", [
        { id: "1", permissions: (readable & ~P.SendMessages).toString() },
      ]);
      return message;
    };
    await f.service.detect(source);
    expect(f.get.mock.calls.filter(([route]) => route === "/channels/14")).toHaveLength(2);
    expect(f.get).not.toHaveBeenCalledWith(membershipRoute);
    expectNoMutation(f);
  });
  it.each([
    [C.PublicThread, C.GuildText],
    [C.AnnouncementThread, C.GuildAnnouncement],
    [C.PublicThread, C.GuildForum],
  ])("permits an active public source %s/%s regardless of membership", async (type, parentType) => {
    const payloads: string[] = [];
    for (const joined of [false, true]) {
      const f = sourceFixture(type, parentType);
      if (!joined) f.data.delete(membershipRoute);
      // Deliberately contradict REST membership; public sources do not consult either authority.
      Object.assign(f.client, {
        channels: {
          cache: new Map([["14", { members: { cache: new Map(joined ? [] : [["8", {}]]) } }]]),
        },
      });
      await f.service.detect(source);
      expect(f.get).not.toHaveBeenCalledWith(membershipRoute);
      expect(f.get.mock.calls.filter(([route]) => route === "/channels/14")).toHaveLength(2);
      expectNoMutation(f, 1);
      const body = f.post.mock.calls[0]![1].body;
      expect(body).toMatchObject({ nonce: previewNonce(source), enforce_nonce: true });
      payloads.push(JSON.stringify(body));
    }
    expect(payloads[0]).toBe(payloads[1]);
  });
  it("requires fresh membership and permits a joined private source", async () => {
    const f = sourceFixture(C.PrivateThread);
    await f.service.detect(source);
    expect(f.get.mock.calls.filter(([route]) => route === membershipRoute)).toHaveLength(2);
    expect(f.get.mock.calls.filter(([route]) => route === "/channels/14")).toHaveLength(2);
    expectNoMutation(f, 1);
    expect(f.post.mock.calls[0]![1].body).toMatchObject({
      nonce: previewNonce(source),
      enforce_nonce: true,
    });
  });
  it.each([0n, P.ManageThreads, P.Administrator])(
    "never bypasses unjoined private source with permissions %s",
    async (extra) => {
      const f = sourceFixture(C.PrivateThread);
      f.data.set("/guilds/1/roles", [{ id: "1", permissions: (readable | extra).toString() }]);
      f.data.delete(membershipRoute);
      expect(await f.discord.sourceSendable(source)).toBe(false);
      expect(f.get).toHaveBeenCalledWith(membershipRoute);
      await f.service.detect(source);
      expect(f.get.mock.calls.some(([route]) => route.includes("/messages/"))).toBe(false);
      expectNoMutation(f);
    },
  );
  it.each([undefined, {}, { id: "99", user_id: "8" }, { id: "14", user_id: "9" }])(
    "fails closed on missing or invalid private source membership %j",
    async (membership) => {
      const f = sourceFixture(C.PrivateThread);
      f.data.set(membershipRoute, membership);
      await f.service.detect(source);
      expect(f.get).toHaveBeenCalledWith(membershipRoute);
      expectNoMutation(f);
    },
  );
  it.each([404, 503])(
    "fails closed on private source membership REST status %s",
    async (status) => {
      const f = sourceFixture(C.PrivateThread);
      const get = f.get.getMockImplementation()!;
      f.get.mockImplementation((route) =>
        route === membershipRoute
          ? Promise.reject(Object.assign(new Error("SECRET_FAILURE"), { status }))
          : get(route),
      );
      await f.service.detect(source);
      expect(f.get).toHaveBeenCalledWith(membershipRoute);
      expectNoMutation(f);
    },
  );
  it.each(
    [
      "archived",
      "locked",
      "send-permission",
      "view-permission",
      "history-permission",
      "embed-permission",
      "membership",
      "deleted",
      "guild",
      "identity",
      "unsupported",
    ].flatMap((change) =>
      (change === "membership" ? [C.PrivateThread] : [C.PublicThread, C.PrivateThread]).map(
        (type) => [change, type] as const,
      ),
    ),
  )(
    "suppresses reply when source loses %s during target preparation in type %s",
    async (change, type) => {
      const f = sourceFixture(type);
      const fetchMessage = f.discord.fetchMessage;
      f.discord.fetchMessage = async (link) => {
        const message = await fetchMessage(link);
        const state = f.data.get("/channels/14") as Record<string, unknown>;
        if (change === "archived" || change === "locked")
          f.data.set("/channels/14", {
            ...state,
            thread_metadata: { archived: change === "archived", locked: change === "locked" },
          });
        else if (change.endsWith("permission")) {
          const denied =
            change === "send-permission"
              ? P.SendMessagesInThreads
              : change === "view-permission"
                ? P.ViewChannel
                : change === "history-permission"
                  ? P.ReadMessageHistory
                  : P.EmbedLinks;
          f.data.set("/guilds/1/roles", [
            { id: "1", permissions: (readable & ~denied).toString() },
          ]);
        } else if (change === "membership") f.data.delete(membershipRoute);
        else if (change === "deleted") f.data.delete("/channels/14");
        else
          f.data.set("/channels/14", {
            ...state,
            ...(change === "guild"
              ? { guild_id: "99" }
              : change === "identity"
                ? { id: "99" }
                : { type: C.GuildVoice }),
          });
        return message;
      };
      await f.service.detect(source);
      expect(f.get.mock.calls.filter(([route]) => route === "/channels/14")).toHaveLength(2);
      if (change === "membership")
        expect(f.get.mock.calls.filter(([route]) => route === membershipRoute)).toHaveLength(2);
      if (type === C.PublicThread) expect(f.get).not.toHaveBeenCalledWith(membershipRoute);
      // Target final proof still runs in the same batch, including when source fails.
      expect(f.get.mock.calls.filter(([route]) => route === "/channels/2")).toHaveLength(2);
      expectNoMutation(f);
    },
  );
  it.each(["auto", "helper", "mixed", "overflow", "overflow-only"] as const)(
    "guards the final source for %s output",
    async (variant) => {
      for (const type of [C.PublicThread, C.PrivateThread]) {
        for (const archived of [false, true]) {
          const f = sourceFixture(type);
          if (type === C.PublicThread) f.data.delete(membershipRoute);
          const count =
            variant === "mixed"
              ? 2
              : variant === "overflow"
                ? 4
                : variant === "overflow-only"
                  ? 8
                  : 1;
          const sourceWithLinks = {
            ...source,
            content: Array.from({ length: count }, (_, index) =>
              originalUrl({ ...target, messageId: String(index + 3) }),
            ).join(" "),
          };
          if (variant === "helper" || variant === "overflow") {
            f.service = createLinkPreviewService({
              readMode: () => Promise.resolve("button-only"),
              discord: f.discord,
              log: f.log,
            });
          } else if (variant === "mixed") {
            const classify = f.discord.classify;
            f.discord.classify = async (links) => {
              const observations = await classify(links);
              return observations.map((item, index) =>
                index === 1 ? { state: "RESTRICTED" } : item,
              );
            };
          } else if (variant === "overflow-only") {
            f.data.set("/channels/2", { ...channel(), nsfw: true });
          }
          const get = f.get.getMockImplementation()!;
          let sourceReads = 0;
          f.get.mockImplementation((route) => {
            if (route === "/channels/14" && ++sourceReads === 2 && archived)
              f.data.set(route, {
                ...(f.data.get(route) as object),
                thread_metadata: { archived: true, locked: false },
              });
            return get(route);
          });
          await f.service.detect(sourceWithLinks);
          expect(sourceReads).toBe(2);
          expect(f.get.mock.calls.filter(([route]) => route === membershipRoute)).toHaveLength(
            type === C.PrivateThread ? (archived ? 1 : 2) : 0,
          );
          expectNoMutation(f, archived ? 0 : 1);
          if (!archived) {
            const body = f.post.mock.calls[0]![1].body;
            if (variant === "auto" || variant === "mixed") expect(body.embeds).toHaveLength(1);
            if (variant === "helper" || variant === "mixed")
              expect(body.components).toHaveLength(1);
            if (variant === "overflow") expect(body.content).toBe("+1 more");
            if (variant === "overflow-only") expect(body.content).toBe("+2 more");
          }
        }
      }
    },
  );
});
describe("fresh permission proof", () => {
  it.each([
    ["0", "0"],
    ["1234", "4"],
  ])("uses the original default avatar for discriminator %s", async (discriminator, index) => {
    const f = fixture();
    const message = f.data.get("/channels/2/messages/3") as object;
    f.data.set("/channels/2/messages/3", {
      ...message,
      author: { id: "7", username: "original", avatar: null, discriminator },
    });
    f.data.delete("/guilds/1/members/7");
    const preview = await f.discord.fetchMessage(target);
    expect(preview.author).toBe("original");
    expect(preview.avatar).toBe(`https://cdn.discordapp.com/embed/avatars/${index}.png`);
  });

  it("distinguishes confirmed age restriction from unknown age evidence without authorizing either", async () => {
    const f = fixture();
    f.data.set("/channels/2", { ...channel(), nsfw: undefined });
    expect(await f.discord.classify([target]).then(([result]) => result?.state)).toBe("UNCERTAIN");
    expect(await f.discord.authorize(target, "9").then(Boolean)).toBe(false);
    f.data.set("/channels/2", { ...channel(), nsfw: true });
    expect(await f.discord.classify([target]).then(([result]) => result?.state)).toBe("INELIGIBLE");
    expect(await f.discord.authorize(target, "9").then(Boolean)).toBe(false);
  });

  it.each([
    [[], true],
    [[{ id: "1", type: 0, allow: "0", deny: P.ViewChannel.toString() }], false],
    [[{ id: "6", type: 0, allow: "0", deny: P.ReadMessageHistory.toString() }], false],
    [[{ id: "9", type: 1, allow: "0", deny: P.ViewChannel.toString() }], false],
    [[{ id: "6", type: 0, allow: "0", deny: P.SendMessages.toString() }], true],
  ])("uses everyone and every deny: %j", (overwrites, expected) => {
    const parsed = previewChannelSchema.parse({ ...channel(), permission_overwrites: overwrites });
    expect(
      safePublicPermissions(
        parsed,
        previewRolesSchema.parse([{ id: "1", permissions: READ_BITS.toString() }]),
      ),
    ).toBe(expected);
  });
  it("requires both bits and does not apply a category as a second overwrite layer", async () => {
    for (const permissions of [P.ViewChannel, P.ReadMessageHistory, 0n]) {
      const f = fixture();
      f.data.set("/guilds/1/roles", [{ id: "1", permissions: permissions.toString() }]);
      expect(await f.discord.classify([target]).then(([result]) => result?.state)).not.toBe(
        "PUBLIC",
      );
    }
    const f = fixture();
    f.data.set("/channels/2", { ...channel(), parent_id: "20" });
    expect(await f.discord.classify([target]).then(([result]) => result?.state)).toBe("PUBLIC");
    expect(f.get).not.toHaveBeenCalledWith("/channels/20");
  });
  it.each([
    { permission_overwrites: undefined },
    { permission_overwrites: null },
    { permission_overwrites: [{ id: "6", type: 9, allow: "0", deny: "0" }] },
    { permission_overwrites: [{ id: "1", type: 0, allow: "1024", deny: "1024" }] },
    { name: undefined },
    { guild_id: "22" },
    { type: C.GuildVoice },
  ])("fails closed for malformed/unconfirmed state %j", async (patch) => {
    const f = fixture();
    f.data.set("/channels/2", { ...channel(), ...patch });
    expect(await f.discord.classify([target]).then(([result]) => result?.state)).not.toBe("PUBLIC");
    expect(await f.discord.authorize(target, "9").then(Boolean)).toBe(false);
  });
  it.each([
    [C.PublicThread, C.GuildText],
    [C.AnnouncementThread, C.GuildAnnouncement],
    [C.PublicThread, C.GuildForum],
    [C.PrivateThread, C.GuildText],
  ])("handles archived/locked target type %s, parent %s without mutation", async (type, parent) => {
    const f = fixture();
    thread(f, type, parent);
    expect(await f.discord.classify([target]).then(([result]) => result?.state)).toBe(
      type === C.PrivateThread ? "RESTRICTED" : "PUBLIC",
    );
    expect(await f.discord.authorize(target, "9").then(Boolean)).toBe(true);
    expect(f.post).not.toHaveBeenCalled();
    expect(await f.discord.sourceSendable({ ...target, content: "" })).toBe(false);
  });
  it.each([true, undefined, "false"])(
    "rejects age restriction or missing evidence %s without exceptions",
    async (nsfw) => {
      for (const type of [
        C.GuildText,
        C.GuildAnnouncement,
        C.PublicThread,
        C.PrivateThread,
        C.AnnouncementThread,
      ]) {
        const f = fixture();
        const isThread = [C.PublicThread, C.PrivateThread, C.AnnouncementThread].includes(type);
        if (isThread)
          thread(f, type, type === C.AnnouncementThread ? C.GuildAnnouncement : C.GuildForum);
        const key = isThread ? "/channels/4" : "/channels/2";
        f.data.set(key, { ...(f.data.get(key) as object), nsfw });
        f.data.set("/guilds/1", { id: "1", owner_id: "9" });
        f.data.set("/guilds/1/roles", [
          { id: "1", permissions: (readable | P.Administrator | P.ManageThreads).toString() },
        ]);
        expect(await f.discord.classify([target]).then(([result]) => result?.state)).not.toBe(
          "PUBLIC",
        );
        expect(await f.discord.authorize(target, "9").then(Boolean)).toBe(false);
        expect(f.get.mock.calls.some(([route]) => route.includes("messages/"))).toBe(false);
      }
    },
  );
  it.each([{ id: "5" }, { guild_id: "22" }, { type: C.GuildCategory }, { nsfw: true }])(
    "rejects wrong parent %j",
    async (patch) => {
      const f = fixture();
      thread(f, C.PublicThread);
      f.data.set("/channels/4", { ...channel(), id: "4", ...patch });
      expect(await f.discord.authorize(target, "9").then(Boolean)).toBe(false);
    },
  );
  it("does not authorize from cached private membership and handles removal / ManageThreads", async () => {
    const f = fixture();
    thread(f, C.PrivateThread);
    expect(await f.discord.authorize(target, "9").then(Boolean)).toBe(true);
    f.data.delete("/channels/2/thread-members/9");
    expect(await f.discord.authorize(target, "9").then(Boolean)).toBe(false);
    f.data.set("/guilds/1/roles", [
      { id: "1", permissions: (readable | P.ManageThreads).toString() },
    ]);
    expect(await f.discord.authorize(target, "9").then(Boolean)).toBe(true);
  });
  it("uses current roles, member overwrite and bot access at each observation", async () => {
    const f = fixture();
    f.data.set("/guilds/1/roles", [
      { id: "1", permissions: "0" },
      { id: "6", permissions: readable.toString() },
    ]);
    f.data.set("/guilds/1/members/8", { user: { id: "8" }, roles: ["6"] });
    f.data.set("/guilds/1/members/9", { user: { id: "9" }, roles: ["6"] });
    expect(await f.discord.authorize(target, "9").then(Boolean)).toBe(true);
    expect(await f.discord.classify([target]).then(([result]) => result?.state)).toBe("RESTRICTED");
    f.data.set("/guilds/1/members/9", { user: { id: "9" }, roles: [] });
    expect(await f.discord.authorize(target, "9").then(Boolean)).toBe(false);
    f.data.set("/guilds/1/members/9", { user: { id: "9" }, roles: ["6"] });
    f.data.delete("/guilds/1/members/8");
    expect(await f.discord.authorize(target, "9").then(Boolean)).toBe(false);
  });
  it("calculates member overwrite precedence, owner/admin and timeout", () => {
    const c = previewChannelSchema.parse({
      ...channel(),
      permission_overwrites: [{ id: "9", type: 1, allow: "0", deny: P.ViewChannel.toString() }],
    });
    const roles = previewRolesSchema.parse([
      { id: "1", permissions: readable.toString() },
      { id: "6", permissions: P.Administrator.toString() },
    ]);
    const member = previewMemberSchema.parse({ user: { id: "9" }, roles: [] });
    expect(memberPermissions(c, roles, member, "10", 0)! & READ_BITS).not.toBe(READ_BITS);
    expect(memberPermissions(c, roles, member, "9", 0)! & READ_BITS).toBe(READ_BITS);
    expect(memberPermissions(c, roles, { ...member, roles: ["6"] }, "10", 0)! & READ_BITS).toBe(
      READ_BITS,
    );
    expect(
      memberPermissions(
        previewChannelSchema.parse(channel()),
        roles,
        { ...member, communication_disabled_until: "2030-01-01T00:00:00Z" },
        "10",
        0,
      ),
    ).toBe(READ_BITS);
  });
  it("observes an nsfw change after content preparation on both public and ephemeral paths", async () => {
    for (const button of [false, true]) {
      const f = fixture();
      const fetchMessage = f.discord.fetchMessage;
      f.discord.fetchMessage = async (link) => {
        const message = await fetchMessage(link);
        f.data.set("/channels/2", { ...channel(), nsfw: true });
        return message;
      };
      const service = createLinkPreviewService({
        readMode: () => Promise.resolve("hybrid"),
        discord: f.discord,
        log: vi.fn(),
      });
      if (button) expect(await service.preview(target, "9")).toBeUndefined();
      else
        await service.detect({
          guildId: "1",
          channelId: "4",
          messageId: "5",
          content: originalUrl(target),
        });
      expect(f.post).not.toHaveBeenCalled();
    }
  });
  it("renders fresh nickname/avatar with author fallback and sends one mention-safe nonce reply", async () => {
    const f = fixture();
    const message = await f.discord.fetchMessage(target);
    expect(message.author).toBe("SECRET_NICK");
    expect(message.avatar).toContain("SECRET_GUILD_AVATAR");
    f.data.delete("/guilds/1/members/7");
    expect((await f.discord.fetchMessage(target)).author).toBe("SECRET_GLOBAL");
    await f.discord.send(
      { ...target, content: "" },
      { embeds: [], helpers: [{ target, ordinal: 1 }], targetCount: 1, overflow: 0 },
      "stable",
    );
    expect(f.post.mock.calls).toMatchObject([
      [
        "/channels/2/messages",
        {
          body: {
            allowed_mentions: { parse: [], replied_user: false },
            nonce: "stable",
            enforce_nonce: true,
            message_reference: { fail_if_not_exists: true },
          },
        },
      ],
    ]);
    expect(JSON.stringify(f.post.mock.calls)).not.toContain("SECRET_");
  });
});
function button(f: ReturnType<typeof fixture>, patch: object = {}) {
  const deferReply = vi.fn(() => Promise.resolve(undefined));
  const editReply = vi.fn(() => Promise.resolve(undefined));
  const interaction = {
    customId: previewCustomId(target),
    inGuild: () => true,
    guildId: "1",
    applicationId: "11",
    client: f.client,
    user: { id: "9" },
    message: { author: { id: "8" }, webhookId: null },
    deferReply,
    editReply,
    ...patch,
  } as unknown as ButtonInteraction;
  return { interaction, deferReply, editReply };
}
describe("global owned routing", () => {
  it.each([
    { customId: "lp:2:1:2:3" },
    { guildId: "2" },
    { applicationId: "12" },
    { message: { author: { id: "7" }, webhookId: null } },
    { message: { author: { id: "8" }, webhookId: "6" } },
  ])("ignores unowned or invalid button %j", async (patch) => {
    const f = fixture();
    const b = button(f, patch);
    const service = { preview: vi.fn(), detect: vi.fn() };
    await handlePreviewButton(b.interaction, service, "8");
    expect(service.preview).not.toHaveBeenCalled();
    expect(b.deferReply).not.toHaveBeenCalled();
  });
  it("defers ephemerally and returns only generic failure", async () => {
    const f = fixture();
    const b = button(f);
    const service = { preview: vi.fn(() => Promise.resolve(undefined)), detect: vi.fn() };
    await handlePreviewButton(b.interaction, service, "8");
    expect(b.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(b.editReply).toHaveBeenCalledWith({
      content: PREVIEW_FAILURE,
      allowedMentions: { parse: [], repliedUser: false },
    });
  });
  it("filters sources and keeps activity tracking independent of preview failures", async () => {
    const f = fixture();
    const detect = vi.fn(() => Promise.reject(new Error("SECRET_CONTENT")));
    const service: LinkPreviewService = {
      detect,
      preview: vi.fn(),
    };
    const logger = { debug: vi.fn() };
    const ingress = { run: <T>(fn: () => T | Promise<T>) => Promise.resolve(fn()) };
    registerLinkPreviewHandlers(f.client, service, logger, ingress);
    const base = {
      inGuild: () => true,
      author: { id: "9", bot: false },
      guildId: "1",
      channelId: "2",
      id: "3",
      content: originalUrl(target),
      type: 0,
      system: false,
      webhookId: null,
      channel: { type: C.GuildText },
    };
    for (const patch of [
      { inGuild: () => false },
      { author: { id: "8", bot: false } },
      { author: { id: "9", bot: true } },
      { webhookId: "7" },
      { system: true },
      { type: 7 },
      { content: "" },
      { channel: { type: C.GuildVoice } },
    ])
      (f.client as unknown as EventEmitter).emit(Events.MessageCreate, { ...base, ...patch });
    expect(f.client.listenerCount(Events.MessageCreate)).toBe(1);
    expect(detect).not.toHaveBeenCalled();
    const activity = {
      recordMessageActivity: vi.fn(() => Promise.resolve()),
      initializeThreadBaseline: vi.fn(),
      recordThreadReentryBaseline: vi.fn(),
    };
    registerAutomaticCloseActivityHandlers(f.client, { activity, logger }, ingress);
    (f.client as unknown as EventEmitter).emit(Events.MessageCreate, {
      ...base,
      createdAt: new Date(),
      channel: { type: C.PublicThread, isThread: () => true, id: "2", parentId: "4" },
    });
    await vi.waitFor(() => expect(logger.debug).toHaveBeenCalled());
    expect(activity.recordMessageActivity).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain("SECRET_");
  });
});

describe("preview UX and bounded fresh parallel reads", () => {
  const source = { guildId: "1", channelId: "4", messageId: "5", content: originalUrl(target) };
  function service(f: ReturnType<typeof fixture>, mode: "hybrid" | "button-only" = "hybrid") {
    const log = vi.fn();
    return {
      log,
      value: createLinkPreviewService({
        readMode: () => Promise.resolve(mode),
        discord: f.discord,
        log,
      }),
    };
  }
  it("starts all independent authorization reads together and fetches guild only once per boundary", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.get.mockImplementation(async (route) => {
      await gate;
      if (!f.data.has(route)) throw new Error("SECRET_FAILURE");
      return f.data.get(route);
    });
    const authorization = f.discord.authorize(target, "9");
    expect(f.get.mock.calls.map(([route]) => route)).toEqual([
      "/channels/2",
      "/guilds/1",
      "/guilds/1/roles",
      "/guilds/1/members/9",
      "/guilds/1/members/8",
    ]);
    release();
    expect(await authorization).toEqual({ location: "#SECRET_CHANNEL" });
    expect(f.get.mock.calls.filter(([route]) => route === "/guilds/1")).toHaveLength(1);
  });
  it("fails closed after waiting for a slow sibling of a failed parallel request", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const get = f.get.getMockImplementation()!;
    f.get.mockImplementation(async (route) => {
      if (route === "/guilds/1/roles") throw new Error("SECRET_FAILURE");
      if (route === "/guilds/1/members/8") await gate;
      return get(route);
    });
    let finished = false;
    const authorization = f.discord.authorize(target, "9").then((result) => {
      finished = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    release();
    expect(await authorization).toBeUndefined();
    expect(f.get.mock.calls.some(([route]) => route.includes("messages/"))).toBe(false);
  });
  it("deduplicates channels, thread parents, guild, roles and bot reads within each fresh batch", async () => {
    const f = fixture();
    thread(f, C.PublicThread, C.GuildForum);
    f.data.set("/channels/12", { ...(f.data.get("/channels/2") as object), id: "12" });
    const targets = [target, { ...target, messageId: "6" }, { ...target, channelId: "12" }];
    expect((await f.discord.classify(targets)).map((result) => result.state)).toEqual([
      "PUBLIC",
      "PUBLIC",
      "PUBLIC",
    ]);
    for (const route of [
      "/channels/2",
      "/channels/12",
      "/channels/4",
      "/guilds/1",
      "/guilds/1/roles",
      "/guilds/1/members/8",
    ])
      expect(f.get.mock.calls.filter(([value]) => value === route)).toHaveLength(1);
    await f.discord.classify(targets);
    for (const route of ["/channels/2", "/channels/4", "/guilds/1/roles", "/guilds/1/members/8"])
      expect(f.get.mock.calls.filter(([value]) => value === route)).toHaveLength(2);
  });
  it("keeps fresh user and bot private membership on initial and final authorization", async () => {
    const f = fixture();
    thread(f, C.PrivateThread);
    const s = service(f);
    expect(await s.value.preview(target, "9")).toBeDefined();
    for (const route of [
      "/channels/2/thread-members/9",
      "/channels/2/thread-members/8",
      "/guilds/1/members/9",
      "/guilds/1/members/8",
      "/guilds/1",
    ])
      expect(f.get.mock.calls.filter(([value]) => value === route)).toHaveLength(2);
    const fetchMessage = f.discord.fetchMessage;
    f.discord.fetchMessage = async (link) => {
      const message = await fetchMessage(link);
      f.data.delete("/channels/2/thread-members/8");
      return message;
    };
    expect(await s.value.preview(target, "9")).toBeUndefined();
  });
  it("starts private user/bot membership reads together and deduplicates repeated batch membership", async () => {
    const f = fixture();
    thread(f, C.PrivateThread);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const get = f.get.getMockImplementation()!;
    f.get.mockImplementation(async (route) => {
      if (route.includes("thread-members/")) await gate;
      return get(route);
    });
    const authorization = f.discord.authorize(target, "9");
    await vi.waitFor(() => {
      expect(f.get).toHaveBeenCalledWith("/channels/2/thread-members/9");
      expect(f.get).toHaveBeenCalledWith("/channels/2/thread-members/8");
    });
    release();
    expect(await authorization).toBeDefined();
    f.get.mockClear();
    expect(
      (await f.discord.classify([target, { ...target, messageId: "6" }])).map(
        (result) => result.state,
      ),
    ).toEqual(["RESTRICTED", "RESTRICTED"]);
    expect(
      f.get.mock.calls.filter(([route]) => route === "/channels/2/thread-members/8"),
    ).toHaveLength(1);
  });
  it("discards all AUTO payload when a shared final fresh role request fails", async () => {
    const f = fixture();
    const fetchMessage = f.discord.fetchMessage;
    f.discord.fetchMessage = async (link) => {
      const message = await fetchMessage(link);
      const get = f.get.getMockImplementation()!;
      let finalRoleRead = 0;
      f.get.mockImplementation((route) => {
        // Final source starts first and remains sendable; only target proof loses roles.
        if (route === "/guilds/1/roles" && ++finalRoleRead === 2)
          return Promise.reject(new Error("SECRET_FAILURE"));
        return get(route);
      });
      return message;
    };
    const s = service(f);
    await s.value.detect(source);
    expect(f.get.mock.calls.filter(([route]) => route === "/channels/2")).toHaveLength(2);
    expect(f.post).toHaveBeenCalledOnce();
    expect(JSON.stringify([f.post.mock.calls, s.log.mock.calls])).not.toMatch(
      /SECRET_|Open original|WEFT message previews?/,
    );
    expect(f.post.mock.calls[0]![1].body).not.toHaveProperty("content");
    expect(f.post.mock.calls[0]![1].body).not.toHaveProperty("embeds");
    expect(f.post.mock.calls[0]![1].body.components).toMatchObject([
      {
        components: [
          { label: "Preview", style: ButtonStyle.Secondary, custom_id: previewCustomId(target) },
        ],
      },
    ]);
  });
  it.each([C.PublicThread, C.PrivateThread])(
    "uses actual parent/thread names after authorization for %s",
    async (type) => {
      const f = fixture();
      thread(f, type);
      f.data.set("/channels/2", { ...(f.data.get("/channels/2") as object), name: "discussion" });
      f.data.set("/channels/4", { ...(f.data.get("/channels/4") as object), name: "general" });
      const preview = await service(f).value.preview(target, "9");
      expect(preview?.footer.text).toBe("#general › discussion");
      expect(preview?.timestamp).toBe("2026-01-01T00:00:00Z");
      expect(preview?.footer.text).not.toMatch(/WEFT|Channel|[0-9]/);
    },
  );
  it("uses the final fresh forum/post name in AUTO and sends no labels, counts or Open original", async () => {
    const f = fixture();
    thread(f, C.PublicThread, C.GuildForum);
    const fetchMessage = f.discord.fetchMessage;
    f.discord.fetchMessage = async (link) => {
      const message = await fetchMessage(link);
      f.data.set("/channels/2", { ...(f.data.get("/channels/2") as object), name: "post-title" });
      f.data.set("/channels/4", { ...(f.data.get("/channels/4") as object), name: "forum-name" });
      return message;
    };
    // The source is an ordinary sendable text channel, independent of the target forum.
    f.data.set("/channels/14", { ...channel(), id: "14" });
    await service(f).value.detect({ ...source, channelId: "14" });
    expect(f.post).toHaveBeenCalledOnce();
    expect(f.post.mock.calls).toMatchObject([
      [
        "/channels/14/messages",
        {
          body: {
            embeds: [
              { footer: { text: "#forum-name › post-title" }, timestamp: "2026-01-01T00:00:00Z" },
            ],
            allowed_mentions: { parse: [], replied_user: false },
          },
        },
      ],
    ]);
    expect(JSON.stringify(f.post.mock.calls)).not.toMatch(
      /WEFT message previews?|Open original|images omitted|attachments omitted|embeds omitted|stickers omitted|Channel 2/,
    );
    expect(f.post.mock.calls[0]![1].body).not.toHaveProperty("components");
    expect(f.post.mock.calls[0]![1].body).not.toHaveProperty("content");
  });
  it.each(["hybrid", "button-only"] as const)(
    "adds Open original only to authorized ephemeral previews in %s",
    async (mode) => {
      const f = fixture();
      f.data.set("/channels/2", { ...channel(), name: "general" });
      const b = button(f);
      await handlePreviewButton(b.interaction, service(f, mode).value, "8");
      expect(b.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
      expect(b.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          embeds: [
            expect.objectContaining({
              footer: { text: "#general" },
              author: {
                name: "SECRET_NICK",
                icon_url:
                  "https://cdn.discordapp.com/guilds/1/users/7/avatars/SECRET_GUILD_AVATAR.png",
              },
            }),
          ],
          components: [
            expect.objectContaining({
              components: [
                expect.objectContaining({ label: "Open original", url: originalUrl(target) }),
              ],
            }),
          ],
        }),
      );
    },
  );
  it.each(["unauthorized", "age-restricted", "deleted"])(
    "exposes no location or Open original on %s failure",
    async (failure) => {
      const f = fixture();
      if (failure === "unauthorized")
        f.data.set("/guilds/1/members/9", { user: { id: "9" }, roles: ["999"] });
      if (failure === "age-restricted") f.data.set("/channels/2", { ...channel(), nsfw: true });
      if (failure === "deleted") f.data.delete("/channels/2/messages/3");
      const b = button(f);
      const s = service(f);
      await handlePreviewButton(b.interaction, s.value, "8");
      expect(b.editReply).toHaveBeenCalledWith({
        content: PREVIEW_FAILURE,
        allowedMentions: { parse: [], repliedUser: false },
      });
      expect(JSON.stringify([b.editReply.mock.calls, s.log.mock.calls])).not.toMatch(
        /SECRET_|Open original|WEFT message previews?/,
      );
      if (failure !== "deleted") expect(f.get).not.toHaveBeenCalledWith("/channels/2/messages/3");
    },
  );
  it("sends mixed embeds and Secondary Preview 2 in one reply without helper text or protected metadata", async () => {
    const f = fixture();
    f.data.set("/channels/2", { ...channel(), name: "general" });
    f.data.set("/guilds/1/members/7", { nick: "public-author" });
    f.data.set("/channels/2/messages/3", {
      ...(f.data.get("/channels/2/messages/3") as object),
      content: "public-content",
      author: { id: "7", username: "public-author", avatar: null },
    });
    f.data.set("/channels/12", {
      ...channel(),
      id: "12",
      permission_overwrites: [{ id: "9", type: 1, allow: "0", deny: P.ViewChannel.toString() }],
    });
    f.data.set("/channels/12/messages/13", {
      content: "SECRET_CONTENT",
      author: "SECRET_AUTHOR",
      attachments: ["SECRET_ATTACHMENT"],
    });
    const s = service(f);
    await s.value.detect({
      ...source,
      content: source.content + " " + originalUrl({ ...target, channelId: "12", messageId: "13" }),
    });
    expect(f.post).toHaveBeenCalledOnce();
    expect(f.post.mock.calls).toMatchObject([
      [
        "/channels/4/messages",
        {
          body: {
            embeds: [{ footer: { text: "#general" } }],
            components: [
              {
                components: [
                  { label: "Preview 2", style: ButtonStyle.Secondary, custom_id: "lp:1:1:12:13" },
                ],
              },
            ],
          },
        },
      ],
    ]);
    expect(f.post.mock.calls[0]![1].body).not.toHaveProperty("content");
    expect(f.get).not.toHaveBeenCalledWith("/channels/12/messages/13");
    expect(JSON.stringify([f.post.mock.calls, s.log.mock.calls])).not.toMatch(
      /SECRET_|WEFT message previews?|Open original|Preview linked message|Linked message|private|restricted|hidden/,
    );
  });
  it.each(["hybrid", "button-only"] as const)(
    "uses one Secondary Preview without explanation text for a single target in %s",
    async (mode) => {
      const f = fixture();
      f.data.set("/channels/2", {
        ...channel(),
        permission_overwrites: [{ id: "9", type: 1, allow: "0", deny: P.ViewChannel.toString() }],
      });
      const s = service(f, mode);
      await s.value.detect(source);
      expect(f.post).toHaveBeenCalledOnce();
      expect(f.post.mock.calls[0]![1].body).toEqual({
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: ButtonStyle.Secondary,
                label: "Preview",
                custom_id: previewCustomId(target),
              },
            ],
          },
        ],
        allowed_mentions: { parse: [], replied_user: false },
        message_reference: {
          guild_id: "1",
          channel_id: "4",
          message_id: "5",
          fail_if_not_exists: true,
        },
        nonce: previewNonce(source),
        enforce_nonce: true,
      });
      expect(f.get).not.toHaveBeenCalledWith("/channels/2/messages/3");
      expect(JSON.stringify([f.post.mock.calls, s.log.mock.calls])).not.toMatch(
        /SECRET_|Preview linked message|Linked message|Open original/,
      );
    },
  );
  it.each([
    ["PUBLIC", "RESTRICTED", "PUBLIC"],
    ["RESTRICTED", "PUBLIC", "RESTRICTED"],
    ["RESTRICTED", "RESTRICTED", "RESTRICTED"],
    ["INELIGIBLE", "PUBLIC", "RESTRICTED"],
  ])("preserves Preview ordinals for %s / %s / %s in one reply", async (...states) => {
    const f = fixture();
    const targets = [
      target,
      { ...target, channelId: "12", messageId: "13" },
      { ...target, channelId: "14", messageId: "15" },
    ];
    f.data.set("/guilds/1/members/7", { nick: "public-author" });
    targets.forEach((link, index) => {
      const publicTarget = states[index] === "PUBLIC";
      f.data.set(`/channels/${link.channelId}`, {
        ...channel(),
        id: link.channelId,
        name: publicTarget ? `public-${index + 1}` : "SECRET_CHANNEL",
        nsfw: states[index] === "INELIGIBLE",
        permission_overwrites: publicTarget
          ? []
          : [{ id: "9", type: 1, allow: "0", deny: P.ViewChannel.toString() }],
      });
      f.data.set(`/channels/${link.channelId}/messages/${link.messageId}`, {
        id: link.messageId,
        channel_id: link.channelId,
        author: {
          id: "7",
          username: publicTarget ? "public-author" : "SECRET_AUTHOR",
          avatar: null,
        },
        content: publicTarget ? "public-content" : "SECRET_CONTENT",
        timestamp: "2026-01-01T00:00:00Z",
        type: 0,
        embeds: [],
        attachments: publicTarget
          ? []
          : [
              {
                filename: "SECRET_ATTACHMENT",
                url: "https://cdn.discordapp.com/SECRET_ATTACHMENT",
                content_type: "image/png",
              },
            ],
      });
    });
    const s = service(f);
    await s.value.detect({ ...source, content: targets.map(originalUrl).join(" ") });
    expect(f.post).toHaveBeenCalledOnce();
    const body = f.post.mock.calls[0]![1].body;
    expect(body).not.toHaveProperty("content");
    expect(body.components).toEqual([
      {
        type: 1,
        components: targets.flatMap((link, index) =>
          states[index] === "RESTRICTED"
            ? [
                {
                  type: 2,
                  style: ButtonStyle.Secondary,
                  label: `Preview ${index + 1}`,
                  custom_id: previewCustomId(link),
                },
              ]
            : [],
        ),
      },
    ]);
    expect(body.embeds ?? []).toHaveLength(states.filter((state) => state === "PUBLIC").length);
    expect(JSON.stringify([f.post.mock.calls, s.log.mock.calls])).not.toMatch(
      /SECRET_|Preview linked message|Linked message|Open original/,
    );
    targets.forEach((link, index) => {
      if (states[index] !== "PUBLIC")
        expect(f.get).not.toHaveBeenCalledWith(
          `/channels/${link.channelId}/messages/${link.messageId}`,
        );
    });
  });
  it("uses identical numbered button-only helper payloads regardless of existence", async () => {
    const outputs: string[] = [];
    for (const exists of [true, false]) {
      const f = fixture();
      if (!exists) {
        f.data.delete("/channels/2");
        f.data.delete("/channels/2/messages/3");
      }
      await service(f, "button-only").value.detect({
        ...source,
        content: [3, 6, 7, 8]
          .map((id) => originalUrl({ ...target, messageId: String(id) }))
          .join(" "),
      });
      expect(f.post).toHaveBeenCalledOnce();
      expect(f.get).not.toHaveBeenCalledWith("/channels/2");
      expect(f.post.mock.calls).toMatchObject([
        [
          "/channels/4/messages",
          {
            body: {
              components: [
                {
                  components: [1, 2, 3].map((ordinal) => ({
                    label: `Preview ${ordinal}`,
                    style: ButtonStyle.Secondary,
                  })),
                },
              ],
            },
          },
        ],
      ]);
      expect(f.post.mock.calls[0]![1].body.content).toBe("+1 more");
      expect(f.post.mock.calls[0]![1].body).not.toHaveProperty("embeds");
      const payload = JSON.stringify(f.post.mock.calls);
      expect(payload).not.toMatch(
        /SECRET_|Open original|WEFT message previews?|Preview linked message|Linked message/,
      );
      outputs.push(payload);
    }
    expect(outputs[0]).toBe(outputs[1]);
  });
  it.each(["public", "restricted"])(
    "does not treat stale %s channel cache as authority",
    async (cached) => {
      const f = fixture();
      f.client.channels.cache.set("2", {
        ...channel(),
        permission_overwrites:
          cached === "public"
            ? []
            : [{ id: "9", type: 1, deny: P.ViewChannel.toString(), allow: "0" }],
      } as never);
      if (cached === "public") {
        const fetchMessage = f.discord.fetchMessage;
        f.discord.fetchMessage = async (link) => {
          const message = await fetchMessage(link);
          f.data.set("/channels/2", {
            ...channel(),
            permission_overwrites: [
              { id: "9", type: 1, deny: P.ViewChannel.toString(), allow: "0" },
            ],
          });
          return message;
        };
      }
      await service(f).value.detect(source);
      expect(f.get.mock.calls.filter(([route]) => route === "/channels/2")).toHaveLength(2);
      if (cached === "public") expect(JSON.stringify(f.post.mock.calls)).not.toContain("SECRET_");
      else
        expect(f.post.mock.calls).toMatchObject([
          [expect.anything(), { body: { embeds: [expect.any(Object)] } }],
        ]);
    },
  );
});

describe("candidate budgets, overflow rendering and privacy", () => {
  type Policy = "PUBLIC" | "PRIVATE" | "UNCERTAIN" | "AGE";
  const source = { guildId: "1", channelId: "4", messageId: "5", content: "" };
  function candidates(
    policies: readonly Policy[],
    mode: "hybrid" | "public-only" | "button-only" | "off",
  ) {
    const f = fixture();
    const targets = policies.map((_, index) => ({
      guildId: "1",
      channelId: String(100 + index),
      messageId: String(200 + index),
    }));
    f.data.set("/guilds/1/members/7", { nick: "public-author" });
    targets.forEach((target, index) => {
      const policy = policies[index];
      f.data.set(`/channels/${target.channelId}`, {
        ...channel(),
        id: target.channelId,
        name: policy === "PUBLIC" ? `public-${index + 1}` : "SECRET_CHANNEL",
        nsfw: policy === "UNCERTAIN" ? undefined : policy === "AGE",
        ...(policy === "PRIVATE"
          ? {
              type: C.PrivateThread,
              name: "SECRET_THREAD",
              parent_id: "4",
              thread_metadata: { archived: true, locked: true },
            }
          : {}),
      });
      f.data.set(`/channels/${target.channelId}/thread-members/8`, {
        id: target.channelId,
        user_id: "8",
      });
      f.data.set(`/channels/${target.channelId}/messages/${target.messageId}`, {
        id: target.messageId,
        channel_id: target.channelId,
        author: {
          id: "7",
          username: policy === "PUBLIC" ? "public-author" : "SECRET_AUTHOR",
          avatar: null,
        },
        content: policy === "PUBLIC" ? `PUBLIC_MESSAGE_${index + 1}` : "SECRET_CONTENT",
        timestamp: "2026-01-01T00:00:00Z",
        type: 0,
        embeds: [],
        attachments:
          policy === "PUBLIC"
            ? []
            : [
                {
                  filename: "SECRET_ATTACHMENT",
                  url: "https://cdn.discordapp.com/SECRET_ATTACHMENT",
                  content_type: "image/png",
                },
              ],
      });
    });
    const log = vi.fn();
    const classify = vi.spyOn(f.discord, "classify");
    const service = createLinkPreviewService({
      readMode: () => Promise.resolve(mode),
      discord: f.discord,
      log,
    });
    return {
      ...f,
      targets,
      log,
      classify,
      service,
      source: { ...source, content: targets.map(originalUrl).join(" ") },
    };
  }
  it.each([
    {
      policies: ["PUBLIC", "PUBLIC", "PRIVATE", "PUBLIC"] as const,
      displayed: [1, 2, 4],
      more: undefined,
    },
    {
      policies: ["PUBLIC", "PRIVATE", "PUBLIC", "PRIVATE", "PUBLIC"] as const,
      displayed: [1, 3, 5],
      more: undefined,
    },
    {
      policies: ["PUBLIC", "PUBLIC", "PRIVATE", "PUBLIC", "PUBLIC"] as const,
      displayed: [1, 2, 4],
      more: "+1 more",
    },
    {
      policies: ["PUBLIC", "PUBLIC", "PUBLIC", "PUBLIC"] as const,
      displayed: [1, 2, 3],
      more: "+1 more",
    },
    {
      policies: ["PUBLIC", "PUBLIC", "PUBLIC", "PUBLIC", "PUBLIC"] as const,
      displayed: [1, 2, 3],
      more: "+2 more",
    },
    {
      policies: ["UNCERTAIN", "AGE", "PUBLIC", "PUBLIC", "PUBLIC"] as const,
      displayed: [3, 4, 5],
      more: undefined,
    },
  ])(
    "fills public-only slots without non-public overflow: $policies",
    async ({ policies, displayed, more }) => {
      const f = candidates(policies, "public-only");
      await f.service.detect(f.source);
      expect(f.post).toHaveBeenCalledOnce();
      const body = f.post.mock.calls[0]![1].body;
      expect(body.embeds).toMatchObject(
        displayed.map((index) => ({ description: `PUBLIC_MESSAGE_${index}` })),
      );
      expect(body.embeds).toHaveLength(3);
      expect(body.content).toBe(more);
      expect(body).not.toHaveProperty("components");
      expect(f.classify.mock.calls[0]![0]).toEqual(f.targets);
      f.targets.forEach((target, index) => {
        if (policies[index] === "PUBLIC")
          expect(f.get).toHaveBeenCalledWith(
            `/channels/${target.channelId}/messages/${target.messageId}`,
          );
        else
          expect(f.get).not.toHaveBeenCalledWith(
            `/channels/${target.channelId}/messages/${target.messageId}`,
          );
      });
      expect(JSON.stringify([f.post.mock.calls, f.log.mock.calls])).not.toMatch(
        /SECRET_|Open original|\bView\b|Linked message|Message preview/,
      );
    },
  );
  it("fills hybrid slots around age restriction while retaining source Preview 3", async () => {
    const f = candidates(["PUBLIC", "AGE", "PRIVATE", "PUBLIC"], "hybrid");
    await f.service.detect(f.source);
    expect(f.post).toHaveBeenCalledOnce();
    const body = f.post.mock.calls[0]![1].body;
    expect(body.embeds).toMatchObject([
      { description: "PUBLIC_MESSAGE_1" },
      { description: "PUBLIC_MESSAGE_4" },
    ]);
    expect(body.components).toMatchObject([
      {
        components: [
          {
            label: "Preview 3",
            style: ButtonStyle.Secondary,
            custom_id: previewCustomId(f.targets[2]!),
          },
        ],
      },
    ]);
    expect(body).not.toHaveProperty("content");
    expect(JSON.stringify([f.post.mock.calls, f.log.mock.calls])).not.toMatch(
      /SECRET_|Open original|\bView\b/,
    );
  });
  it("keeps Preview 2 after an omitted age-restricted first candidate", async () => {
    const f = candidates(["AGE", "PRIVATE"], "hybrid");
    await f.service.detect(f.source);
    expect(f.post).toHaveBeenCalledOnce();
    const body = f.post.mock.calls[0]![1].body;
    expect(body.components).toMatchObject([
      { components: [{ label: "Preview 2", style: ButtonStyle.Secondary }] },
    ]);
    expect(body).not.toHaveProperty("embeds");
    expect(body).not.toHaveProperty("content");
    expect(JSON.stringify(body)).not.toMatch(/SECRET_|\bView\b|Open original/);
  });
  it("retains Preview 6 when earlier policy exclusions leave one visible helper", async () => {
    const f = candidates(
      ["AGE", "AGE", "AGE", "AGE", "AGE", "PRIVATE", "PUBLIC", "PRIVATE"],
      "hybrid",
    );
    await f.service.detect(f.source);
    expect(f.post).toHaveBeenCalledOnce();
    const body = f.post.mock.calls[0]![1].body;
    expect(body.components).toMatchObject([
      { components: [{ label: "Preview 6", style: ButtonStyle.Secondary }] },
    ]);
    expect(body.content).toBe("+2 more");
    expect(body).not.toHaveProperty("embeds");
    for (const target of f.targets.slice(6))
      expect(
        f.get.mock.calls.some(([route]) => route.startsWith(`/channels/${target.channelId}`)),
      ).toBe(false);
    expect(JSON.stringify([body, f.log.mock.calls])).not.toMatch(/SECRET_|\bView\b|Open original/);
  });
  it("limits mixed hybrid items to three and counts uncertain/private helpers as eligible overflow", async () => {
    const f = candidates(["PUBLIC", "UNCERTAIN", "PRIVATE", "PUBLIC", "PRIVATE"], "hybrid");
    await f.service.detect(f.source);
    expect(f.post).toHaveBeenCalledOnce();
    const body = f.post.mock.calls[0]![1].body;
    expect(body.embeds).toHaveLength(1);
    expect(body.components).toMatchObject([
      { components: [{ label: "Preview 2" }, { label: "Preview 3" }] },
    ]);
    expect(body.content).toBe("+2 more");
    expect(JSON.stringify([f.post.mock.calls, f.log.mock.calls])).not.toMatch(
      /SECRET_|\bView\b|Open original/,
    );
  });
  it.each(["hybrid", "public-only"] as const)(
    "never issues REST for seventh/eighth candidates in %s",
    async (mode) => {
      const f = candidates(
        Array.from({ length: 8 }, () => "PUBLIC" as const),
        mode,
      );
      await f.service.detect(f.source);
      expect(f.post).toHaveBeenCalledOnce();
      expect(f.post.mock.calls[0]![1].body.content).toBe("+5 more");
      expect(f.post.mock.calls[0]![1].body.embeds).toHaveLength(3);
      expect(f.classify).toHaveBeenCalledTimes(2);
      for (const [targets] of f.classify.mock.calls) expect(targets).toEqual(f.targets.slice(0, 6));
      for (const target of f.targets.slice(6))
        expect(
          f.get.mock.calls.some(([route]) => route.startsWith(`/channels/${target.channelId}`)),
        ).toBe(false);
      expect(f.get.mock.calls.filter(([route]) => route === "/guilds/1/roles")).toHaveLength(4);
      expect(f.get.mock.calls.filter(([route]) => route.includes("/messages/"))).toHaveLength(6);
    },
  );
  it.each(["hybrid", "public-only"] as const)(
    "renders only source-level overflow without protected metadata in %s",
    async (mode) => {
      const outputs: string[] = [];
      for (const unexaminedExists of [true, false]) {
        const f = candidates(
          ["AGE", "AGE", "AGE", "AGE", "AGE", "AGE", "PRIVATE", "PRIVATE"],
          mode,
        );
        if (!unexaminedExists)
          for (const target of f.targets.slice(6)) {
            f.data.delete(`/channels/${target.channelId}`);
            f.data.delete(`/channels/${target.channelId}/messages/${target.messageId}`);
          }
        await f.service.detect(f.source);
        expect(f.post).toHaveBeenCalledOnce();
        const body = f.post.mock.calls[0]![1].body;
        expect(body.content).toBe("+2 more");
        expect(body).toEqual({
          content: "+2 more",
          allowed_mentions: { parse: [], replied_user: false },
          message_reference: {
            guild_id: "1",
            channel_id: "4",
            message_id: "5",
            fail_if_not_exists: true,
          },
          nonce: previewNonce(f.source),
          enforce_nonce: true,
        });
        expect(body).not.toHaveProperty("embeds");
        expect(body).not.toHaveProperty("components");
        expect(f.classify).toHaveBeenCalledOnce();
        for (const target of f.targets.slice(6))
          expect(
            f.get.mock.calls.some(([route]) => route.startsWith(`/channels/${target.channelId}`)),
          ).toBe(false);
        expect(f.get.mock.calls.some(([route]) => route.includes("/messages/"))).toBe(false);
        expect(JSON.stringify([body, f.log.mock.calls])).not.toMatch(
          /SECRET_|private|restricted|\bView\b|Preview|Open original/,
        );
        outputs.push(JSON.stringify(body));
      }
      expect(outputs[0]).toBe(outputs[1]);
    },
  );
  it("creates three syntactic button-only items and overflow without any target REST", async () => {
    const f = candidates(
      ["PUBLIC", "PRIVATE", "UNCERTAIN", "AGE", "PUBLIC", "PRIVATE", "AGE", "PRIVATE"],
      "button-only",
    );
    await f.service.detect(f.source);
    expect(f.post).toHaveBeenCalledOnce();
    const body = f.post.mock.calls[0]![1].body;
    expect(body.content).toBe("+5 more");
    expect(body).not.toHaveProperty("embeds");
    expect(body.components).toMatchObject([
      {
        components: [1, 2, 3].map((ordinal) => ({
          label: `Preview ${ordinal}`,
          style: ButtonStyle.Secondary,
        })),
      },
    ]);
    expect(f.classify).not.toHaveBeenCalled();
    expect(f.get.mock.calls.map(([route]) => route)).toEqual([
      "/channels/4",
      "/guilds/1",
      "/guilds/1/roles",
      "/guilds/1/members/8",
      "/channels/4",
      "/guilds/1",
      "/guilds/1/roles",
      "/guilds/1/members/8",
    ]);
    expect(JSON.stringify([body, f.log.mock.calls])).not.toMatch(
      /SECRET_|Open original|\bView\b|Linked message/,
    );
  });
  it("has no off output, overflow, target reads or source preflight", async () => {
    const f = candidates(
      Array.from({ length: 8 }, () => "PUBLIC" as const),
      "off",
    );
    await f.service.detect(f.source);
    expect(f.get).not.toHaveBeenCalled();
    expect(f.classify).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
  });
});
