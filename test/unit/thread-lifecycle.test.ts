import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { ChatInputCommandInteraction } from "discord.js";

import type { GuildSettings, GuildSettingsStore } from "../../src/guild-settings.js";
import { handleThreadCommand } from "../../src/thread-command.js";
import {
  addClosedPrefix,
  createThreadLifecycleService,
  DEFAULT_DISCORD_MUTATION_TIMEOUT_MS,
  DEFAULT_THREAD_LIFECYCLE_DEADLINE_MS,
  InvalidThreadNameError,
  PendingDiscordMutationGuard,
  removeClosedPrefix,
} from "../../src/thread-lifecycle.js";
import type {
  ThreadFailureCode,
  ThreadLifecycleDiscord,
  ThreadSnapshot,
} from "../../src/thread-lifecycle.js";
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
  it("uses a bounded default lifecycle deadline", () => {
    expect(DEFAULT_THREAD_LIFECYCLE_DEADLINE_MS).toBe(15_000);
    expect(DEFAULT_DISCORD_MUTATION_TIMEOUT_MS).toBe(5_000);
  });

  it("does not let an older mutation generation clear a newer guard", () => {
    const guard = new PendingDiscordMutationGuard();
    const oldMutation = new Promise<void>(() => undefined);
    const newMutation = new Promise<void>(() => undefined);

    const oldGeneration = guard.track(GUILD_ID, THREAD_ID, oldMutation);
    const newGeneration = guard.track(GUILD_ID, THREAD_ID, newMutation);
    expect(newGeneration).toBeGreaterThan(oldGeneration);

    guard.release(GUILD_ID, THREAD_ID, oldGeneration);
    expect(guard.isPending(GUILD_ID, THREAD_ID)).toBe(true);

    guard.release(GUILD_ID, THREAD_ID, newGeneration);
    expect(guard.isPending(GUILD_ID, THREAD_ID)).toBe(false);
  });

  it("keeps a settled mutation guarded until reconciliation releases it", async () => {
    const guard = new PendingDiscordMutationGuard();
    const mutation = Promise.resolve();
    const generation = guard.track(GUILD_ID, THREAD_ID, mutation);

    await mutation;
    expect(guard.isPending(GUILD_ID, THREAD_ID)).toBe(true);

    guard.release(GUILD_ID, THREAD_ID, generation);
    expect(guard.isPending(GUILD_ID, THREAD_ID)).toBe(false);
  });

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

  it("classifies fetch, archive, and state failures without reporting success", async () => {
    const cases = [
      { method: "fetchThread", code: "DISCORD_FETCH_FAILED" },
      { method: "archiveThread", code: "DISCORD_ARCHIVE_FAILED" },
      { method: "saveClosed", code: "STATE_WRITE_FAILED" },
    ] as const;

    for (const testCase of cases) {
      const fixture = createFixture();
      if (testCase.method === "saveClosed") {
        fixture.managedThreads.saveClosed = vi.fn(() => Promise.reject(new Error("opaque")));
      } else if (testCase.method === "fetchThread") {
        fixture.discord.fetchThread = vi.fn(() => Promise.reject(new Error("opaque")));
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
      expect(JSON.stringify(fixture.logger.warn.mock.calls)).not.toContain("opaque");
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
      .mockImplementation((_guildId, _threadId, name) => {
        fixture.thread.name = name;
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

    expect(fixture.discord.renameThread).not.toHaveBeenCalled();
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
    expect(fixture.thread.name).toBe("Topic");
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

    expect(fixture.discord.renameThread).not.toHaveBeenCalled();
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
    expect(fixture.discord.renameThread).not.toHaveBeenCalled();
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();
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

  it("opens after Discord unarchives the thread while creating the slash command", async () => {
    const fixture = createFixture({
      threadName: "[CLOSED] Topic",
      archived: true,
      state: createManagedState("CLOSED", "[CLOSED]"),
    });
    const command = createThreadInteraction("open");

    fixture.thread.archived = false;
    await handleThreadCommand(command.interaction, fixture.service, fixture.logger, 250);

    expect(fixture.thread).toMatchObject({ name: "Topic", archived: false });
    expect(fixture.state?.lifecycleState).toBe("OPEN");
    expect(fixture.audits).toEqual([
      expect.objectContaining({ action: "OPEN", actorType: "USER", outcome: "SUCCESS" }),
    ]);
    expect(command.editReply).toHaveBeenCalledWith({
      content: "Thread opened.",
      allowedMentions: { parse: [] },
    });
  });

  it("serializes automatic and explicit open reconciliation for the same thread", async () => {
    const fixture = createFixture({
      threadName: "[CLOSED] Topic",
      archived: false,
      deadlineMs: 1_000,
      state: createManagedState("CLOSED", "[CLOSED]"),
    });
    let completeRename: (() => void) | undefined;
    fixture.discord.renameThread = vi.fn<ThreadLifecycleDiscord["renameThread"]>(
      (_guildId, _threadId, name) =>
        new Promise<void>((resolve) => {
          completeRename = () => {
            fixture.thread.name = name;
            resolve();
          };
        }),
    );

    const automaticOpen = fixture.service.autoOpen(GUILD_ID, THREAD_ID);
    await vi.waitFor(() => expect(fixture.discord.renameThread).toHaveBeenCalledOnce());

    const command = createThreadInteraction("open");
    const explicitOpen = handleThreadCommand(
      command.interaction,
      fixture.service,
      fixture.logger,
      250,
    );
    await vi.waitFor(() => expect(command.reply).toHaveBeenCalledOnce());
    expect(fixture.discord.actorCanManage).not.toHaveBeenCalled();
    expect(fixture.managedThreads.markOpen).not.toHaveBeenCalled();

    fixture.discord.actorCanManage = vi
      .fn<ThreadLifecycleDiscord["actorCanManage"]>()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            setTimeout(() => resolve(true), 400);
          }),
      )
      .mockResolvedValue(true);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 700);
    });
    completeRename?.();
    await expect(automaticOpen).resolves.toEqual({ ok: true, changed: true });
    await explicitOpen;

    expect(fixture.discord.renameThread).toHaveBeenCalledOnce();
    expect(fixture.managedThreads.markOpen).toHaveBeenCalledOnce();
    expect(fixture.discord.actorCanManage).toHaveBeenCalled();
    expect(fixture.thread.name).toBe("Topic");
    expect(fixture.state?.lifecycleState).toBe("OPEN");
    expect(fixture.audits).toEqual([
      expect.objectContaining({ action: "AUTO_OPEN", outcome: "SUCCESS" }),
      expect.objectContaining({ action: "OPEN", outcome: "SUCCESS" }),
    ]);
    expect(command.editReply).toHaveBeenCalledWith({
      content: "Thread opened.",
      allowedMentions: { parse: [] },
    });
    expect(fixture.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "thread_lifecycle_queue_wait_completed",
        operation: "OPEN",
      }),
      "Thread lifecycle queue wait completed",
    );
  });

  it("allows different threads to reconcile in parallel", async () => {
    const fixture = createFixture({
      threadName: "[CLOSED] Topic",
      archived: false,
      state: createManagedState("CLOSED", "[CLOSED]"),
    });
    const otherThreadId = "200000000000000002";
    const fetchThread = fixture.discord.fetchThread;
    let completeFirstFetch: (() => void) | undefined;
    fixture.discord.fetchThread = vi.fn<ThreadLifecycleDiscord["fetchThread"]>(
      (guildId, threadId) => {
        if (threadId === THREAD_ID && completeFirstFetch === undefined) {
          return new Promise<ThreadSnapshot | undefined>((resolve, reject) => {
            completeFirstFetch = () => {
              void fetchThread(guildId, threadId).then(resolve, reject);
            };
          });
        }
        return fetchThread(guildId, threadId);
      },
    );

    const first = fixture.service.autoOpen(GUILD_ID, THREAD_ID);
    await vi.waitFor(() => expect(completeFirstFetch).toBeTypeOf("function"));

    await expect(fixture.service.autoOpen(GUILD_ID, otherThreadId)).resolves.toEqual({
      ok: true,
      changed: true,
    });
    completeFirstFetch?.();
    await expect(first).resolves.toEqual({ ok: true, changed: false });
  });

  it("closes again with one Discord mutation after automatic open reconciliation", async () => {
    const fixture = createFixture();
    const firstClose = createThreadInteraction("close");

    await handleThreadCommand(firstClose.interaction, fixture.service, fixture.logger, 50);
    expect(firstClose.editReply).toHaveBeenCalledWith({
      content: "Thread closed.",
      allowedMentions: { parse: [] },
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

    const mutationsBeforeSecondClose =
      vi.mocked(fixture.discord.renameThread).mock.calls.length +
      vi.mocked(fixture.discord.archiveThread).mock.calls.length;
    const secondClose = createThreadInteraction("close");
    await handleThreadCommand(secondClose.interaction, fixture.service, fixture.logger, 50);
    expect(secondClose.editReply).toHaveBeenCalledWith({
      content: "Thread closed.",
      allowedMentions: { parse: [] },
    });
    expect(fixture.thread).toMatchObject({ name: "[CLOSED] Topic", archived: true });
    expect(fixture.state?.lifecycleState).toBe("CLOSED");
    expect(
      vi.mocked(fixture.discord.renameThread).mock.calls.length +
        vi.mocked(fixture.discord.archiveThread).mock.calls.length,
    ).toBe(mutationsBeforeSecondClose + 1);
    expect(fixture.audits).toEqual([
      expect.objectContaining({ action: "CLOSE", outcome: "SUCCESS" }),
      expect.objectContaining({ action: "AUTO_OPEN", outcome: "SUCCESS" }),
      expect.objectContaining({ action: "CLOSE", outcome: "SUCCESS" }),
    ]);
    expect(fixture.discord.renameThread).toHaveBeenCalledOnce();
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

  it("removes a saved prefix even when managed state is already open", async () => {
    const fixture = createFixture({
      threadName: "[CLOSED] Topic",
      archived: false,
      state: createManagedState("OPEN", "[CLOSED]"),
    });

    await expect(fixture.service.open(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: true,
    });

    expect(fixture.thread.name).toBe("Topic");
    expect(fixture.state?.lifecycleState).toBe("OPEN");
    expect(fixture.managedThreads.markOpen).not.toHaveBeenCalled();
    expect(fixture.audits[0]).toMatchObject({ action: "OPEN", outcome: "SUCCESS" });
  });

  it("times out every external close boundary with a classified safe log", async () => {
    const never = (): Promise<never> => new Promise(() => undefined);
    const cases: Array<{
      boundary: string;
      code: ThreadFailureCode;
      stall: (fixture: ReturnType<typeof createFixture>) => void;
    }> = [
      {
        boundary: "thread_fetch",
        code: "DISCORD_FETCH_TIMEOUT",
        stall: (fixture) => {
          fixture.discord.fetchThread = vi.fn(never);
        },
      },
      {
        boundary: "actor_permission_check",
        code: "ACTOR_PERMISSION_TIMEOUT",
        stall: (fixture) => {
          fixture.discord.actorCanManage = vi.fn(never);
        },
      },
      {
        boundary: "bot_permission_check",
        code: "BOT_PERMISSION_TIMEOUT",
        stall: (fixture) => {
          fixture.discord.botCanManage = vi.fn(never);
        },
      },
      {
        boundary: "guild_settings_read",
        code: "SETTINGS_READ_TIMEOUT",
        stall: (fixture) => {
          fixture.guildSettings.getOrCreate = vi.fn(never);
        },
      },
      {
        boundary: "managed_state_read",
        code: "STATE_READ_TIMEOUT",
        stall: (fixture) => {
          fixture.managedThreads.find = vi.fn(never);
        },
      },
      {
        boundary: "managed_state_write",
        code: "STATE_WRITE_OUTCOME_UNKNOWN",
        stall: (fixture) => {
          fixture.managedThreads.saveClosed = vi.fn(never);
        },
      },
      {
        boundary: "thread_archive",
        code: "DISCORD_ARCHIVE_OUTCOME_UNKNOWN",
        stall: (fixture) => {
          fixture.discord.archiveThread = vi.fn(never);
        },
      },
      {
        boundary: "audit_write",
        code: "AUDIT_WRITE_OUTCOME_UNKNOWN",
        stall: (fixture) => {
          fixture.auditStore.record = vi.fn(never);
        },
      },
    ];

    for (const testCase of cases) {
      const fixture = createFixture({ deadlineMs: 50 });
      testCase.stall(fixture);

      await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
        ok: false,
        code: testCase.code,
      });
      expect(fixture.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "thread_lifecycle_boundary_failed",
          guildId: GUILD_ID,
          threadId: THREAD_ID,
          operation: "CLOSE",
          boundary: testCase.boundary,
          failureCode: testCase.code,
        }),
        "Thread lifecycle boundary failed",
      );
      const loggedFields: unknown = fixture.logger.warn.mock.calls.at(-1)?.[0];
      expect(loggedFields).toHaveProperty("durationMs", expect.any(Number));
    }
  });

  it("shares one deadline across sequential boundaries", async () => {
    const fixture = createFixture({ deadlineMs: 100 });
    fixture.discord.fetchThread = vi.fn(
      () =>
        new Promise<ThreadSnapshot>((resolve) => {
          setTimeout(() => resolve({ ...fixture.thread }), 60);
        }),
    );
    fixture.discord.actorCanManage = vi.fn<ThreadLifecycleDiscord["actorCanManage"]>(
      () => new Promise<boolean>(() => undefined),
    );
    const startedAt = Date.now();

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      code: "ACTOR_PERMISSION_TIMEOUT",
    });

    expect(Date.now() - startedAt).toBeLessThan(150);
  });

  it("keeps a timed-out close mutation guarded until it settles", async () => {
    const fixture = createFixture({ deadlineMs: 250, mutationTimeoutMs: 20 });
    let completeArchive: (() => void) | undefined;
    let mutationSignal: AbortSignal | undefined;
    fixture.discord.archiveThread = vi
      .fn<ThreadLifecycleDiscord["archiveThread"]>()
      .mockImplementationOnce(
        (_guildId, _threadId, name, signal) =>
          new Promise<void>((resolve) => {
            mutationSignal = signal;
            completeArchive = () => {
              fixture.thread.name = name;
              fixture.thread.archived = true;
              resolve();
            };
          }),
      )
      .mockImplementation((_guildId, _threadId, name) => {
        fixture.thread.name = name;
        fixture.thread.archived = true;
        return Promise.resolve();
      });

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      code: "DISCORD_ARCHIVE_OUTCOME_UNKNOWN",
    });
    expect(fixture.audits).toEqual([]);
    expect(mutationSignal?.aborted).toBe(true);

    await expect(fixture.service.open(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      code: "DISCORD_MUTATION_PENDING",
    });
    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      code: "DISCORD_MUTATION_PENDING",
    });
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();

    completeArchive?.();
    await vi.waitFor(() => {
      expect(fixture.thread).toMatchObject({ name: "[CLOSED] Topic", archived: true });
      expect(fixture.state?.lifecycleState).toBe("CLOSED");
      expect(fixture.audits).toContainEqual(
        expect.objectContaining({ action: "CLOSE", outcome: "SUCCESS" }),
      );
    });

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: false,
    });
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();
    expect(fixture.state?.lifecycleState).toBe("CLOSED");
    expect(fixture.thread.archived).toBe(true);
  });

  it("reconciles a late close mutation with the prefix selected before timeout", async () => {
    const fixture = createFixture({ deadlineMs: 250, mutationTimeoutMs: 20 });
    let completeArchive: (() => void) | undefined;
    fixture.settings.closedPrefix = "[OLD]";
    fixture.discord.archiveThread = vi.fn<ThreadLifecycleDiscord["archiveThread"]>(
      (_guildId, _threadId, name) =>
        new Promise<void>((resolve) => {
          completeArchive = () => {
            fixture.thread.name = name;
            fixture.thread.archived = true;
            resolve();
          };
        }),
    );

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      code: "DISCORD_ARCHIVE_OUTCOME_UNKNOWN",
    });
    fixture.settings.closedPrefix = "[NEW]";

    completeArchive?.();
    await vi.waitFor(() => {
      expect(fixture.thread).toMatchObject({ name: "[OLD] Topic", archived: true });
      expect(fixture.state).toMatchObject({
        lifecycleState: "CLOSED",
        appliedPrefix: "[OLD]",
      });
      expect(fixture.audits).toContainEqual(
        expect.objectContaining({ action: "CLOSE", outcome: "SUCCESS" }),
      );
    });
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();
  });

  it("releases the guard after an aborted mutation request settles", async () => {
    const fixture = createFixture({ deadlineMs: 250, mutationTimeoutMs: 20 });
    let mutationSignal: AbortSignal | undefined;
    fixture.discord.archiveThread = vi
      .fn<ThreadLifecycleDiscord["archiveThread"]>()
      .mockImplementationOnce(
        (_guildId, _threadId, _name, signal) =>
          new Promise<void>((_resolve, reject) => {
            mutationSignal = signal;
            signal.addEventListener(
              "abort",
              () => {
                const error = new Error("Mutation aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          }),
      )
      .mockImplementation((_guildId, _threadId, name) => {
        fixture.thread.name = name;
        fixture.thread.archived = true;
        return Promise.resolve();
      });

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      code: "DISCORD_ARCHIVE_OUTCOME_UNKNOWN",
    });
    expect(mutationSignal?.aborted).toBe(true);
    await vi.waitFor(() =>
      expect(fixture.audits).toContainEqual(
        expect.objectContaining({
          action: "CLOSE",
          outcome: "FAILURE",
          failureCode: "DISCORD_ARCHIVE_FAILED",
        }),
      ),
    );
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: true,
    });
    expect(fixture.discord.archiveThread).toHaveBeenCalledTimes(2);
  });

  it("reconciles a late open rename into managed OPEN state", async () => {
    const fixture = createFixture({
      threadName: "[CLOSED] Topic",
      archived: false,
      deadlineMs: 250,
      mutationTimeoutMs: 20,
      state: createManagedState("CLOSED", "[CLOSED]"),
    });
    let completeRename: (() => void) | undefined;
    fixture.discord.renameThread = vi.fn<ThreadLifecycleDiscord["renameThread"]>(
      (_guildId, _threadId, name) =>
        new Promise<void>((resolve) => {
          completeRename = () => {
            fixture.thread.name = name;
            resolve();
          };
        }),
    );

    await expect(fixture.service.open(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      code: "DISCORD_RENAME_OUTCOME_UNKNOWN",
    });
    expect(fixture.state?.lifecycleState).toBe("CLOSED");

    completeRename?.();
    await vi.waitFor(() => {
      expect(fixture.thread.name).toBe("Topic");
      expect(fixture.state?.lifecycleState).toBe("OPEN");
      expect(fixture.audits).toContainEqual(
        expect.objectContaining({ action: "OPEN", outcome: "SUCCESS" }),
      );
    });
    expect(fixture.discord.renameThread).toHaveBeenCalledOnce();
  });

  it("does not let a pending mutation block another thread", async () => {
    const fixture = createFixture({ deadlineMs: 50 });
    const otherThreadId = "200000000000000002";
    let completeArchive: (() => void) | undefined;
    fixture.discord.archiveThread = vi.fn<ThreadLifecycleDiscord["archiveThread"]>(
      (_guildId, threadId, name) => {
        if (threadId !== THREAD_ID) {
          fixture.thread.name = name;
          fixture.thread.archived = true;
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          completeArchive = () => {
            fixture.thread.name = name;
            fixture.thread.archived = true;
            resolve();
          };
        });
      },
    );

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      code: "DISCORD_ARCHIVE_OUTCOME_UNKNOWN",
    });

    await expect(fixture.service.close(GUILD_ID, otherThreadId, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: true,
    });
    expect(fixture.discord.archiveThread).toHaveBeenCalledTimes(2);

    completeArchive?.();
    await vi.waitFor(() =>
      expect(fixture.audits).toContainEqual(
        expect.objectContaining({
          action: "CLOSE",
          threadId: THREAD_ID,
        }),
      ),
    );
  });

  it("reconciles a delayed managed-state write success", async () => {
    const fixture = createFixture({ deadlineMs: 50 });
    const saveClosed = fixture.managedThreads.saveClosed;
    let completeWrite: (() => void) | undefined;
    fixture.managedThreads.saveClosed = vi.fn<ManagedThreadStore["saveClosed"]>(
      (guildId, threadId, prefix) =>
        new Promise<ManagedThread>((resolve, reject) => {
          completeWrite = () => {
            void saveClosed(guildId, threadId, prefix).then(resolve, reject);
          };
        }),
    );

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      code: "STATE_WRITE_OUTCOME_UNKNOWN",
    });
    expect(fixture.audits).toEqual([]);
    completeWrite?.();
    await vi.waitFor(() => expect(fixture.state?.lifecycleState).toBe("CLOSED"));

    fixture.managedThreads.saveClosed = saveClosed;
    await expect(fixture.createService(250).close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: true,
    });
    expect(fixture.thread.name).toBe("[CLOSED] Topic");
    expect(fixture.thread.archived).toBe(true);
  });

  it("keeps a delayed archive success consistent and idempotent", async () => {
    const fixture = createFixture({ deadlineMs: 250, mutationTimeoutMs: 20 });
    let completeArchive: (() => void) | undefined;
    let mutationSignal: AbortSignal | undefined;
    fixture.discord.archiveThread = vi.fn<ThreadLifecycleDiscord["archiveThread"]>(
      (_guildId, _threadId, name, signal) =>
        new Promise<void>((resolve) => {
          mutationSignal = signal;
          completeArchive = () => {
            fixture.thread.name = name;
            fixture.thread.archived = true;
            resolve();
          };
        }),
    );

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      code: "DISCORD_ARCHIVE_OUTCOME_UNKNOWN",
    });
    expect(fixture.state?.lifecycleState).toBe("CLOSED");
    expect(fixture.audits).toEqual([]);
    expect(mutationSignal?.aborted).toBe(true);
    await expect(fixture.service.open(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      code: "DISCORD_MUTATION_PENDING",
    });
    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      code: "DISCORD_MUTATION_PENDING",
    });
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();

    completeArchive?.();
    await vi.waitFor(() => {
      expect(fixture.thread.archived).toBe(true);
      expect(fixture.audits).toContainEqual(
        expect.objectContaining({ action: "CLOSE", outcome: "SUCCESS" }),
      );
    });

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: false,
    });
    expect(fixture.thread.name).toBe("[CLOSED] Topic");
    expect(fixture.state?.lifecycleState).toBe("CLOSED");
  });

  it("does not record failure when a timed-out success audit completes late", async () => {
    const fixture = createFixture({ deadlineMs: 50 });
    const recordAudit = fixture.auditStore.record;
    let completeAudit: (() => void) | undefined;
    fixture.auditStore.record = vi.fn<ThreadAuditStore["record"]>(
      (audit) =>
        new Promise<void>((resolve, reject) => {
          completeAudit = () => {
            void recordAudit(audit).then(resolve, reject);
          };
        }),
    );

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      code: "AUDIT_WRITE_OUTCOME_UNKNOWN",
    });
    expect(fixture.audits).toEqual([]);
    completeAudit?.();
    await vi.waitFor(() => expect(fixture.audits).toHaveLength(1));
    expect(fixture.audits[0]).toMatchObject({ action: "CLOSE", outcome: "SUCCESS" });
    expect(fixture.audits).not.toEqual([expect.objectContaining({ outcome: "FAILURE" })]);
  });
});

const GUILD_ID = "100000000000000001";
const THREAD_ID = "200000000000000001";
const ACTOR_ID = "300000000000000001";

function createThreadInteraction(subcommand: "close" | "open"): {
  interaction: ChatInputCommandInteraction;
  reply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
} {
  const reply = vi.fn(() => Promise.resolve());
  const editReply = vi.fn(() => Promise.resolve());
  return {
    interaction: {
      guildId: GUILD_ID,
      channelId: THREAD_ID,
      inGuild: () => true,
      options: { getSubcommand: () => subcommand },
      user: { id: ACTOR_ID },
      deferred: false,
      replied: false,
      reply,
      editReply,
    } as unknown as ChatInputCommandInteraction,
    reply,
    editReply,
  };
}

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
  deadlineMs,
  mutationTimeoutMs,
  state,
}: {
  prefix?: string;
  threadName?: string;
  archived?: boolean;
  actorCanManage?: boolean;
  botCanManage?: boolean;
  locked?: boolean;
  deadlineMs?: number;
  mutationTimeoutMs?: number;
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
    archiveThread: vi.fn<ThreadLifecycleDiscord["archiveThread"]>((_guildId, _threadId, name) => {
      calls.push("archive");
      thread.name = name;
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
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const createService = (
    serviceDeadlineMs = deadlineMs,
    serviceMutationTimeoutMs = mutationTimeoutMs,
  ) =>
    createThreadLifecycleService({
      discord,
      guildSettings,
      managedThreads,
      audits: auditStore,
      logger,
      ...(serviceDeadlineMs === undefined ? {} : { deadlineMs: serviceDeadlineMs }),
      ...(serviceMutationTimeoutMs === undefined
        ? {}
        : { mutationTimeoutMs: serviceMutationTimeoutMs }),
    });
  const service = createService();

  return {
    service,
    calls,
    audits,
    thread,
    settings,
    discord,
    managedThreads,
    auditStore,
    guildSettings,
    logger,
    createService,
    get state() {
      return managedState;
    },
  };
}
