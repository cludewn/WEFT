import { ButtonStyle, ComponentType, MessageFlags, PermissionFlagsBits } from "discord.js";
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  InteractionEditReplyOptions,
} from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createScheduledMessageListNavigation,
  parseScheduledListCustomId,
  SCHEDULED_LIST_CAPACITY,
  SCHEDULED_LIST_TTL_MS,
} from "../../src/messages/scheduled-message-list.js";
import type { ScheduledMessageCommandService } from "../../src/messages/scheduled-message-command.js";

type ListResult = Awaited<ReturnType<ScheduledMessageCommandService["list"]>>;
const sessionId = "123e4567-e89b-42d3-a456-000000000000";
const row = {
  scheduledActionId: "123e4567-e89b-42d3-a456-000000000001",
  creatorUserId: "18446744073709551615",
  status: "ACTIVE" as const,
  executeAt: new Date("2030-01-01T00:00:00Z"),
};
const found = (hasNext = true, empty = false): ListResult => ({
  outcome: "FOUND",
  schedules: empty ? [] : [row],
  hasNext,
});
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
};
function fixture() {
  const list = vi.fn<ScheduledMessageCommandService["list"]>().mockResolvedValue(found());
  const navigation = createScheduledMessageListNavigation({ list });
  const editReply = vi
    .fn<(options: InteractionEditReplyOptions) => Promise<{ id: string }>>()
    .mockResolvedValue({ id: "message" });
  function interaction(customId = "") {
    return {
      customId,
      createdTimestamp: Date.now(),
      user: { id: "actor" },
      guildId: "guild",
      channelId: "channel",
      message: { id: "message" },
      memberPermissions: {
        has: vi.fn((bit: bigint) => bit === PermissionFlagsBits.ManageMessages),
      },
      isButton: () => true,
      inGuild: () => true,
      reply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      deferReply: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply,
    };
  }
  const slash = interaction();
  function ids() {
    const options = editReply.mock.calls.at(-1)![0];
    const json = JSON.parse(JSON.stringify(options)) as {
      components: {
        type: number;
        components: {
          custom_id: string;
          label: string;
          type: number;
          style: number;
          disabled: boolean;
        }[];
      }[];
    };
    return json.components[0]?.components ?? [];
  }
  const button = (customId = ids()[1]!.custom_id) => interaction(customId);
  return {
    list,
    navigation,
    slash,
    editReply,
    ids,
    button,
    start: () => {
      slash.createdTimestamp = Date.now();
      return navigation.start(slash as unknown as ChatInputCommandInteraction);
    },
    click: (input: ReturnType<typeof interaction>) =>
      navigation.navigate(input as unknown as ButtonInteraction),
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("scheduled list custom identity", () => {
  it.each(["previous", "next"])("parses canonical %s IDs", (action) => {
    expect(parseScheduledListCustomId(`sml:1:${sessionId}:0:${action}`)).toEqual({
      sessionId,
      revision: 0,
      action,
    });
  });
  it.each([
    `other:1:${sessionId}:0:next`,
    `sml:2:${sessionId}:0:next`,
    `sml:1:${sessionId.toUpperCase()}:0:next`,
    `sml:1:${sessionId}:00:next`,
    `sml:1:${sessionId}:-1:next`,
    `sml:1:${sessionId}:1.0:next`,
    `sml:1:${sessionId}:1e1:next`,
    `sml:1:${sessionId}:9007199254740991:next`,
    `sml:1:${sessionId}:9007199254740992:next`,
    `sml:1:${sessionId}:0:cancel`,
    `sml:1:${sessionId}:0:next:extra`,
    `sml:1:${sessionId}:0:next\n`,
    `sml:1:not-a-uuid:0:next`,
    "x".repeat(101),
  ])("rejects tampered identity %s", (id) =>
    expect(parseScheduledListCustomId(id)).toBeUndefined(),
  );
});

describe("scheduled list sessions", () => {
  it("opens ephemeral page 1 with bounded conventional controls and mention suppression", async () => {
    const f = fixture();
    await f.start();
    expect(f.slash.deferReply).toHaveBeenCalledExactlyOnceWith({ flags: MessageFlags.Ephemeral });
    expect(f.list).toHaveBeenCalledExactlyOnceWith({
      guildId: "guild",
      channelId: "channel",
      page: 1,
    });
    expect(f.editReply.mock.calls[0]![0]).toMatchObject({
      content: expect.stringContaining("page 1") as unknown,
      allowedMentions: { parse: [] },
      components: [{ type: ComponentType.ActionRow }],
    });
    expect(f.ids().map(({ label, disabled }) => ({ label, disabled }))).toEqual([
      { label: "Previous", disabled: true },
      { label: "Next", disabled: false },
    ]);
    for (const button of f.ids()) {
      expect(button.type).toBe(ComponentType.Button);
      expect(button.style).toBe(ButtonStyle.Secondary);
      expect(button.label.length).toBeLessThanOrEqual(80);
      expect(button.custom_id.length).toBeLessThanOrEqual(100);
      expect(parseScheduledListCustomId(button.custom_id)).toBeDefined();
    }
  });

  it("reads fresh pages forwards/backwards, commits revisions and rejects old controls", async () => {
    const f = fixture();
    await f.start();
    const old = f.button();
    f.list.mockResolvedValueOnce(found(false));
    await f.click(old);
    expect(f.list).toHaveBeenLastCalledWith({ guildId: "guild", channelId: "channel", page: 2 });
    expect(f.ids().map((b) => b.disabled)).toEqual([false, true]);
    expect(parseScheduledListCustomId(f.ids()[0]!.custom_id)?.revision).toBe(1);
    await f.click(old);
    expect(old.reply).toHaveBeenCalledOnce();
    expect(f.list).toHaveBeenCalledTimes(2);
    f.list.mockResolvedValueOnce(found(true));
    await f.click(f.button(f.ids()[0]!.custom_id));
    expect(f.list).toHaveBeenLastCalledWith({ guildId: "guild", channelId: "channel", page: 1 });
    expect(parseScheduledListCustomId(f.ids()[1]!.custom_id)?.revision).toBe(2);
  });

  it("keeps only Previous usable on a newly empty later page", async () => {
    const f = fixture();
    await f.start();
    f.list.mockResolvedValueOnce(found(false, true));
    await f.click(f.button());
    expect(f.editReply.mock.calls.at(-1)![0].content).toContain(
      "No active or executing scheduled messages were found on page 2",
    );
    expect(f.ids().map((b) => b.disabled)).toEqual([false, true]);
  });
  it.each([
    found(false, true),
    { outcome: "UNAVAILABLE" } as const,
    { ...found(), schedules: [{ ...row, scheduledActionId: "😀".repeat(2000) }] },
  ])("clears controls for empty, unavailable, or overflow initial results", async (result) => {
    const f = fixture();
    f.list.mockResolvedValueOnce(result);
    await f.start();
    expect(f.editReply.mock.calls[0]![0].components).toEqual([]);
    expect(f.editReply.mock.calls[0]![0].content!.length).toBeLessThanOrEqual(2000);
  });
  it("disables Next on an exact last first page and rejects both boundaries", async () => {
    const f = fixture();
    f.list.mockResolvedValueOnce(found(false));
    await f.start();
    expect(f.ids().map((b) => b.disabled)).toEqual([true, true]);
    for (const id of f.ids()) await f.click(f.button(id.custom_id));
    expect(f.list).toHaveBeenCalledTimes(1);
  });

  it.each([
    "user",
    "guild",
    "channel",
    "message",
    "permission",
    "type",
    "namespace",
    "revision",
    "session",
  ])("rejects wrong %s with no schedule disclosure, read, or original edit", async (field) => {
    const f = fixture();
    await f.start();
    const b = f.button();
    if (field === "user") b.user.id = "wrong";
    if (field === "guild") b.guildId = "wrong";
    if (field === "channel") b.channelId = "wrong";
    if (field === "message") b.message.id = "wrong";
    if (field === "permission") b.memberPermissions.has.mockReturnValue(false);
    if (field === "type") b.isButton = () => false;
    if (field === "namespace") b.customId = b.customId.replace("sml:1:", "sml:2:");
    if (field === "revision") b.customId = b.customId.replace(":0:next", ":1:next");
    if (field === "session") b.customId = `sml:1:${sessionId}:0:next`;
    await f.click(b);
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.editReply).toHaveBeenCalledTimes(1);
    expect(b.deferUpdate).not.toHaveBeenCalled();
    expect(b.reply).toHaveBeenCalledExactlyOnceWith({
      content: expect.stringContaining("Run /message schedule list again") as unknown,
      flags: MessageFlags.Ephemeral,
      components: [],
      allowedMentions: { parse: [] },
    });
    expect(JSON.stringify(b.reply.mock.calls)).not.toContain(row.scheduledActionId);
  });
  it("expires five minutes after creation even after navigation and rejects pre-restart controls", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.start();
    await vi.advanceTimersByTimeAsync(SCHEDULED_LIST_TTL_MS - 1);
    await f.click(f.button());
    const b = f.button();
    await vi.advanceTimersByTimeAsync(1);
    await f.click(b);
    expect(f.list).toHaveBeenCalledTimes(2);
    const restarted = createScheduledMessageListNavigation({ list: f.list });
    await restarted.navigate(b as unknown as ButtonInteraction);
    expect(f.list).toHaveBeenCalledTimes(2);
  });
  it("bounds idle sessions at 128 and lazily reclaims expired records", async () => {
    vi.useFakeTimers();
    const f = fixture();
    for (let i = 0; i < SCHEDULED_LIST_CAPACITY; i++) await f.start();
    await f.start();
    expect(f.list).toHaveBeenCalledTimes(128);
    expect(f.slash.reply).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(SCHEDULED_LIST_TTL_MS);
    await f.start();
    expect(f.list).toHaveBeenCalledTimes(129);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("scheduled list raw operation ownership and single flight", () => {
  it("acquires Busy before awaiting ACK and never queues concurrent Next/Previous", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.start();
    await f.click(f.button()); // page 2 enables both directions
    const ack = gate<void>();
    const first = f.button();
    first.deferUpdate.mockReturnValueOnce(ack.promise);
    const operation = f.click(first);
    const second = f.button(f.ids()[0]!.custom_id);
    await f.click(second);
    expect(second.reply).toHaveBeenCalledOnce();
    expect(f.list).toHaveBeenCalledTimes(2);
    expect(f.editReply).toHaveBeenCalledTimes(2);
    ack.resolve();
    await operation;
    expect(f.list).toHaveBeenCalledTimes(3);
    expect(f.editReply).toHaveBeenCalledTimes(3);
    expect(f.editReply.mock.calls.at(-1)![0].content).toContain("page 3");
  });
  it("rejects visible next-revision controls while an edit remains unconfirmed", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.start();
    const edit = gate<{ id: string }>();
    f.editReply.mockReturnValueOnce(edit.promise);
    const op = f.click(f.button());
    await flush();
    const visible = f.button();
    await f.click(visible);
    expect(visible.reply).toHaveBeenCalledOnce();
    expect(f.list).toHaveBeenCalledTimes(2);
    expect(f.editReply).toHaveBeenCalledTimes(2);
    edit.resolve({ id: "message" });
    await op;
    await f.click(f.button());
    expect(f.list).toHaveBeenCalledTimes(3);
  });
  it.each(["reject", "late-resolve", "late-reject"])(
    "never reads or retries an initial response after ACK %s",
    async (ending) => {
      vi.useFakeTimers();
      const f = fixture();
      await f.start();
      const b = f.button();
      const ack = gate<void>();
      b.deferUpdate.mockReturnValueOnce(ack.promise);
      let done = false;
      const op = f.click(b).then(() => {
        done = true;
      });
      if (ending === "reject") ack.reject(new Error("lost"));
      else await vi.advanceTimersByTimeAsync(2501);
      await flush();
      expect(f.list).toHaveBeenCalledTimes(1);
      expect(b.reply).not.toHaveBeenCalled();
      expect(b.followUp).not.toHaveBeenCalled();
      if (ending !== "reject") {
        expect(done).toBe(false);
        if (ending === "late-resolve") ack.resolve();
        else ack.reject(new Error("late"));
      }
      await op;
      expect(f.editReply).toHaveBeenCalledTimes(1);
      await f.click(f.button());
      expect(f.list).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["resolve", "reject"])(
    "retires timed out reads, owns late %s, and never publishes them",
    async (ending) => {
      vi.useFakeTimers();
      const f = fixture();
      await f.start();
      const read = gate<ListResult>();
      f.list.mockReturnValueOnce(read.promise);
      const b = f.button();
      let done = false;
      const op = f.click(b).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(2501);
      expect(b.followUp).toHaveBeenCalledOnce();
      expect(done).toBe(false);
      expect(f.editReply).toHaveBeenCalledTimes(1);
      await f.click(f.button());
      expect(f.list).toHaveBeenCalledTimes(2);
      if (ending === "resolve") read.resolve(found());
      else read.reject(new Error("late private DB failure"));
      await op;
      expect(f.editReply).toHaveBeenCalledTimes(1);
      expect(b.followUp).toHaveBeenCalledOnce();
    },
  );
  it.each(["resolve", "reject"])(
    "retires uncertain edits through late %s without a competing recovery edit",
    async (ending) => {
      vi.useFakeTimers();
      const f = fixture();
      await f.start();
      const old = f.button();
      const edit = gate<{ id: string }>();
      f.editReply.mockReturnValueOnce(edit.promise);
      let done = false;
      const op = f.click(old).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(2501);
      expect(done).toBe(false);
      expect(f.editReply).toHaveBeenCalledTimes(2);
      expect(old.followUp).toHaveBeenCalledOnce();
      await f.click(f.button());
      await f.click(old);
      expect(f.list).toHaveBeenCalledTimes(2);
      expect(f.editReply).toHaveBeenCalledTimes(2);
      if (ending === "resolve") edit.resolve({ id: "message" });
      else edit.reject(new Error("lost"));
      await op;
      await f.click(f.button());
      expect(f.list).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["resolve", "reject"] as const)(
    "retires a timed-out initial edit without another write through late %s",
    async (ending) => {
      vi.useFakeTimers();
      const f = fixture();
      const edit = gate<{ id: string }>();
      f.editReply.mockReturnValueOnce(edit.promise);
      let done = false;
      const operation = f.start().then(() => {
        done = true;
      });
      await flush();
      expect(f.slash.deferReply).toHaveBeenCalledExactlyOnceWith({ flags: MessageFlags.Ephemeral });
      expect(f.list).toHaveBeenCalledOnce();
      expect(f.editReply).toHaveBeenCalledOnce();
      const controls = f.button();
      await vi.advanceTimersByTimeAsync(2501);
      expect(done).toBe(false);
      expect(f.slash.followUp).not.toHaveBeenCalled();
      expect(f.slash.reply).not.toHaveBeenCalled();
      expect(f.editReply).toHaveBeenCalledOnce();
      await f.click(controls);
      expect(controls.deferUpdate).not.toHaveBeenCalled();
      expect(controls.reply).toHaveBeenCalledOnce();
      if (ending === "resolve") edit.resolve({ id: "message" });
      else edit.reject(new Error("late initial edit response loss"));
      await operation;
      expect(done).toBe(true);
      await f.click(f.button(controls.customId));
      expect(f.list).toHaveBeenCalledOnce();
      expect(f.editReply).toHaveBeenCalledOnce();
      expect(f.slash.deferReply).toHaveBeenCalledOnce();
      expect(f.slash.followUp).not.toHaveBeenCalled();
      expect(f.slash.reply).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not issue a recovery write after a rejected initial edit", async () => {
    const f = fixture();
    f.editReply.mockRejectedValueOnce(new Error("initial edit response loss"));
    await f.start();
    await f.click(f.button());
    expect(f.list).toHaveBeenCalledOnce();
    expect(f.editReply).toHaveBeenCalledOnce();
    expect(f.slash.deferReply).toHaveBeenCalledOnce();
    expect(f.slash.followUp).not.toHaveBeenCalled();
    expect(f.slash.reply).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "retains all initial-edit capacity through timeout and expiry until late %s",
    async (ending) => {
      vi.useFakeTimers();
      const f = fixture();
      const edit = gate<{ id: string }>();
      f.editReply.mockReturnValue(edit.promise);
      let settled = 0;
      const operations = Array.from({ length: SCHEDULED_LIST_CAPACITY }, () =>
        f.start().then(() => {
          settled++;
        }),
      );
      await vi.advanceTimersByTimeAsync(2501);
      expect(f.editReply).toHaveBeenCalledTimes(SCHEDULED_LIST_CAPACITY);
      const controls = f.button();
      expect(settled).toBe(0);
      expect(f.slash.followUp).not.toHaveBeenCalled();
      await f.start();
      expect(f.slash.reply).toHaveBeenCalledOnce();
      expect(f.list).toHaveBeenCalledTimes(SCHEDULED_LIST_CAPACITY);
      await vi.advanceTimersByTimeAsync(SCHEDULED_LIST_TTL_MS);
      await f.start();
      expect(f.slash.reply).toHaveBeenCalledTimes(2);
      expect(settled).toBe(0);
      expect(f.editReply).toHaveBeenCalledTimes(SCHEDULED_LIST_CAPACITY);
      expect(f.slash.followUp).not.toHaveBeenCalled();
      if (ending === "resolve") edit.resolve({ id: "message" });
      else edit.reject(new Error("late initial edit failure"));
      await Promise.all(operations);
      expect(settled).toBe(SCHEDULED_LIST_CAPACITY);
      expect(f.editReply).toHaveBeenCalledTimes(SCHEDULED_LIST_CAPACITY);
      expect(f.slash.followUp).not.toHaveBeenCalled();
      await f.click(controls);
      expect(controls.deferUpdate).not.toHaveBeenCalled();
      expect(f.list).toHaveBeenCalledTimes(SCHEDULED_LIST_CAPACITY);
      f.editReply.mockResolvedValue({ id: "message" });
      await f.start();
      expect(f.list).toHaveBeenCalledTimes(SCHEDULED_LIST_CAPACITY + 1);
      expect(f.editReply).toHaveBeenCalledTimes(SCHEDULED_LIST_CAPACITY + 1);
      await f.click(f.button());
      expect(f.list).toHaveBeenLastCalledWith({ guildId: "guild", channelId: "channel", page: 2 });
      expect(f.slash.followUp).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["failure", "timeout-resolve", "timeout-reject"] as const)(
    "preserves the safe initial error edit before a list edit starts (%s)",
    async (ending) => {
      vi.useFakeTimers();
      const f = fixture();
      const read = gate<ListResult>();
      f.list.mockReturnValueOnce(read.promise);
      let done = false;
      const operation = f.start().then(() => {
        done = true;
      });
      await flush();
      expect(f.editReply).not.toHaveBeenCalled();
      if (ending === "failure") read.reject(new Error("DB unavailable"));
      else await vi.advanceTimersByTimeAsync(2501);
      await flush();
      expect(f.editReply).toHaveBeenCalledExactlyOnceWith({
        content: "WEFT could not load scheduled messages. Please try again later.",
        components: [],
        allowedMentions: { parse: [] },
      });
      expect(f.slash.followUp).not.toHaveBeenCalled();
      if (ending !== "failure") {
        expect(done).toBe(false);
        if (ending === "timeout-resolve") read.resolve(found());
        else read.reject(new Error("late read failure"));
      }
      await operation;
      expect(done).toBe(true);
      expect(f.editReply).toHaveBeenCalledOnce();
      expect(f.slash.deferReply).toHaveBeenCalledOnce();
      expect(f.slash.followUp).not.toHaveBeenCalled();
      expect(f.slash.reply).not.toHaveBeenCalled();
    },
  );

  it("retires after a returned edit message identity mismatch", async () => {
    const f = fixture();
    await f.start();
    const b = f.button();
    f.editReply.mockResolvedValueOnce({ id: "different-message" });
    await f.click(b);
    expect(b.followUp).toHaveBeenCalledOnce();
    await f.click(f.button());
    expect(f.list).toHaveBeenCalledTimes(2);
    expect(f.editReply).toHaveBeenCalledTimes(2);
  });
  it("does not read or attempt a second response after an initial slash ACK rejection", async () => {
    const f = fixture();
    f.slash.deferReply.mockRejectedValueOnce(new Error("response lost"));
    await f.start();
    expect(f.list).not.toHaveBeenCalled();
    expect(f.editReply).not.toHaveBeenCalled();
    expect(f.slash.reply).not.toHaveBeenCalled();
    expect(f.slash.followUp).not.toHaveBeenCalled();
  });

  it("does not mistake unavailable navigation for an empty page", async () => {
    const f = fixture();
    await f.start();
    f.list.mockResolvedValueOnce({ outcome: "UNAVAILABLE" });
    const b = f.button();
    await f.click(b);
    expect(f.editReply).toHaveBeenCalledTimes(1);
    expect(b.followUp).toHaveBeenCalledOnce();
  });
  it("owns a timeout follow-up through raw settlement", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.start();
    f.list.mockRejectedValueOnce(new Error("DB unavailable"));
    const b = f.button();
    const followUp = gate<void>();
    b.followUp.mockReturnValueOnce(followUp.promise);
    let done = false;
    const op = f.click(b).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(2501);
    expect(done).toBe(false);
    followUp.reject(new Error("response lost"));
    await op;
    expect(b.followUp).toHaveBeenCalledOnce();
    expect(b.reply).not.toHaveBeenCalled();
  });
  it("revokes publication when the fixed session TTL expires during a fresh read", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.start();
    await vi.advanceTimersByTimeAsync(SCHEDULED_LIST_TTL_MS - 1);
    const read = gate<ListResult>();
    f.list.mockReturnValueOnce(read.promise);
    const b = f.button();
    const op = f.click(b);
    await flush();
    await vi.advanceTimersByTimeAsync(1);
    read.resolve(found());
    await op;
    expect(f.editReply).toHaveBeenCalledTimes(1);
    expect(b.followUp).toHaveBeenCalledOnce();
  });
  it.each(["ack", "edit"] as const)(
    "retains capacity for expired, unconfirmed initial %s work",
    async (stage) => {
      vi.useFakeTimers();
      const f = fixture();
      const pending = gate<{ id: string }>();
      if (stage === "ack") f.slash.deferReply.mockReturnValue(pending.promise);
      else f.editReply.mockReturnValue(pending.promise);
      let done = 0;
      const operations = Array.from({ length: 128 }, () =>
        f.start().then(() => {
          done++;
        }),
      );
      await vi.advanceTimersByTimeAsync(SCHEDULED_LIST_TTL_MS + 1);
      await f.start();
      expect(f.slash.reply).toHaveBeenCalledOnce();
      expect(done).toBe(0);
      expect(f.list).toHaveBeenCalledTimes(stage === "ack" ? 0 : 128);
      pending.resolve({ id: "message" });
      await Promise.all(operations);
      expect(done).toBe(128);
      f.slash.deferReply.mockResolvedValue(undefined);
      f.editReply.mockResolvedValue({ id: "message" });
      await f.start();
      expect(f.list).toHaveBeenCalledTimes(stage === "ack" ? 1 : 129);
    },
  );
  it("keeps rejected-button response ownership until its raw reply settles", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const b = f.button("sml:invalid");
    const response = gate<void>();
    b.reply.mockReturnValueOnce(response.promise);
    let done = false;
    const op = f.click(b).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(2501);
    expect(done).toBe(false);
    response.reject(new Error("late response loss"));
    await op;
    expect(b.reply).toHaveBeenCalledOnce();
    expect(b.deferUpdate).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
  });
  it("does not begin ACK or reads for an interaction already beyond the ACK budget", async () => {
    const f = fixture();
    await f.start();
    const b = f.button();
    b.createdTimestamp = Date.now() - 2500;
    await f.click(b);
    expect(b.deferUpdate).not.toHaveBeenCalled();
    expect(b.reply).not.toHaveBeenCalled();
    expect(f.list).toHaveBeenCalledTimes(1);
  });

  it("keeps retired raw reads in capacity after timeout and expiry, then reclaims at settlement", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const read = gate<ListResult>();
    f.list.mockReturnValue(read.promise);
    let settled = 0;
    const operations = Array.from({ length: 128 }, () =>
      f.start().then(() => {
        settled++;
      }),
    );
    await vi.advanceTimersByTimeAsync(SCHEDULED_LIST_TTL_MS + 1);
    expect(settled).toBe(0);
    expect(f.list).toHaveBeenCalledTimes(128);
    await f.start();
    expect(f.slash.reply).toHaveBeenCalledOnce();
    expect(f.list).toHaveBeenCalledTimes(128);
    read.resolve(found());
    await Promise.all(operations);
    expect(settled).toBe(128);
    f.list.mockResolvedValue(found());
    await f.start();
    expect(f.list).toHaveBeenCalledTimes(129);
    // Only initial timeout fallback edits, never late pages.
    expect(f.editReply.mock.calls.slice(0, 128).every(([o]) => o.components?.length === 0)).toBe(
      true,
    );
  });
});
