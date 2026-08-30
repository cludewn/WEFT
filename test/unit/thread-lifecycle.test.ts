import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { ChatInputCommandInteraction } from "discord.js";

import type { AutomaticCloseThreadMaintenanceService } from "../../src/automatic-close-thread-maintenance.js";
import type { GuildSettings, GuildSettingsStore } from "../../src/guild-settings.js";
import type { ScheduledThreadCloseCommandService } from "../../src/scheduled-thread-close-command.js";
import { handleThreadCommand } from "../../src/thread-command.js";
import {
  addClosedPrefix,
  createThreadLifecycleService,
  DEFAULT_DISCORD_MUTATION_WAIT_MS,
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

const scheduledThreadCloseCommandStub = {
  schedule: vi.fn(),
} as unknown as ScheduledThreadCloseCommandService;
const automaticCloseMaintenanceStub = {} as AutomaticCloseThreadMaintenanceService;

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
    expect(DEFAULT_DISCORD_MUTATION_WAIT_MS).toBe(5_000);
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
      "state-closed:[CLOSED]",
      "audit:CLOSE:SUCCESS",
    ]);
    expect(fixture.thread.locked).toBe(false);
    expect(fixture.state?.lifecycleState).toBe("CLOSED");
  });

  it("runs manual-close preparation after initial validation and before state or Discord effects", async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID, () => {
        fixture.calls.push("prepare");
        return Promise.resolve();
      }),
    ).resolves.toEqual({ ok: true, changed: true });

    expect(fixture.calls.slice(0, 5)).toEqual([
      "fetch",
      "actor-permission",
      "bot-permission",
      "prepare",
      "settings",
    ]);
    expect(fixture.calls.indexOf("prepare")).toBeLessThan(
      fixture.calls.indexOf("state-closed:[CLOSED]"),
    );
    expect(fixture.calls.indexOf("prepare")).toBeLessThan(fixture.calls.indexOf("archive"));
  });

  it.each([
    ["unsupported", { supported: false }],
    ["locked", { locked: true }],
    ["actor denied", { actorCanManage: false }],
    ["bot denied", { botCanManage: false }],
  ] as const)("does not prepare an invalid manual close: %s", async (_name, options) => {
    const fixture = createFixture(options);
    const prepare = vi.fn(() => Promise.resolve());

    await fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID, prepare);

    expect(prepare).not.toHaveBeenCalled();
  });

  it("propagates a stopped preparation without state, Discord mutation, or lifecycle audit", async () => {
    const fixture = createFixture();
    const stop = new Error("opaque preparation stop");

    await expect(
      fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID, () => Promise.reject(stop)),
    ).rejects.toBe(stop);

    expect(fixture.managedThreads.saveClosed).not.toHaveBeenCalled();
    expect(fixture.discord.archiveThread).not.toHaveBeenCalled();
    expect(fixture.auditStore.record).not.toHaveBeenCalled();
  });

  it("does not run preparation while a same-thread Discord mutation guard is pending", async () => {
    const fixture = createFixture({ mutationWaitMs: 5 });
    const mutation = deferred<void>();
    fixture.discord.archiveThread = vi.fn(() => mutation.promise);

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });
    const prepare = vi.fn(() => Promise.resolve());
    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID, prepare)).resolves.toEqual({
      ok: false,
      pending: true,
    });
    expect(prepare).not.toHaveBeenCalled();

    mutation.resolve(undefined);
    await vi.waitFor(() => expect(fixture.auditStore.record).toHaveBeenCalledOnce());
  });

  it("treats a mutation resolved within caller wait as confirmed without reconciliation fetch", async () => {
    const fixture = createFixture({ mutationWaitMs: 50 });

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: true,
    });

    expect(fixture.discord.fetchThread).toHaveBeenCalledTimes(3);
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();
    expect(fixture.audits).toEqual([
      expect.objectContaining({ action: "CLOSE", outcome: "SUCCESS" }),
    ]);
    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: false,
    });
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();
  });

  it("keeps the guard through foreground finalization and releases it only after the audit settles", async () => {
    const fixture = createFixture({ deadlineMs: 50, mutationWaitMs: 20 });
    const recordAudit = fixture.auditStore.record;
    const auditSettlement = deferred<void>();
    fixture.auditStore.record = vi.fn<ThreadAuditStore["record"]>((audit) =>
      auditSettlement.promise.then(() => recordAudit(audit)),
    );

    const close = fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID);
    await vi.waitFor(() => expect(fixture.auditStore.record).toHaveBeenCalledOnce());
    const overlappingOpen = fixture.service.open(GUILD_ID, THREAD_ID, ACTOR_ID);

    await expect(close).resolves.toEqual({ ok: false, pending: true });
    await expect(overlappingOpen).resolves.toEqual({ ok: false, pending: true });
    expect(fixture.audits).toEqual([]);
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();

    auditSettlement.resolve(undefined);
    await vi.waitFor(() => expect(fixture.audits).toHaveLength(1));
    fixture.auditStore.record = recordAudit;
    await vi.waitFor(async () =>
      expect(await fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).toEqual({
        ok: true,
        changed: false,
      }),
    );
  });

  it("retries foreground final audit with one stable ID and payload after response loss", async () => {
    const fixture = createFixture({ deadlineMs: 250, reconciliationRetryBaseMs: 5 });
    const recordAudit = fixture.auditStore.record;
    let loseFirstResponse = true;
    fixture.auditStore.record = vi.fn<ThreadAuditStore["record"]>(async (audit) => {
      await recordAudit(audit);
      if (loseFirstResponse) {
        loseFirstResponse = false;
        throw new Error("audit response lost");
      }
    });

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: true,
    });

    expect(fixture.auditStore.record).toHaveBeenCalledTimes(2);
    const firstAudit = vi.mocked(fixture.auditStore.record).mock.calls[0]?.[0];
    const secondAudit = vi.mocked(fixture.auditStore.record).mock.calls[1]?.[0];
    expect(firstAudit).toEqual(secondAudit);
    expect(firstAudit?.id).toEqual(expect.any(String));
    expect(fixture.audits).toEqual([
      expect.objectContaining({ action: "CLOSE", outcome: "SUCCESS" }),
    ]);
    expect(fixture.audits).not.toContainEqual(expect.objectContaining({ outcome: "FAILURE" }));
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

  it("classifies fetch and state failures without reporting success", async () => {
    const cases = [
      { method: "fetchThread", code: "DISCORD_FETCH_FAILED" },
      { method: "saveClosed", code: "STATE_WRITE_FAILED" },
    ] as const;

    for (const testCase of cases) {
      const fixture = createFixture();
      if (testCase.method === "saveClosed") {
        fixture.managedThreads.saveClosed = vi.fn(() => Promise.reject(new Error("opaque")));
      } else if (testCase.method === "fetchThread") {
        fixture.discord.fetchThread = vi.fn(() => Promise.reject(new Error("opaque")));
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

  it("keeps confirmed mutation success pending while final audit retry is unavailable", async () => {
    const fixture = createFixture({ deadlineMs: 50 });
    fixture.auditStore.record = vi.fn<ThreadAuditStore["record"]>(() =>
      Promise.reject(new Error("opaque")),
    );

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });
    expect(fixture.audits).toEqual([]);
    await expect(fixture.service.open(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      pending: true,
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
      pending: true,
    });
    await vi.waitFor(() =>
      expect(fixture.audits).toContainEqual(
        expect.objectContaining({
          action: "CLOSE",
          outcome: "FAILURE",
          failureCode: "DISCORD_ARCHIVE_FAILED",
        }),
      ),
    );
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

    await vi.waitFor(async () =>
      expect(await fixture.service.open(GUILD_ID, THREAD_ID, ACTOR_ID)).toEqual({
        ok: true,
        changed: true,
      }),
    );

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
    await handleThreadCommand(
      command.interaction,
      fixture.service,
      scheduledThreadCloseCommandStub,
      automaticCloseMaintenanceStub,
      fixture.logger,
      250,
    );

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
      scheduledThreadCloseCommandStub,
      automaticCloseMaintenanceStub,
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
    const scheduledThreadClose = {
      ...scheduledThreadCloseCommandStub,
      closeManually: async (guildId: string, threadId: string, actorId: string) => ({
        outcome: "LIFECYCLE" as const,
        result: await fixture.service.close(guildId, threadId, actorId),
      }),
    };
    const firstClose = createThreadInteraction("close");

    await handleThreadCommand(
      firstClose.interaction,
      fixture.service,
      scheduledThreadClose,
      automaticCloseMaintenanceStub,
      fixture.logger,
      50,
    );
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
    await handleThreadCommand(
      secondClose.interaction,
      fixture.service,
      scheduledThreadClose,
      automaticCloseMaintenanceStub,
      fixture.logger,
      50,
    );
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
    expect(new Set(fixture.audits.map((audit) => audit.id)).size).toBe(3);
  });

  it("records active Discord state as OPEN after automatic open rename failure", async () => {
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
      pending: true,
    });
    await vi.waitFor(() =>
      expect(fixture.audits).toContainEqual(
        expect.objectContaining({
          action: "AUTO_OPEN",
          outcome: "FAILURE",
          failureCode: "DISCORD_RENAME_FAILED",
        }),
      ),
    );
    expect(fixture.state?.lifecycleState).toBe("OPEN");

    await vi.waitFor(async () =>
      expect(await fixture.service.open(GUILD_ID, THREAD_ID, ACTOR_ID)).toEqual({
        ok: true,
        changed: true,
      }),
    );
    expect(fixture.state?.lifecycleState).toBe("OPEN");
  });

  it("keeps open finalization guarded until the managed state retry succeeds", async () => {
    const fixture = createFixture({
      threadName: "[CLOSED] Topic",
      archived: false,
      deadlineMs: 50,
      state: createManagedState("CLOSED", "[CLOSED]"),
    });
    const markOpen = fixture.managedThreads.markOpen;
    let allowStateWrite = false;
    fixture.managedThreads.markOpen = vi.fn<ManagedThreadStore["markOpen"]>((guildId, threadId) =>
      allowStateWrite
        ? markOpen(guildId, threadId)
        : Promise.reject(new Error("temporary state write failure")),
    );

    await expect(fixture.service.autoOpen(GUILD_ID, THREAD_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });
    expect(fixture.state?.lifecycleState).toBe("CLOSED");
    expect(fixture.audits).toEqual([]);
    allowStateWrite = true;
    await vi.waitFor(() => expect(fixture.state?.lifecycleState).toBe("OPEN"));
    await vi.waitFor(() =>
      expect(fixture.audits).toEqual([
        expect.objectContaining({ action: "AUTO_OPEN", outcome: "SUCCESS" }),
      ]),
    );
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
    expect(fixture.managedThreads.markOpen).toHaveBeenCalledOnce();
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

  it("returns pending without aborting a mutation and guards it until settlement", async () => {
    const fixture = createFixture({ deadlineMs: 250, mutationWaitMs: 20 });
    let completeArchive: (() => void) | undefined;
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

    const initialClose = fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID);
    await vi.waitFor(() => expect(fixture.discord.archiveThread).toHaveBeenCalledOnce());
    const queuedOpen = fixture.service.open(GUILD_ID, THREAD_ID, ACTOR_ID);
    const queuedClose = fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID);

    await expect(initialClose).resolves.toEqual({
      ok: false,
      pending: true,
    });
    expect(fixture.audits).toEqual([]);

    for (const operation of [queuedOpen, queuedClose]) {
      await expect(operation).resolves.toEqual({ ok: false, pending: true });
    }
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();

    completeArchive?.();
    await vi.waitFor(() =>
      expect(fixture.audits).toEqual([
        expect.objectContaining({ action: "CLOSE", outcome: "SUCCESS" }),
      ]),
    );
    expect(fixture.discord.fetchThread).toHaveBeenCalledTimes(3);
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();
    expect(fixture.thread).toMatchObject({ name: "[CLOSED] Topic", archived: true });
    expect(fixture.state?.lifecycleState).toBe("CLOSED");

    await vi.waitFor(async () =>
      expect(await fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).toEqual({
        ok: true,
        changed: false,
      }),
    );
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();
  });

  it("reconciles a late close with the prefix selected before caller wait expires", async () => {
    const fixture = createFixture({ deadlineMs: 250, mutationWaitMs: 20 });
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
      pending: true,
    });
    fixture.settings.closedPrefix = "[NEW]";
    completeArchive?.();

    await vi.waitFor(() =>
      expect(fixture.audits).toEqual([
        expect.objectContaining({ action: "CLOSE", outcome: "SUCCESS" }),
      ]),
    );
    expect(fixture.thread).toMatchObject({ name: "[OLD] Topic", archived: true });
    expect(fixture.state).toMatchObject({ lifecycleState: "CLOSED", appliedPrefix: "[OLD]" });
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();
  });

  it("replays a pending autoOpen intent after close finalization and removes stale managed CLOSED state", async () => {
    const fixture = createFixture({ deadlineMs: 50, mutationWaitMs: 20 });
    const recordAudit = fixture.auditStore.record;
    const closeAudit = deferred<void>();
    fixture.auditStore.record = vi.fn<ThreadAuditStore["record"]>((audit) =>
      audit.action === "CLOSE"
        ? closeAudit.promise.then(() => recordAudit(audit))
        : recordAudit(audit),
    );

    const close = fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID);
    await vi.waitFor(() => expect(fixture.auditStore.record).toHaveBeenCalledOnce());
    fixture.thread.archived = false;
    await expect(fixture.service.autoOpen(GUILD_ID, THREAD_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });
    await expect(close).resolves.toEqual({ ok: false, pending: true });
    expect(fixture.state?.lifecycleState).toBe("CLOSED");

    closeAudit.resolve(undefined);
    await vi.waitFor(() => expect(fixture.state?.lifecycleState).toBe("OPEN"));
    await vi.waitFor(() =>
      expect(fixture.audits).toEqual([
        expect.objectContaining({ action: "CLOSE", outcome: "SUCCESS" }),
        expect.objectContaining({ action: "AUTO_OPEN", outcome: "SUCCESS" }),
      ]),
    );
    expect(fixture.thread).toMatchObject({ name: "Topic", archived: false });
    expect(fixture.discord.renameThread).toHaveBeenCalledOnce();
  });

  it("reconciles a rejected mutation that Discord did not apply", async () => {
    const fixture = createFixture({ deadlineMs: 250, mutationWaitMs: 20 });
    fixture.discord.archiveThread = vi
      .fn<ThreadLifecycleDiscord["archiveThread"]>()
      .mockRejectedValueOnce(new Error("opaque transport failure"))
      .mockImplementation((_guildId, _threadId, name) => {
        fixture.thread.name = name;
        fixture.thread.archived = true;
        return Promise.resolve();
      });

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });
    await vi.waitFor(() =>
      expect(fixture.audits).toEqual([
        expect.objectContaining({
          action: "CLOSE",
          outcome: "FAILURE",
          failureCode: "DISCORD_ARCHIVE_FAILED",
        }),
      ]),
    );
    expect(fixture.discord.fetchThread).toHaveBeenCalledTimes(4);
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();
    expect(fixture.state?.lifecycleState).toBe("OPEN");

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: true,
    });
    expect(fixture.discord.archiveThread).toHaveBeenCalledTimes(2);
  });

  it("reconciles a rejected mutation as success when Discord shows it was applied", async () => {
    const fixture = createFixture({ deadlineMs: 250, mutationWaitMs: 20 });
    fixture.discord.archiveThread = vi.fn<ThreadLifecycleDiscord["archiveThread"]>(
      (_guildId, _threadId, name) => {
        fixture.thread.name = name;
        fixture.thread.archived = true;
        return Promise.reject(new Error("response was lost"));
      },
    );

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });
    await vi.waitFor(() =>
      expect(fixture.audits).toEqual([
        expect.objectContaining({ action: "CLOSE", outcome: "SUCCESS" }),
      ]),
    );
    expect(fixture.thread).toMatchObject({ name: "[CLOSED] Topic", archived: true });
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();
  });

  it("keeps a late raw rejection pending until reconciliation confirms failure", async () => {
    const fixture = createFixture({ deadlineMs: 250, mutationWaitMs: 20 });
    let rejectArchive: (() => void) | undefined;
    fixture.discord.archiveThread = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectArchive = () => reject(new Error("late transport failure"));
        }),
    );

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });
    expect(fixture.audits).toEqual([]);
    rejectArchive?.();

    await vi.waitFor(() =>
      expect(fixture.audits).toEqual([
        expect.objectContaining({
          action: "CLOSE",
          outcome: "FAILURE",
          failureCode: "DISCORD_ARCHIVE_FAILED",
        }),
      ]),
    );
    expect(fixture.state?.lifecycleState).toBe("OPEN");
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();
  });

  it("keeps a reconciliation fetch single-flight while it is pending and continues after late resolve", async () => {
    const fixture = createFixture({ deadlineMs: 50, mutationWaitMs: 20 });
    const fetchThread = fixture.discord.fetchThread;
    const reconciliationFetch = deferred<ThreadSnapshot | undefined>();
    let fetchCount = 0;
    fixture.discord.fetchThread = vi.fn<ThreadLifecycleDiscord["fetchThread"]>(
      (guildId, threadId) => {
        fetchCount += 1;
        return fetchCount === 4 ? reconciliationFetch.promise : fetchThread(guildId, threadId);
      },
    );
    fixture.discord.archiveThread = vi.fn(() => Promise.reject(new Error("transport failure")));

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });
    await vi.waitFor(() => expect(fixture.discord.fetchThread).toHaveBeenCalledTimes(4));
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(fixture.discord.fetchThread).toHaveBeenCalledTimes(4);
    expect(fixture.audits).toEqual([]);
    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });

    reconciliationFetch.resolve({ ...fixture.thread });
    await vi.waitFor(() =>
      expect(fixture.audits).toEqual([
        expect.objectContaining({ action: "CLOSE", outcome: "FAILURE" }),
      ]),
    );
    expect(fixture.state?.lifecycleState).toBe("OPEN");
    expect(fixture.discord.actorCanManage).toHaveBeenCalledTimes(3);
    expect(fixture.discord.botCanManage).toHaveBeenCalledTimes(3);
  });

  it("starts a reconciliation fetch retry only after the pending raw fetch rejects", async () => {
    const fixture = createFixture({
      deadlineMs: 50,
      mutationWaitMs: 20,
      reconciliationRetryBaseMs: 200,
      reconciliationRetryMaxMs: 200,
    });
    const fetchThread = fixture.discord.fetchThread;
    const reconciliationFetch = deferred<ThreadSnapshot | undefined>();
    let fetchCount = 0;
    fixture.discord.fetchThread = vi.fn<ThreadLifecycleDiscord["fetchThread"]>(
      (guildId, threadId) => {
        fetchCount += 1;
        return fetchCount === 4 ? reconciliationFetch.promise : fetchThread(guildId, threadId);
      },
    );
    fixture.discord.archiveThread = vi.fn(() => Promise.reject(new Error("transport failure")));

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });
    await vi.waitFor(() => expect(fixture.discord.fetchThread).toHaveBeenCalledTimes(4));
    expect(fixture.logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "thread_lifecycle_reconciliation_retry_scheduled" }),
      expect.any(String),
    );

    reconciliationFetch.reject(new Error("late fetch rejection"));
    await vi.waitFor(() =>
      expect(fixture.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "thread_lifecycle_reconciliation_retry_scheduled",
          boundary: "thread_fetch",
          retryAttempt: 1,
        }),
        "Thread lifecycle reconciliation will be retried",
      ),
    );
    expect(fixture.discord.fetchThread).toHaveBeenCalledTimes(4);
    await vi.waitFor(() => expect(fixture.discord.fetchThread).toHaveBeenCalledTimes(5), {
      timeout: 500,
    });
    await vi.waitFor(() => expect(fixture.audits).toHaveLength(1));
  });

  it("does not start another managed state write while foreground finalization write is pending", async () => {
    const fixture = createFixture({ deadlineMs: 50, mutationWaitMs: 20 });
    const saveClosed = fixture.managedThreads.saveClosed;
    const finalStateWrite = deferred<ManagedThread>();
    let stateWriteCalls = 0;
    fixture.managedThreads.saveClosed = vi.fn<ManagedThreadStore["saveClosed"]>(
      (guildId, threadId, prefix) => {
        stateWriteCalls += 1;
        return stateWriteCalls === 2
          ? finalStateWrite.promise
          : saveClosed(guildId, threadId, prefix);
      },
    );

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(fixture.managedThreads.saveClosed).toHaveBeenCalledTimes(2);
    expect(fixture.audits).toEqual([]);
    await expect(fixture.service.open(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });

    const finalizedState = await saveClosed(GUILD_ID, THREAD_ID, "[CLOSED]");
    finalStateWrite.resolve(finalizedState);
    await vi.waitFor(() => expect(fixture.audits).toHaveLength(1));
    expect(fixture.state?.lifecycleState).toBe("CLOSED");
    expect(fixture.managedThreads.saveClosed).toHaveBeenCalledTimes(2);
  });

  it("does not start another final audit while the raw audit write is pending", async () => {
    const fixture = createFixture({ deadlineMs: 50, mutationWaitMs: 20 });
    const recordAudit = fixture.auditStore.record;
    const auditWrite = deferred<void>();
    fixture.auditStore.record = vi.fn<ThreadAuditStore["record"]>((audit) =>
      auditWrite.promise.then(() => recordAudit(audit)),
    );

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(fixture.auditStore.record).toHaveBeenCalledOnce();
    expect(fixture.audits).toEqual([]);

    auditWrite.resolve(undefined);
    await vi.waitFor(() => expect(fixture.audits).toHaveLength(1));
    expect(fixture.auditStore.record).toHaveBeenCalledOnce();
  });

  it("retries a rejected mutation reconciliation after a transient fetch failure", async () => {
    const fixture = createFixture({
      deadlineMs: 250,
      mutationWaitMs: 20,
      reconciliationRetryBaseMs: 200,
      reconciliationRetryMaxMs: 200,
    });
    const fetchThread = fixture.discord.fetchThread;
    let fetchCount = 0;
    fixture.discord.fetchThread = vi.fn<ThreadLifecycleDiscord["fetchThread"]>(
      (guildId, threadId) => {
        fetchCount += 1;
        if (fetchCount === 4) {
          return Promise.reject(new Error("temporary fetch failure"));
        }
        return fetchThread(guildId, threadId);
      },
    );
    fixture.discord.archiveThread = vi.fn<ThreadLifecycleDiscord["archiveThread"]>(
      (_guildId, threadId, name) => {
        if (threadId === THREAD_ID) {
          return Promise.reject(new Error("transport failure"));
        }
        fixture.thread.name = name;
        fixture.thread.archived = true;
        return Promise.resolve();
      },
    );

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });
    await vi.waitFor(() =>
      expect(fixture.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "thread_lifecycle_reconciliation_retry_scheduled",
          retryAttempt: 1,
        }),
        "Thread lifecycle reconciliation will be retried",
      ),
    );
    expect(fixture.state?.lifecycleState).toBe("CLOSED");
    expect(fixture.audits).toEqual([]);

    const otherThreadId = "200000000000000002";
    await expect(fixture.service.close(GUILD_ID, otherThreadId, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: true,
    });
    fixture.thread.name = "Topic";
    fixture.thread.archived = false;

    await expect(fixture.service.open(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });
    expect(
      vi.mocked(fixture.discord.archiveThread).mock.calls.filter((call) => call[1] === THREAD_ID),
    ).toHaveLength(1);

    await vi.waitFor(
      () =>
        expect(fixture.audits).toContainEqual(
          expect.objectContaining({
            action: "CLOSE",
            outcome: "FAILURE",
            failureCode: "DISCORD_ARCHIVE_FAILED",
          }),
        ),
      { timeout: 1_000 },
    );
    expect(fixture.state?.lifecycleState).toBe("OPEN");
    expect(
      vi.mocked(fixture.discord.archiveThread).mock.calls.filter((call) => call[1] === THREAD_ID),
    ).toHaveLength(1);
  });

  it("retains the guard across a transient reconciliation state-write failure without rechecking permission", async () => {
    const fixture = createFixture({
      deadlineMs: 250,
      mutationWaitMs: 20,
      reconciliationRetryBaseMs: 200,
      reconciliationRetryMaxMs: 200,
    });
    const markOpen = fixture.managedThreads.markOpen;
    fixture.managedThreads.markOpen = vi
      .fn<ManagedThreadStore["markOpen"]>()
      .mockRejectedValueOnce(new Error("temporary state write failure"))
      .mockImplementation(markOpen);
    fixture.discord.archiveThread = vi.fn<ThreadLifecycleDiscord["archiveThread"]>(() =>
      Promise.reject(new Error("transport failure")),
    );

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });
    await vi.waitFor(() =>
      expect(fixture.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ boundary: "managed_state_write", retryAttempt: 1 }),
        "Thread lifecycle reconciliation will be retried",
      ),
    );
    expect(fixture.discord.actorCanManage).toHaveBeenCalledTimes(3);
    expect(fixture.discord.botCanManage).toHaveBeenCalledTimes(3);
    expect(fixture.audits).toEqual([]);
    expect(fixture.state?.lifecycleState).toBe("CLOSED");
    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();

    await vi.waitFor(
      () =>
        expect(fixture.audits).toEqual([
          expect.objectContaining({ action: "CLOSE", outcome: "FAILURE" }),
        ]),
      { timeout: 1_000 },
    );
    expect(fixture.state?.lifecycleState).toBe("OPEN");
  });

  it("retries reconciliation to success when Discord applied a rejected mutation", async () => {
    const fixture = createFixture({
      deadlineMs: 250,
      mutationWaitMs: 20,
      reconciliationRetryBaseMs: 20,
      reconciliationRetryMaxMs: 20,
    });
    const fetchThread = fixture.discord.fetchThread;
    let fetchCount = 0;
    fixture.discord.fetchThread = vi.fn<ThreadLifecycleDiscord["fetchThread"]>(
      (guildId, threadId) => {
        fetchCount += 1;
        if (fetchCount === 4) {
          return Promise.reject(new Error("temporary fetch failure"));
        }
        return fetchThread(guildId, threadId);
      },
    );
    fixture.discord.archiveThread = vi.fn<ThreadLifecycleDiscord["archiveThread"]>(
      (_guildId, _threadId, name) => {
        fixture.thread.name = name;
        fixture.thread.archived = true;
        return Promise.reject(new Error("response lost"));
      },
    );

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });
    expect(fixture.audits).toEqual([]);

    await vi.waitFor(
      () =>
        expect(fixture.audits).toEqual([
          expect.objectContaining({ action: "CLOSE", outcome: "SUCCESS" }),
        ]),
      { timeout: 500 },
    );
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();
    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: false,
    });
  });

  it("deduplicates the final audit when its first reconciliation response is lost", async () => {
    const fixture = createFixture({
      deadlineMs: 250,
      mutationWaitMs: 20,
      reconciliationRetryBaseMs: 20,
      reconciliationRetryMaxMs: 20,
    });
    const recordAudit = fixture.auditStore.record;
    let rejectFirstResponse = true;
    fixture.auditStore.record = vi.fn<ThreadAuditStore["record"]>(async (audit) => {
      await recordAudit(audit);
      if (rejectFirstResponse) {
        rejectFirstResponse = false;
        throw new Error("audit response lost");
      }
    });
    fixture.discord.archiveThread = vi.fn<ThreadLifecycleDiscord["archiveThread"]>(
      (_guildId, _threadId, name) => {
        fixture.thread.name = name;
        fixture.thread.archived = true;
        return Promise.reject(new Error("mutation response lost"));
      },
    );

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });
    await vi.waitFor(
      () =>
        expect(fixture.logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ retryAttempt: 1 }),
          "Thread lifecycle reconciliation will be retried",
        ),
      { timeout: 500 },
    );
    expect(fixture.audits).toHaveLength(1);
    await vi.waitFor(() => expect(fixture.auditStore.record).toHaveBeenCalledTimes(2), {
      timeout: 500,
    });
    expect(fixture.audits).toEqual([
      expect.objectContaining({ action: "CLOSE", outcome: "SUCCESS" }),
    ]);
    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: false,
    });
  });

  it("does not infer managed state or audit while reconciliation cannot confirm Discord", async () => {
    const fixture = createFixture({
      deadlineMs: 250,
      mutationWaitMs: 20,
      reconciliationRetryBaseMs: 20,
      reconciliationRetryMaxMs: 20,
    });
    const fetchThread = fixture.discord.fetchThread;
    let rejectReconciliationFetch = true;
    let fetchCount = 0;
    fixture.discord.fetchThread = vi.fn<ThreadLifecycleDiscord["fetchThread"]>(
      (guildId, threadId) => {
        fetchCount += 1;
        if (fetchCount > 3 && rejectReconciliationFetch) {
          return Promise.reject(new Error("Discord unavailable"));
        }
        return fetchThread(guildId, threadId);
      },
    );
    fixture.discord.archiveThread = vi.fn<ThreadLifecycleDiscord["archiveThread"]>(() =>
      Promise.reject(new Error("transport failure")),
    );

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });
    await vi.waitFor(
      () =>
        expect(vi.mocked(fixture.discord.fetchThread).mock.calls.length).toBeGreaterThanOrEqual(5),
      { timeout: 500 },
    );
    expect(fixture.state?.lifecycleState).toBe("CLOSED");
    expect(fixture.audits).toEqual([]);
    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();

    rejectReconciliationFetch = false;
    await vi.waitFor(
      () =>
        expect(fixture.audits).toEqual([
          expect.objectContaining({ action: "CLOSE", outcome: "FAILURE" }),
        ]),
      { timeout: 500 },
    );
    expect(fixture.state?.lifecycleState).toBe("OPEN");
  });

  it("caps retry delay without stopping retries or releasing the guard", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createFixture({
        deadlineMs: 50,
        mutationWaitMs: 20,
        reconciliationRetryBaseMs: 40,
        reconciliationRetryMaxMs: 60,
      });
      const fetchThread = fixture.discord.fetchThread;
      let fetchCount = 0;
      let allowFetch = false;
      fixture.discord.fetchThread = vi.fn<ThreadLifecycleDiscord["fetchThread"]>(
        (guildId, threadId) => {
          fetchCount += 1;
          if (fetchCount > 3 && !allowFetch) {
            return Promise.reject(new Error("temporary fetch failure"));
          }
          return fetchThread(guildId, threadId);
        },
      );
      fixture.discord.archiveThread = vi.fn(() => Promise.reject(new Error("transport failure")));

      await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
        ok: false,
        pending: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.discord.fetchThread).toHaveBeenCalledTimes(4);

      await vi.advanceTimersByTimeAsync(40);
      expect(fixture.discord.fetchThread).toHaveBeenCalledTimes(5);
      await vi.advanceTimersByTimeAsync(60);
      expect(fixture.discord.fetchThread).toHaveBeenCalledTimes(6);
      expect(fixture.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ retryAttempt: 3, retryDelayMs: 60 }),
        "Thread lifecycle reconciliation will be retried",
      );
      await expect(fixture.service.open(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
        ok: false,
        pending: true,
      });

      allowFetch = true;
      await vi.advanceTimersByTimeAsync(60);
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.discord.fetchThread).toHaveBeenCalledTimes(7);
      expect(fixture.audits).toHaveLength(1);
      expect(fixture.state?.lifecycleState).toBe("OPEN");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles a late open rename into managed OPEN state", async () => {
    const fixture = createFixture({
      threadName: "[CLOSED] Topic",
      archived: false,
      deadlineMs: 250,
      mutationWaitMs: 20,
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
      pending: true,
    });
    expect(fixture.state?.lifecycleState).toBe("CLOSED");
    completeRename?.();

    await vi.waitFor(() =>
      expect(fixture.audits).toEqual([
        expect.objectContaining({ action: "OPEN", outcome: "SUCCESS" }),
      ]),
    );
    expect(fixture.thread.name).toBe("Topic");
    expect(fixture.state?.lifecycleState).toBe("OPEN");
    expect(fixture.discord.renameThread).toHaveBeenCalledOnce();
  });

  it("does not let a pending mutation block another thread", async () => {
    const fixture = createFixture({ deadlineMs: 50, mutationWaitMs: 20 });
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
      pending: true,
    });
    await expect(fixture.service.close(GUILD_ID, otherThreadId, ACTOR_ID)).resolves.toEqual({
      ok: true,
      changed: true,
    });
    expect(fixture.discord.archiveThread).toHaveBeenCalledTimes(2);

    completeArchive?.();
    await vi.waitFor(() =>
      expect(fixture.audits).toContainEqual(
        expect.objectContaining({ action: "CLOSE", threadId: THREAD_ID }),
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
      pending: true,
    });
    expect(fixture.audits).toEqual([]);
    completeAudit?.();
    await vi.waitFor(() => expect(fixture.audits).toHaveLength(1));
    expect(fixture.audits[0]).toMatchObject({ action: "CLOSE", outcome: "SUCCESS" });
    expect(fixture.audits).not.toEqual([expect.objectContaining({ outcome: "FAILURE" })]);
    fixture.auditStore.record = recordAudit;
    await vi.waitFor(async () =>
      expect(await fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).toEqual({
        ok: true,
        changed: false,
      }),
    );
  });

  it("waits for SYSTEM close mutation finalization without checking actor permission", async () => {
    const fixture = createFixture({ deadlineMs: 50, mutationWaitMs: 5 });
    const archive = deferred<void>();
    fixture.discord.archiveThread = vi.fn<ThreadLifecycleDiscord["archiveThread"]>(
      (_guildId, _threadId, name) =>
        archive.promise.then(() => {
          fixture.thread.name = name;
          fixture.thread.archived = true;
        }),
    );

    let settled = false;
    const execution = fixture.service
      .closeAsSystem(GUILD_ID, THREAD_ID, "scheduled-attempt-id")
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(fixture.discord.archiveThread).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(settled).toBe(false);
    expect(fixture.discord.actorCanManage).not.toHaveBeenCalled();
    expect(fixture.discord.botCanManage).toHaveBeenCalled();

    archive.resolve();
    await expect(execution).resolves.toEqual({ outcome: "SUCCESS", changed: true });
    expect(fixture.audits).toEqual([
      expect.objectContaining({
        id: "scheduled-attempt-id",
        action: "CLOSE",
        actorType: "SYSTEM",
        outcome: "SUCCESS",
      }),
    ]);
  });

  it("requires bot permission for a SYSTEM close", async () => {
    const fixture = createFixture({ botCanManage: false });

    await expect(
      fixture.service.closeAsSystem(GUILD_ID, THREAD_ID, "missing-bot-permission"),
    ).resolves.toEqual({
      outcome: "PERMANENT_FAILURE",
      code: "BOT_PERMISSION_MISSING",
    });
    expect(fixture.discord.actorCanManage).not.toHaveBeenCalled();
    expect(fixture.discord.archiveThread).not.toHaveBeenCalled();
    expect(fixture.audits).toEqual([
      expect.objectContaining({
        id: "missing-bot-permission",
        actorType: "SYSTEM",
        outcome: "FAILURE",
        failureCode: "BOT_PERMISSION_MISSING",
      }),
    ]);
  });

  it("keeps the pre-mutation lifecycle deadline for a SYSTEM close", async () => {
    const fixture = createFixture({ deadlineMs: 20 });
    fixture.discord.fetchThread = vi.fn(() => new Promise<never>(() => undefined));

    await expect(
      fixture.service.closeAsSystem(GUILD_ID, THREAD_ID, "system-fetch-timeout"),
    ).resolves.toEqual({
      outcome: "RETRYABLE_FAILURE",
      code: "DISCORD_FETCH_TIMEOUT",
    });
    expect(fixture.discord.archiveThread).not.toHaveBeenCalled();
    expect(fixture.audits).toEqual([
      expect.objectContaining({
        id: "system-fetch-timeout",
        actorType: "SYSTEM",
        outcome: "FAILURE",
        failureCode: "DISCORD_FETCH_TIMEOUT",
      }),
    ]);
  });

  it("waits for an existing pending mutation before starting a SYSTEM close", async () => {
    const fixture = createFixture({ deadlineMs: 50, mutationWaitMs: 5 });
    const archive = deferred<void>();
    fixture.discord.archiveThread = vi.fn<ThreadLifecycleDiscord["archiveThread"]>(
      (_guildId, _threadId, name) =>
        archive.promise.then(() => {
          fixture.thread.name = name;
          fixture.thread.archived = true;
        }),
    );

    await expect(fixture.service.close(GUILD_ID, THREAD_ID, ACTOR_ID)).resolves.toEqual({
      ok: false,
      pending: true,
    });
    let systemSettled = false;
    const systemClose = fixture.service
      .closeAsSystem(GUILD_ID, THREAD_ID, "system-after-pending")
      .finally(() => {
        systemSettled = true;
      });
    await Promise.resolve();
    expect(systemSettled).toBe(false);
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();

    archive.resolve();
    await expect(systemClose).resolves.toEqual({ outcome: "SUCCESS", changed: false });
    expect(fixture.discord.archiveThread).toHaveBeenCalledOnce();
    expect(fixture.audits).toContainEqual(
      expect.objectContaining({ id: "system-after-pending", actorType: "SYSTEM" }),
    );
  });

  it("reconciles a rejected SYSTEM mutation that Discord applied as success", async () => {
    const fixture = createFixture();
    fixture.discord.archiveThread = vi.fn<ThreadLifecycleDiscord["archiveThread"]>(
      (_guildId, _threadId, name) => {
        fixture.thread.name = name;
        fixture.thread.archived = true;
        return Promise.reject(new Error("response lost"));
      },
    );

    await expect(
      fixture.service.closeAsSystem(GUILD_ID, THREAD_ID, "applied-rejection"),
    ).resolves.toEqual({ outcome: "SUCCESS", changed: true });
    expect(fixture.audits).toEqual([
      expect.objectContaining({
        id: "applied-rejection",
        actorType: "SYSTEM",
        outcome: "SUCCESS",
      }),
    ]);
  });

  it("classifies a rejected SYSTEM mutation that was not applied", async () => {
    const fixture = createFixture();
    fixture.discord.classifyMutationFailure = vi.fn(() => "PERMANENT" as const);
    fixture.discord.archiveThread = vi.fn<ThreadLifecycleDiscord["archiveThread"]>(() =>
      Promise.reject(new Error("definitive rejection")),
    );

    await expect(
      fixture.service.closeAsSystem(GUILD_ID, THREAD_ID, "not-applied-rejection"),
    ).resolves.toEqual({
      outcome: "PERMANENT_FAILURE",
      code: "DISCORD_ARCHIVE_FAILED",
    });
    expect(fixture.state?.lifecycleState).toBe("OPEN");
    expect(fixture.audits).toEqual([
      expect.objectContaining({
        id: "not-applied-rejection",
        actorType: "SYSTEM",
        outcome: "FAILURE",
        failureCode: "DISCORD_ARCHIVE_FAILED",
      }),
    ]);
  });
});

describe("pending Discord mutation guard", () => {
  it("does not lose a release before or after a waiter is registered", async () => {
    const guard = new PendingDiscordMutationGuard();
    const firstGeneration = guard.track(GUILD_ID, THREAD_ID, Promise.resolve());
    const waiting = guard.waitForRelease(GUILD_ID, THREAD_ID);
    guard.release(GUILD_ID, THREAD_ID, firstGeneration);
    await expect(waiting).resolves.toBe(true);

    const secondGeneration = guard.track(GUILD_ID, THREAD_ID, Promise.resolve());
    guard.release(GUILD_ID, THREAD_ID, secondGeneration);
    await expect(guard.waitForRelease(GUILD_ID, THREAD_ID)).resolves.toBe(false);
  });
});

const GUILD_ID = "100000000000000001";
const THREAD_ID = "200000000000000001";
const ACTOR_ID = "300000000000000001";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error),
  };
}

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
  supported = true,
  locked = false,
  deadlineMs,
  mutationWaitMs,
  reconciliationRetryBaseMs = 5,
  reconciliationRetryMaxMs = 20,
  state,
}: {
  prefix?: string;
  threadName?: string;
  archived?: boolean;
  actorCanManage?: boolean;
  botCanManage?: boolean;
  supported?: boolean;
  locked?: boolean;
  deadlineMs?: number;
  mutationWaitMs?: number;
  reconciliationRetryBaseMs?: number;
  reconciliationRetryMaxMs?: number;
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
    autoCloseInactivitySeconds: 604_800,
    autoCloseBotMessagesCountAsActivity: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
  const discord: ThreadLifecycleDiscord = {
    fetchThread: vi.fn<ThreadLifecycleDiscord["fetchThread"]>(() => {
      calls.push("fetch");
      return Promise.resolve(supported ? { ...thread } : undefined);
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
    classifyMutationFailure: vi.fn(() => "RETRYABLE" as const),
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
      const existing = audits.find((record) => record.id === audit.id);
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(audit)) {
          return Promise.reject(new Error("Conflicting audit payload"));
        }
        return Promise.resolve();
      }
      calls.push(`audit:${audit.action}:${audit.outcome}`);
      audits.push(audit);
      return Promise.resolve();
    }),
  };
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const createService = (serviceDeadlineMs = deadlineMs, serviceMutationWaitMs = mutationWaitMs) =>
    createThreadLifecycleService({
      discord,
      guildSettings,
      managedThreads,
      audits: auditStore,
      logger,
      ...(serviceDeadlineMs === undefined ? {} : { deadlineMs: serviceDeadlineMs }),
      ...(serviceMutationWaitMs === undefined ? {} : { mutationWaitMs: serviceMutationWaitMs }),
      reconciliationRetryBaseMs,
      reconciliationRetryMaxMs,
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
