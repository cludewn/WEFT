import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { GuildSettings, GuildSettingsStore } from "../../src/guild-settings.js";
import {
  addClosedPrefix,
  BotThreadPermissionError,
  createThreadLifecycleService,
  InvalidThreadNameError,
  removeClosedPrefix,
} from "../../src/thread-lifecycle.js";
import type { ThreadLifecycleDiscord, ThreadSnapshot } from "../../src/thread-lifecycle.js";
import type {
  ManagedThread,
  ManagedThreadStore,
  ThreadAuditRecord,
  ThreadAuditStore,
} from "../../src/thread-persistence.js";

describe("thread title rules", () => {
  it("adds one prefix and removes only the saved leading prefix", () => {
    expect(addClosedPrefix("Topic", "[CLOSED]")).toBe("[CLOSED] Topic");
    expect(addClosedPrefix("[CLOSED] Topic", "[CLOSED]")).toBe("[CLOSED] Topic");
    expect(removeClosedPrefix("[OLD] Edited topic", "[OLD]")).toBe("Edited topic");
    expect(removeClosedPrefix("Edited [OLD] topic", "[OLD]")).toBe("Edited [OLD] topic");
  });

  it("truncates Unicode titles to 100 code points", () => {
    const result = addClosedPrefix("😀".repeat(100), "✅");
    expect([...result]).toHaveLength(100);
    expect(result).toBe(`✅ ${"😀".repeat(98)}`);
  });

  it("rejects a prefix and separator that leave no title space", () => {
    expect(() => addClosedPrefix("Topic", "x".repeat(99))).toThrow(InvalidThreadNameError);
    expect(() => removeClosedPrefix("[CLOSED] ", "[CLOSED]")).toThrow(InvalidThreadNameError);
  });
});

describe("thread lifecycle", () => {
  it("closes in the required order without locking", async () => {
    const fixture = createFixture();

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: true,
    });

    expect(fixture.calls).toEqual([
      "fetch",
      "actor-permission",
      "bot-permission",
      "settings",
      "state-find",
      "fetch",
      "actor-permission",
      "bot-permission",
      "rename:[CLOSED] Topic",
      "state-closed:[CLOSED]",
      "fetch",
      "actor-permission",
      "bot-permission",
      "archive",
      "audit:CLOSE:SUCCESS",
    ]);
    expect(fixture.thread.locked).toBe(false);
    expect(fixture.state?.lifecycleState).toBe("CLOSED");
  });

  it("checks actor and bot permissions", async () => {
    const actorDenied = createFixture({ actorCanManage: false });
    const botDenied = createFixture({ botCanManage: false });

    await expect(actorDenied.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      code: "ACTOR_PERMISSION_MISSING",
    });
    await expect(botDenied.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      code: "BOT_PERMISSION_MISSING",
    });
    expect(actorDenied.audits[0]?.outcome).toBe("FAILURE");
    expect(botDenied.audits[0]?.outcome).toBe("FAILURE");
  });

  it("rejects an already locked thread before close effects and records failure audit", async () => {
    const fixture = createFixture({ locked: true });

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      code: "THREAD_LOCKED",
    });

    expect(fixture.discord.renameThread).not.toHaveBeenCalled();
    expect(fixture.managedThreads.saveClosed).not.toHaveBeenCalled();
    expect(fixture.discord.archiveThread).not.toHaveBeenCalled();
    expect(fixture.thread.locked).toBe(true);
    expect(fixture.calls).toEqual(["fetch", "audit:CLOSE:FAILURE"]);
    expect(fixture.audits).toEqual([
      expect.objectContaining({
        action: "CLOSE",
        outcome: "FAILURE",
        failureCode: "THREAD_LOCKED",
      }),
    ]);
  });

  it("classifies a Bot permission loss immediately before a Discord operation", async () => {
    const fixture = createFixture();
    fixture.discord.renameThread = vi.fn(() => Promise.reject(new BotThreadPermissionError()));

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      code: "BOT_PERMISSION_MISSING",
    });
  });

  it("classifies fetch, rename, archive, and state failures without reporting success", async () => {
    const cases = [
      { method: "fetchThread", code: "DISCORD_FETCH_FAILED" },
      { method: "renameThread", code: "DISCORD_RENAME_FAILED" },
      { method: "archiveThread", code: "DISCORD_ARCHIVE_FAILED" },
      { method: "saveClosed", code: "STATE_WRITE_FAILED" },
    ] as const;

    for (const testCase of cases) {
      const fixture = createFixture();
      if (testCase.method === "saveClosed") {
        fixture.managedThreads.saveClosed = vi.fn(() => Promise.reject(new Error("opaque")));
      } else if (testCase.method === "fetchThread") {
        fixture.discord.fetchThread = vi.fn(() => Promise.reject(new Error("opaque")));
      } else if (testCase.method === "renameThread") {
        fixture.discord.renameThread = vi.fn(() => Promise.reject(new Error("opaque")));
      } else {
        fixture.discord.archiveThread = vi.fn(() => Promise.reject(new Error("opaque")));
      }

      const result = await fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID);
      expect(result).toEqual({ ok: false, code: testCase.code });
      expect(fixture.audits.at(-1)).toMatchObject({
        action: "CLOSE",
        outcome: "FAILURE",
        failureCode: testCase.code,
      });
    }
  });

  it("returns an audit failure code when failure audit persistence is unavailable", async () => {
    const fixture = createFixture();
    fixture.auditStore.record = vi.fn<ThreadAuditStore["record"]>(() =>
      Promise.reject(new Error("opaque")),
    );

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      code: "AUDIT_WRITE_FAILED",
    });
  });

  it("retries idempotently after a partial archive failure", async () => {
    const fixture = createFixture();
    fixture.discord.archiveThread = vi
      .fn<ThreadLifecycleDiscord["archiveThread"]>()
      .mockRejectedValueOnce(new Error("opaque"))
      .mockImplementation(() => {
        fixture.thread.archived = true;
        return Promise.resolve();
      });

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      code: "DISCORD_ARCHIVE_FAILED",
    });
    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: true,
    });

    expect(fixture.discord.renameThread).toHaveBeenCalledOnce();
    expect(fixture.thread.name).toBe("[CLOSED] Topic");
    expect(fixture.state?.lifecycleState).toBe("CLOSED");
  });

  it("does not archive when locked after state persistence and completes after manual unlock", async () => {
    const fixture = createFixture();
    let fetchCount = 0;
    fixture.discord.fetchThread = vi.fn<ThreadLifecycleDiscord["fetchThread"]>(() => {
      fetchCount += 1;
      fixture.calls.push("fetch");
      if (fetchCount === 3) {
        fixture.thread.locked = true;
      }
      return Promise.resolve({ ...fixture.thread });
    });

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      code: "THREAD_LOCKED",
    });
    expect(fixture.thread.name).toBe("[CLOSED] Topic");
    expect(fixture.state).toMatchObject({
      lifecycleState: "CLOSED",
      appliedPrefix: "[CLOSED]",
    });
    expect(fixture.discord.archiveThread).not.toHaveBeenCalled();
    expect(fixture.audits.at(-1)).toMatchObject({
      action: "CLOSE",
      outcome: "FAILURE",
      failureCode: "THREAD_LOCKED",
    });

    fixture.thread.locked = false;
    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: true,
    });

    expect(fixture.discord.renameThread).toHaveBeenCalledOnce();
    expect(fixture.thread.name).toBe("[CLOSED] Topic");
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();
    expect(fixture.thread.archived).toBe(true);
  });

  it("retries after state persistence fails without duplicating the prefix", async () => {
    const fixture = createFixture();
    const originalSave = fixture.managedThreads.saveClosed;
    fixture.managedThreads.saveClosed = vi
      .fn<ManagedThreadStore["saveClosed"]>()
      .mockRejectedValueOnce(new Error("opaque"))
      .mockImplementation(originalSave);

    await fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID);
    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: true,
    });

    expect(fixture.thread.name).toBe("[CLOSED] Topic");
    expect(fixture.discord.renameThread).toHaveBeenCalledOnce();
  });

  it("opens with the prefix saved at close even after guild settings change", async () => {
    const fixture = createFixture({ prefix: "[OLD]" });
    await fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID);
    fixture.thread.archived = false;
    fixture.settings.closedPrefix = "[NEW]";
    fixture.thread.name = "[OLD] Manually edited";

    await expect(fixture.service.open(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: true,
    });

    expect(fixture.thread.name).toBe("Manually edited");
    expect(fixture.state?.lifecycleState).toBe("OPEN");
    expect(fixture.audits.at(-1)).toMatchObject({ action: "OPEN", outcome: "SUCCESS" });
  });

  it("reconciles an automatically unarchived closed thread", async () => {
    const fixture = createFixture({
      threadName: "[CLOSED] Topic",
      archived: false,
      state: createManagedState("CLOSED", "[CLOSED]"),
    });

    await expect(fixture.service.autoOpen(GUILD_ID, THREAD_ID)).resolves.toEqual({
      ok: true,
      changed: true,
    });

    expect(fixture.thread.name).toBe("Topic");
    expect(fixture.state?.lifecycleState).toBe("OPEN");
    expect(fixture.audits[0]).toMatchObject({
      action: "AUTO_OPEN",
      actorType: "SYSTEM",
      outcome: "SUCCESS",
    });
  });

  it("closes again after a successful automatic open reconciliation", async () => {
    const fixture = createFixture();

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: true,
    });
    expect(fixture.thread).toMatchObject({ name: "[CLOSED] Topic", archived: true });
    expect(fixture.state?.lifecycleState).toBe("CLOSED");

    fixture.thread.archived = false;
    await expect(fixture.service.autoOpen(GUILD_ID, THREAD_ID)).resolves.toEqual({
      ok: true,
      changed: true,
    });
    expect(fixture.thread).toMatchObject({ name: "Topic", archived: false });
    expect(fixture.state?.lifecycleState).toBe("OPEN");

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: true,
    });
    expect(fixture.thread).toMatchObject({ name: "[CLOSED] Topic", archived: true });
    expect(fixture.state?.lifecycleState).toBe("CLOSED");
    expect(fixture.audits).toEqual([
      expect.objectContaining({ action: "CLOSE", outcome: "SUCCESS" }),
      expect.objectContaining({ action: "AUTO_OPEN", outcome: "SUCCESS" }),
      expect.objectContaining({ action: "CLOSE", outcome: "SUCCESS" }),
    ]);
    expect(fixture.discord.renameThread).toHaveBeenCalledTimes(3);
    expect(fixture.discord.archiveThread).toHaveBeenCalledTimes(2);
  });

  it("keeps closed state after automatic open failure and can retry", async () => {
    const fixture = createFixture({
      threadName: "[CLOSED] Topic",
      archived: false,
      state: createManagedState("CLOSED", "[CLOSED]"),
    });
    fixture.discord.renameThread = vi
      .fn<ThreadLifecycleDiscord["renameThread"]>()
      .mockRejectedValueOnce(new Error("opaque"))
      .mockImplementation((_guildId, _threadId, name) => {
        fixture.thread.name = name;
        return Promise.resolve();
      });

    await expect(fixture.service.autoOpen(GUILD_ID, THREAD_ID)).resolves.toEqual({
      ok: false,
      code: "DISCORD_RENAME_FAILED",
    });
    expect(fixture.state?.lifecycleState).toBe("CLOSED");

    await expect(fixture.service.open(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: true,
    });
    expect(fixture.state?.lifecycleState).toBe("OPEN");
  });

  it("keeps closed state when the open state write fails", async () => {
    const fixture = createFixture({
      threadName: "[CLOSED] Topic",
      archived: false,
      state: createManagedState("CLOSED", "[CLOSED]"),
    });
    fixture.managedThreads.markOpen = vi.fn(() => Promise.reject(new Error("opaque")));

    await expect(fixture.service.autoOpen(GUILD_ID, THREAD_ID)).resolves.toEqual({
      ok: false,
      code: "STATE_WRITE_FAILED",
    });
    expect(fixture.state?.lifecycleState).toBe("CLOSED");
    expect(fixture.audits.at(-1)).toMatchObject({ outcome: "FAILURE" });
  });

  it("treats already open state as an idempotent command success", async () => {
    const fixture = createFixture({
      archived: false,
      state: createManagedState("OPEN", "[CLOSED]"),
    });

    await expect(fixture.service.open(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: false,
    });
    expect(fixture.discord.renameThread).not.toHaveBeenCalled();
    expect(fixture.audits[0]).toMatchObject({ action: "OPEN", outcome: "SUCCESS" });
  });
});

const GUILD_ID = "100000000000000001";
const THREAD_ID = "200000000000000001";
const ACTOR_ID = "300000000000000001";

function createManagedState(
  lifecycleState: "OPEN" | "CLOSED",
  appliedPrefix: string,
): ManagedThread {
  return {
    guildId: GUILD_ID,
    threadId: THREAD_ID,
    appliedPrefix,
    lifecycleState,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function createFixture({
  prefix = "[CLOSED]",
  threadName = "Topic",
  archived = false,
  actorCanManage = true,
  botCanManage = true,
  locked = false,
  state,
}: {
  prefix?: string;
  threadName?: string;
  archived?: boolean;
  actorCanManage?: boolean;
  botCanManage?: boolean;
  locked?: boolean;
  state?: ManagedThread;
} = {}) {
  const calls: string[] = [];
  const audits: ThreadAuditRecord[] = [];
  const thread: ThreadSnapshot = {
    guildId: GUILD_ID,
    threadId: THREAD_ID,
    type: ChannelType.PublicThread,
    name: threadName,
    archived,
    locked,
  };
  let managedState = state;
  const settings: GuildSettings = {
    guildId: GUILD_ID,
    timezone: "UTC",
    closedPrefix: prefix,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
  const discord: ThreadLifecycleDiscord = {
    fetchThread: vi.fn<ThreadLifecycleDiscord["fetchThread"]>(() => {
      calls.push("fetch");
      return Promise.resolve({ ...thread });
    }),
    actorCanManage: vi.fn<ThreadLifecycleDiscord["actorCanManage"]>(() => {
      calls.push("actor-permission");
      return Promise.resolve(actorCanManage);
    }),
    botCanManage: vi.fn<ThreadLifecycleDiscord["botCanManage"]>(() => {
      calls.push("bot-permission");
      return Promise.resolve(botCanManage);
    }),
    renameThread: vi.fn<ThreadLifecycleDiscord["renameThread"]>((_guildId, _threadId, name) => {
      calls.push(`rename:${name}`);
      thread.name = name;
      return Promise.resolve();
    }),
    archiveThread: vi.fn<ThreadLifecycleDiscord["archiveThread"]>(() => {
      calls.push("archive");
      thread.archived = true;
      return Promise.resolve();
    }),
  };
  const guildSettings = {
    getOrCreate: vi.fn<GuildSettingsStore["getOrCreate"]>(() => {
      calls.push("settings");
      return Promise.resolve(settings);
    }),
    setTimezone: vi.fn(),
    setClosedPrefix: vi.fn(),
  } as unknown as GuildSettingsStore;
  const managedThreads: ManagedThreadStore = {
    find: vi.fn<ManagedThreadStore["find"]>(() => {
      calls.push("state-find");
      return Promise.resolve(managedState);
    }),
    saveClosed: vi.fn<ManagedThreadStore["saveClosed"]>((_guildId, _threadId, appliedPrefix) => {
      calls.push(`state-closed:${appliedPrefix}`);
      managedState = createManagedState("CLOSED", appliedPrefix);
      return Promise.resolve(managedState);
    }),
    markOpen: vi.fn<ManagedThreadStore["markOpen"]>(() => {
      calls.push("state-open");
      if (managedState === undefined) return Promise.reject(new Error("Missing state"));
      managedState = { ...managedState, lifecycleState: "OPEN", updatedAt: new Date() };
      return Promise.resolve(managedState);
    }),
  };
  const auditStore: ThreadAuditStore = {
    record: vi.fn<ThreadAuditStore["record"]>((audit) => {
      calls.push(`audit:${audit.action}:${audit.outcome}`);
      audits.push(audit);
      return Promise.resolve();
    }),
  };
  const service = createThreadLifecycleService({
    discord,
    guildSettings,
    managedThreads,
    audits: auditStore,
  });

  return {
    service,
    calls,
    audits,
    thread,
    settings,
    discord,
    managedThreads,
    auditStore,
    get state() {
      return managedState;
    },
  };
}
