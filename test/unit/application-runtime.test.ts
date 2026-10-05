import { EventEmitter } from "node:events";
import { Events, ChannelType, PermissionFlagsBits as P } from "discord.js";
import {
  BULK_PREPARATION_FAILURE,
  BULK_PREPARATION_MS,
} from "../../src/bulk-thread-close-command.js";
import { registerDiscordCommandHandler } from "../../src/discord.js";
import type { CommandDependencies } from "../../src/commands.js";
import { ComponentType } from "discord.js";
import type { ModalSubmitInteraction } from "discord.js";
import type { Client } from "discord.js";
import {
  createLinkPreviewDiscord,
  registerLinkPreviewHandlers,
} from "../../src/link-preview-discord.js";
import { createLinkPreviewService } from "../../src/link-preview.js";
import type { LinkPreviewBoundary } from "../../src/link-preview.js";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBulkCloseService } from "../../src/bulk-thread-close.js";
import type { BulkThreadCloseHooks } from "../../src/thread-lifecycle.js";
import type { AuditRetentionStore } from "../../src/audit-retention-persistence.js";
import { createAuditRetentionRuntime } from "../../src/audit-retention-runtime.js";

import {
  createApplicationRuntime,
  type ApplicationRuntimeDependencies,
  SHUTDOWN_TIMEOUT_MS,
  ShutdownTimeoutError,
} from "../../src/application-runtime.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createFixture(overrides: Partial<ApplicationRuntimeDependencies> = {}) {
  const calls: string[] = [];
  const step = (name: string) =>
    vi.fn(() => {
      calls.push(name);
      return Promise.resolve();
    });
  const logger = {
    info: vi.fn((fields: { event?: string }) => calls.push(fields.event ?? "info")),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  const processControl = {
    setExitCode: vi.fn(),
    forceExit: vi.fn(),
    writeStderr: vi.fn(),
  };
  const dependencies: ApplicationRuntimeDependencies = {
    startHealthListener: step("health-listener"),
    quiesceHealth: vi.fn(() => calls.push("health-quiesce")),
    drainHealth: step("health-drain"),
    verifyDatabaseConnection: step("database"),
    startPgBoss: step("boss"),
    ensureScheduledThreadCloseQueue: step("thread-queue"),
    ensureScheduledMessageQueue: step("message-queue"),
    ensureRecurringMessageQueue: step("recurring-queue"),
    recoverScheduledThreadCloseDeliveries: step("thread-recovery"),
    recoverScheduledMessageDeliveries: step("message-recovery"),
    recoverRecurringMessageDeliveries: step("recurring-recovery"),
    startDiscord: step("discord-ready"),
    startScheduledThreadCloseWorkers: step("thread-workers"),
    startScheduledMessageWorker: step("message-workers"),
    startRecurringMessageWorker: step("recurring-workers"),
    startScheduledThreadCloseRuntimeReconciliation: step("thread-reconciler"),
    startScheduledMessageRuntimeReconciliation: step("message-reconciler"),
    startRecurringMessageRuntimeReconciliation: step("recurring-reconciler"),
    reconcileAutomaticCloseBaselines: step("automatic-baseline"),
    startAutomaticCloseRuntime: step("automatic-runtime"),
    startAuditRetentionRuntime: step("audit-retention-runtime"),
    quiesce: [],
    drainThreadLifecycle: step("thread-drain"),
    drainAuditNotifications: step("audit-drain"),
    stopPgBoss: vi.fn((remainingMs: number) => {
      calls.push(`boss-stop:${remainingMs}`);
      return Promise.resolve();
    }),
    destroyDiscord: step("discord-destroy"),
    closeDatabase: step("database-close"),
    logger,
    processControl,
    ...overrides,
  };
  return {
    runtime: createApplicationRuntime(dependencies),
    dependencies,
    calls,
    logger,
    processControl,
  };
}

afterEach(() => vi.useRealTimers());

describe("application runtime", () => {
  it("opens READY ingress only after the exact startup sequence", async () => {
    const fixture = createFixture();
    const service = vi.fn(() => Promise.resolve("accepted"));

    expect(fixture.runtime.ingress.run(service)).toBeUndefined();
    await fixture.runtime.start();
    await expect(fixture.runtime.ingress.run(service)).resolves.toBe("accepted");

    expect(fixture.runtime.getState()).toBe("READY");
    expect(fixture.calls).toEqual([
      "startup_started",
      "health-listener",
      "database",
      "boss",
      "thread-queue",
      "message-queue",
      "recurring-queue",
      "thread-recovery",
      "message-recovery",
      "recurring-recovery",
      "discord-ready",
      "thread-workers",
      "message-workers",
      "recurring-workers",
      "thread-reconciler",
      "message-reconciler",
      "recurring-reconciler",
      "automatic-baseline",
      "automatic-runtime",
      "audit-retention-runtime",
      "application_ready",
    ]);
  });

  it("reaches READY before initial retention backlog drains and closes the database afterward", async () => {
    const batch = deferred<number>();
    const persistence: AuditRetentionStore = {
      deleteExpiredBatch: vi.fn(() => batch.promise),
    };
    const retention = createAuditRetentionRuntime({
      persistence,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const closeDatabase = vi.fn(() => Promise.resolve());
    const fixture = createFixture({
      startAuditRetentionRuntime: () => retention.start(),
      quiesce: [{ name: "audit-retention-runtime", stop: () => retention.stop() }],
      closeDatabase,
    });
    await fixture.runtime.start();
    expect(fixture.runtime.getState()).toBe("READY");
    await vi.waitFor(() => expect(persistence.deleteExpiredBatch).toHaveBeenCalledOnce());
    const shutdown = fixture.runtime.shutdown("SIGTERM");
    await Promise.resolve();
    expect(closeDatabase).not.toHaveBeenCalled();
    batch.resolve(1);
    await shutdown;
    expect(persistence.deleteExpiredBatch).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it("closes ingress synchronously, quiesces every producer, then drains", async () => {
    const firstStop = deferred();
    const secondStop = deferred();
    const calls: string[] = [];
    const fixture = createFixture({
      quiesce: [
        {
          name: "first",
          stop: () => {
            calls.push("stop-first");
            return firstStop.promise;
          },
        },
        {
          name: "second",
          stop: () => {
            calls.push("stop-second");
            return secondStop.promise;
          },
        },
      ],
      drainThreadLifecycle: () => {
        calls.push("drain-thread");
        return Promise.resolve();
      },
    });
    await fixture.runtime.start();
    const shutdown = fixture.runtime.shutdown("SIGTERM");

    expect(fixture.runtime.getState()).toBe("SHUTTING_DOWN");
    expect(fixture.runtime.ingress.run(vi.fn())).toBeUndefined();
    expect(calls).toEqual(["stop-first", "stop-second"]);
    expect(fixture.dependencies.stopPgBoss).not.toHaveBeenCalled();

    firstStop.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["stop-first", "stop-second"]);
    secondStop.resolve();
    await vi.waitFor(() => expect(calls).toContain("drain-thread"));
    await shutdown;
    expect(fixture.runtime.getState()).toBe("STOPPED");
    expect(fixture.dependencies.stopPgBoss).toHaveBeenCalledOnce();
    expect(fixture.dependencies.destroyDiscord).toHaveBeenCalledOnce();
    expect(fixture.dependencies.closeDatabase).toHaveBeenCalledOnce();
  });

  it("does not tear down an active startup step or begin the next step", async () => {
    const database = deferred();
    const fixture = createFixture({ verifyDatabaseConnection: () => database.promise });
    const startup = fixture.runtime.start();
    await Promise.resolve();
    const shutdown = fixture.runtime.shutdown("SIGINT");

    expect(fixture.dependencies.startPgBoss).not.toHaveBeenCalled();
    expect(fixture.dependencies.destroyDiscord).not.toHaveBeenCalled();
    database.resolve();
    await Promise.all([startup, shutdown]);

    expect(fixture.dependencies.startPgBoss).not.toHaveBeenCalled();
    expect(fixture.dependencies.destroyDiscord).toHaveBeenCalledOnce();
  });

  it("tracks admitted handlers until settlement before closing Discord and PostgreSQL", async () => {
    const admitted = deferred();
    const fixture = createFixture();
    await fixture.runtime.start();
    const operation = fixture.runtime.ingress.run(() => admitted.promise);
    const shutdown = fixture.runtime.shutdown("SIGTERM");
    await Promise.resolve();

    expect(fixture.dependencies.destroyDiscord).not.toHaveBeenCalled();
    expect(fixture.dependencies.closeDatabase).not.toHaveBeenCalled();
    admitted.resolve();
    await operation;
    await shutdown;
    expect(fixture.dependencies.destroyDiscord).toHaveBeenCalledOnce();
    expect(fixture.dependencies.closeDatabase).toHaveBeenCalledOnce();
  });

  it("drains retained thread work created late by an already-admitted handler", async () => {
    const enterThreadLifecycle = deferred();
    const rawMutation = deferred();
    const finalization = deferred();
    let rawActive = false;
    let finalizationActive = false;
    let logicalOperation: Promise<void> | undefined;
    const drainThreadLifecycle = vi.fn(async () => {
      await logicalOperation;
    });
    const fixture = createFixture({ drainThreadLifecycle });
    await fixture.runtime.start();

    const handler = fixture.runtime.ingress.run(async () => {
      await enterThreadLifecycle.promise;
      rawActive = true;
      logicalOperation = rawMutation.promise
        .then(() => {
          rawActive = false;
          finalizationActive = true;
          return finalization.promise;
        })
        .then(() => {
          finalizationActive = false;
        });
      return { ok: false, pending: true } as const;
    });
    expect(logicalOperation).toBeUndefined();

    const shutdown = fixture.runtime.shutdown("SIGTERM");
    await Promise.resolve();
    expect(drainThreadLifecycle).not.toHaveBeenCalled();
    expect(fixture.dependencies.destroyDiscord).not.toHaveBeenCalled();
    expect(fixture.dependencies.closeDatabase).not.toHaveBeenCalled();

    enterThreadLifecycle.resolve();
    await expect(handler).resolves.toEqual({ ok: false, pending: true });
    await vi.waitFor(() => expect(drainThreadLifecycle).toHaveBeenCalledOnce());
    expect(rawActive).toBe(true);
    expect(fixture.dependencies.destroyDiscord).not.toHaveBeenCalled();
    expect(fixture.dependencies.closeDatabase).not.toHaveBeenCalled();

    rawMutation.resolve();
    await vi.waitFor(() => expect(finalizationActive).toBe(true));
    expect(fixture.dependencies.destroyDiscord).not.toHaveBeenCalled();
    expect(fixture.dependencies.closeDatabase).not.toHaveBeenCalled();

    finalization.resolve();
    await shutdown;
    expect(finalizationActive).toBe(false);
    expect(fixture.dependencies.destroyDiscord).toHaveBeenCalledOnce();
    expect(fixture.dependencies.closeDatabase).toHaveBeenCalledOnce();
  });

  it("keeps Discord and PostgreSQL available while retained thread-lifecycle work drains", async () => {
    const retained = deferred();
    const fixture = createFixture({ drainThreadLifecycle: () => retained.promise });
    await fixture.runtime.start();

    const shutdown = fixture.runtime.shutdown("SIGTERM");
    await Promise.resolve();
    expect(fixture.dependencies.stopPgBoss).not.toHaveBeenCalled();
    expect(fixture.dependencies.destroyDiscord).not.toHaveBeenCalled();
    expect(fixture.dependencies.closeDatabase).not.toHaveBeenCalled();

    retained.resolve();
    await shutdown;
    expect(fixture.dependencies.stopPgBoss).toHaveBeenCalledOnce();
    expect(fixture.dependencies.destroyDiscord).toHaveBeenCalledOnce();
    expect(fixture.dependencies.closeDatabase).toHaveBeenCalledOnce();
  });

  it("drains late accepted notification delivery after source and thread work, before Discord and DB close", async () => {
    const worker = deferred();
    const thread = deferred();
    const delivery = deferred();
    const calls: string[] = [];
    const fixture = createFixture({
      quiesce: [
        {
          name: "worker",
          stop: () => {
            calls.push("worker-stop");
            return worker.promise;
          },
        },
      ],
      drainThreadLifecycle: () => {
        calls.push("thread-drain");
        return thread.promise;
      },
      drainAuditNotifications: () => {
        calls.push("notification-drain");
        return delivery.promise;
      },
      destroyDiscord: () => {
        calls.push("discord-destroy");
      },
      closeDatabase: () => {
        calls.push("database-close");
        return Promise.resolve();
      },
    });
    await fixture.runtime.start();
    const shutdown = fixture.runtime.shutdown("SIGTERM");
    expect(calls).toEqual(["worker-stop"]);
    worker.resolve();
    await vi.waitFor(() => expect(calls).toContain("thread-drain"));
    expect(calls).not.toContain("notification-drain");
    thread.resolve();
    await vi.waitFor(() => expect(calls).toContain("notification-drain"));
    expect(calls).not.toContain("discord-destroy");
    expect(calls).not.toContain("database-close");
    delivery.resolve();
    await shutdown;
    expect(calls).toEqual([
      "worker-stop",
      "thread-drain",
      "notification-drain",
      "discord-destroy",
      "database-close",
    ]);
  });

  it("starts health quiescence synchronously but drains it after retained thread work", async () => {
    const retained = deferred();
    const health = deferred();
    const calls: string[] = [];
    const fixture = createFixture({
      quiesceHealth: () => {
        calls.push("health-quiesce");
      },
      drainThreadLifecycle: () => {
        calls.push("thread-drain");
        return retained.promise;
      },
      drainHealth: () => {
        calls.push("health-drain");
        return health.promise;
      },
      stopPgBoss: () => {
        calls.push("boss-stop");
        return Promise.resolve();
      },
      closeDatabase: () => {
        calls.push("database-close");
        return Promise.resolve();
      },
    });
    await fixture.runtime.start();
    const shutdown = fixture.runtime.shutdown("SIGTERM");
    expect(calls).toEqual(["health-quiesce"]);
    await vi.waitFor(() => expect(calls).toContain("thread-drain"));
    expect(calls).not.toContain("health-drain");
    retained.resolve();
    await vi.waitFor(() => expect(calls).toContain("health-drain"));
    expect(calls).not.toContain("boss-stop");
    health.resolve();
    await shutdown;
    expect(calls).toEqual([
      "health-quiesce",
      "thread-drain",
      "health-drain",
      "boss-stop",
      "database-close",
    ]);
  });

  it("uses only the existing shared deadline for notification drain", async () => {
    vi.useFakeTimers();
    const setTimer = vi.fn(setTimeout);
    const fixture = createFixture({
      drainAuditNotifications: () => new Promise<void>(() => undefined),
      setTimer,
    });
    await fixture.runtime.start();
    const shutdown = fixture.runtime.shutdown("SIGTERM");
    const timedOut = expect(shutdown).rejects.toBeInstanceOf(ShutdownTimeoutError);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
    await timedOut;
    expect(setTimer).toHaveBeenCalledOnce();
    expect(fixture.dependencies.destroyDiscord).not.toHaveBeenCalled();
    expect(fixture.dependencies.closeDatabase).not.toHaveBeenCalled();
  });

  it("uses the shared deadline when a physical health probe never drains", async () => {
    vi.useFakeTimers();
    const fixture = createFixture({ drainHealth: () => new Promise<void>(() => undefined) });
    await fixture.runtime.start();
    const shutdown = fixture.runtime.shutdown("SIGTERM");
    const assertion = expect(shutdown).rejects.toBeInstanceOf(ShutdownTimeoutError);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
    await assertion;
    expect(fixture.processControl.forceExit).toHaveBeenCalledWith(1);
    expect(fixture.dependencies.stopPgBoss).not.toHaveBeenCalled();
    expect(fixture.dependencies.closeDatabase).not.toHaveBeenCalled();
  });

  it("uses one 30-second deadline and forces a sanitized non-zero timeout", async () => {
    vi.useFakeTimers();
    const never = new Promise<void>(() => undefined);
    const fixture = createFixture({ quiesce: [{ name: "worker", stop: () => never }] });
    await fixture.runtime.start();
    const first = fixture.runtime.shutdown("SIGTERM");
    const second = fixture.runtime.shutdown("SIGINT");
    expect(second).toBe(first);
    const timedOut = expect(first).rejects.toBeInstanceOf(ShutdownTimeoutError);

    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
    await timedOut;
    expect(fixture.processControl.setExitCode).toHaveBeenCalledWith(1);
    expect(fixture.processControl.forceExit).toHaveBeenCalledWith(1);
    expect(fixture.logger.error).toHaveBeenCalledWith(
      { event: "shutdown_timed_out", shutdownReason: "SIGTERM" },
      expect.any(String),
    );
    expect(fixture.dependencies.destroyDiscord).not.toHaveBeenCalled();
  });

  it("keeps the startup failure primary when cleanup also fails", async () => {
    const primary = new TypeError("private startup detail");
    const fixture = createFixture({
      startPgBoss: () => Promise.reject(primary),
      closeDatabase: () => Promise.reject(new Error("private cleanup detail")),
    });

    await expect(fixture.runtime.start()).rejects.toBe(primary);
    expect(fixture.logger.error).toHaveBeenCalledWith(
      { event: "startup_step_failed", startupStep: "pg_boss_start", errorName: "TypeError" },
      expect.any(String),
    );
    expect(fixture.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "resource_cleanup_failed", resource: "database" }),
      expect.any(String),
    );
    expect(JSON.stringify(vi.mocked(fixture.logger.error).mock.calls)).not.toContain(
      "private startup detail",
    );
  });

  it("latches fatal events and forces exit on the second fatal", async () => {
    const never = new Promise<void>(() => undefined);
    const fixture = createFixture({ quiesce: [{ name: "worker", stop: () => never }] });
    await fixture.runtime.start();
    const first = fixture.runtime.handleFatal("unhandledRejection", new RangeError("secret"));

    expect(fixture.runtime.getState()).toBe("SHUTTING_DOWN");
    expect(fixture.processControl.setExitCode).toHaveBeenCalledWith(1);
    expect(fixture.logger.error).toHaveBeenCalledWith(
      { event: "fatal_runtime_failure", origin: "unhandledRejection", errorName: "RangeError" },
      expect.any(String),
    );
    await fixture.runtime.handleFatal("uncaughtException", new Error("second"));
    expect(fixture.processControl.forceExit).toHaveBeenCalledWith(1);
    void first.catch(() => undefined);
  });

  it("escalates a fatal event during normal shutdown without resetting the shared deadline", async () => {
    vi.useFakeTimers();
    const never = new Promise<void>(() => undefined);
    const fixture = createFixture({ quiesce: [{ name: "worker", stop: () => never }] });
    await fixture.runtime.start();
    const normal = fixture.runtime.shutdown("SIGTERM");
    const fatal = fixture.runtime.handleFatal("uncaughtException", new Error("private"));
    const normalTimeout = expect(normal).rejects.toBeInstanceOf(ShutdownTimeoutError);
    const fatalTimeout = expect(fatal).rejects.toBeInstanceOf(ShutdownTimeoutError);

    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
    await Promise.all([normalTimeout, fatalTimeout]);

    expect(fixture.processControl.setExitCode).toHaveBeenCalledWith(1);
    expect(fixture.processControl.forceExit).toHaveBeenCalledWith(1);
    expect(fixture.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "fatal_runtime_failure", origin: "uncaughtException" }),
      expect.any(String),
    );
    expect(fixture.logger.error).toHaveBeenCalledWith(
      { event: "shutdown_timed_out", shutdownReason: "SIGTERM" },
      expect.any(String),
    );
  });

  it("uses fixed stderr when fatal structured logging fails", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.logger.error).mockImplementation(() => {
      throw new Error("logger failed");
    });

    await fixture.runtime.handleFatal("uncaughtException", new Error("secret"));
    expect(fixture.processControl.writeStderr).toHaveBeenCalledWith(
      '{"event":"fatal_runtime_failure","logging":"failed"}\n',
    );
  });
});

describe("link preview ingress and shutdown ownership", () => {
  it.each(["state", "membership"] as const)(
    "drains the actual final source %s fetch and its send",
    async (stage) => {
      const f = createFixture();
      const gate = deferred();
      const sourceRoute = stage === "state" ? "/channels/14" : "/channels/14/thread-members/8";
      const sourceChannel = {
        id: "14",
        guild_id: "1",
        name: "source",
        type: stage === "membership" ? ChannelType.PrivateThread : ChannelType.PublicThread,
        parent_id: "16",
        thread_metadata: { archived: false, locked: false },
      };
      const data = new Map<string, unknown>([
        ["/channels/14", sourceChannel],
        [
          "/channels/16",
          {
            id: "16",
            guild_id: "1",
            name: "parent",
            type: ChannelType.GuildText,
            permission_overwrites: [],
          },
        ],
        ["/channels/14/thread-members/8", { id: "14", user_id: "8" }],
        ["/guilds/1", { id: "1", owner_id: "10" }],
        [
          "/guilds/1/roles",
          [
            {
              id: "1",
              permissions: (
                P.ViewChannel |
                P.ReadMessageHistory |
                P.EmbedLinks |
                P.SendMessagesInThreads
              ).toString(),
            },
          ],
        ],
        ["/guilds/1/members/8", { user: { id: "8" }, roles: [] }],
      ]);
      let stageReads = 0;
      const get = vi.fn(async (route: string) => {
        if (route === sourceRoute && ++stageReads === 2) await gate.promise;
        if (!data.has(route)) throw new Error("Unexpected request");
        return data.get(route);
      });
      const post = vi.fn(() => {
        expect(f.dependencies.destroyDiscord).not.toHaveBeenCalled();
        return Promise.resolve({});
      });
      const client = Object.assign(new EventEmitter(), {
        user: { id: "8" },
        application: { id: "11" },
        rest: { get, post },
      });
      const readMode = vi.fn(() => Promise.resolve("button-only" as const));
      registerLinkPreviewHandlers(
        client as unknown as Client,
        createLinkPreviewService({
          readMode,
          discord: createLinkPreviewDiscord(client as unknown as Client),
          log: vi.fn(),
        }),
        { debug: vi.fn() },
        f.runtime.ingress,
      );
      const message = {
        inGuild: () => true,
        author: { id: "9", bot: false },
        webhookId: null,
        system: false,
        type: 0,
        guildId: "1",
        channelId: "14",
        id: "15",
        content: "https://discord.com/channels/1/2/3",
        channel: { type: sourceChannel.type },
      };
      await f.runtime.start();
      client.emit(Events.MessageCreate, message);
      await vi.waitFor(() => expect(stageReads).toBe(2));
      expect(post).not.toHaveBeenCalled();
      const shutdown = f.runtime.shutdown("test");
      client.emit(Events.MessageCreate, message);
      expect(readMode).toHaveBeenCalledOnce();
      expect(f.dependencies.destroyDiscord).not.toHaveBeenCalled();
      expect(f.dependencies.closeDatabase).not.toHaveBeenCalled();
      gate.resolve();
      await shutdown;
      expect(post).toHaveBeenCalledOnce();
      expect(get.mock.calls.filter(([route]) => route === sourceRoute)).toHaveLength(2);
      expect(
        get.mock.calls.filter(([route]) => route === "/channels/14/thread-members/8"),
      ).toHaveLength(stage === "membership" ? 2 : 0);
      expect(f.dependencies.destroyDiscord).toHaveBeenCalledOnce();
      expect(f.dependencies.closeDatabase).toHaveBeenCalledOnce();
    },
  );
  it.each(["fetch", "send", "mixed", "edit"] as const)(
    "owns a slow %s and rejects work outside READY",
    async (stage) => {
      const f = createFixture();
      const gate = deferred();
      const client = Object.assign(new EventEmitter(), {
        user: { id: "8" },
        application: { id: "11" },
      });
      const message = {
        inGuild: () => true,
        author: { id: "9", bot: false },
        webhookId: null,
        system: false,
        type: 0,
        guildId: "1",
        channelId: "4",
        id: "5",
        content:
          "https://discord.com/channels/1/2/3" +
          (stage === "mixed" ? " https://discord.com/channels/1/2/6" : ""),
        channel: { type: ChannelType.GuildText },
      };
      const value = {
        author: "author",
        content: "text",
        timestamp: "2026-01-01T00:00:00Z",
        attachments: [],
        forwarded: false,
      };
      const fetchMessage = vi.fn(async () => {
        if (stage === "fetch") await gate.promise;
        return value;
      });
      const send = vi.fn<LinkPreviewBoundary["send"]>(async () => {
        if (stage === "send" || stage === "mixed") await gate.promise;
      });
      const readMode = vi.fn(() => Promise.resolve("hybrid" as const));
      const authorize = vi.fn(() => Promise.resolve({ location: "#source" }));
      const service = createLinkPreviewService({
        readMode,
        discord: {
          sourceSendable: () => Promise.resolve(true),
          classify: (targets) =>
            Promise.resolve(
              targets.map((target) =>
                target.messageId === "6"
                  ? { state: "RESTRICTED" as const }
                  : { state: "PUBLIC" as const, location: "#source" },
              ),
            ),
          authorize,
          fetchMessage,
          send,
        },
        log: vi.fn(),
      });
      const deferReply = vi.fn(() => Promise.resolve());
      const editReply = vi.fn(() => (stage === "edit" ? gate.promise : Promise.resolve()));
      const button = {
        isButton: () => true,
        customId: "lp:1:1:2:3",
        inGuild: () => true,
        guildId: "1",
        applicationId: "11",
        client,
        user: { id: "9" },
        message: { author: { id: "8" }, webhookId: null },
        deferReply,
        editReply,
      };
      registerLinkPreviewHandlers(
        client as unknown as Client,
        service,
        { debug: vi.fn() },
        f.runtime.ingress,
      );
      const emit = () => {
        if (stage === "edit") client.emit(Events.InteractionCreate, button);
        else client.emit(Events.MessageCreate, message);
      };
      emit();
      expect(readMode).not.toHaveBeenCalled();
      expect(deferReply).not.toHaveBeenCalled();
      await f.runtime.start();
      emit();
      const pending = stage === "fetch" ? fetchMessage : stage === "edit" ? editReply : send;
      await vi.waitFor(() => expect(pending).toHaveBeenCalledOnce());
      if (stage === "mixed") {
        expect(send.mock.calls[0]![1].embeds).toHaveLength(1);
        expect(send.mock.calls[0]![1].helpers).toEqual([
          { target: { guildId: "1", channelId: "2", messageId: "6" }, ordinal: 2 },
        ]);
      }
      const shutdown = f.runtime.shutdown("test");
      emit();
      expect(readMode).toHaveBeenCalledOnce();
      expect(f.dependencies.destroyDiscord).not.toHaveBeenCalled();
      expect(f.dependencies.closeDatabase).not.toHaveBeenCalled();
      gate.resolve();
      await shutdown;
      expect(f.dependencies.closeDatabase).toHaveBeenCalledOnce();
      emit();
      expect(readMode).toHaveBeenCalledOnce();
      if (stage === "edit") expect(deferReply).toHaveBeenCalledOnce();
    },
  );
});

describe("bulk work under existing application shutdown ownership", () => {
  const parent = { id: "2", guildId: "1", type: ChannelType.GuildText, name: "Parent" };
  const threads = ["10", "11", "12", "13"].map((threadId) => ({
    guildId: "1",
    threadId,
    type: ChannelType.PublicThread as const,
    parentId: "2",
    name: "Topic",
    archived: false,
    locked: false,
    ownerId: "9",
    createdTimestamp: 0,
  }));
  it("quiesces capacity admission, drains admitted orchestration, then logical work before dependencies close", async () => {
    const logical = deferred();
    const hooks: BulkThreadCloseHooks[] = [];
    const f = createFixture({ drainThreadLifecycle: vi.fn(() => logical.promise) });
    const closeManually = vi.fn(
      (_g: string, _t: string, _a: string, bulk?: BulkThreadCloseHooks) => {
        hooks.push(bulk!);
        bulk!.onAttemptStarted();
        return Promise.resolve({
          outcome: "LIFECYCLE",
          result: { ok: false, pending: true },
        } as const);
      },
    );
    const service = createBulkCloseService({
      discord: {
        discover: () => Promise.resolve({ parent, threads }),
        observe: () => Promise.resolve({ parent, threads }),
      },
      manualClose: { closeManually },
      isReady: () => f.runtime.getState() === "READY",
    });
    f.dependencies.quiesce = [{ name: "bulk-close", stop: () => service.stop() }];
    expect(await service.preview("1", "2", "9", { ownerId: "9" })).toMatchObject({ ok: false });
    await f.runtime.start();
    const preview = await service.preview("1", "2", "9", { ownerId: "9" });
    if (!preview.ok) throw new Error(preview.reason);
    service.bind(preview.session, "100");
    const admitted = f.runtime.ingress.run(async () => {
      const confirmation = await service.confirm(preview.session.id, {
        guildId: "1",
        actorId: "9",
        messageId: "100",
      });
      return confirmation!.result;
    })!;
    await vi.waitFor(() => expect(closeManually).toHaveBeenCalledTimes(3));
    const shutdown = f.runtime.shutdown("test");
    expect(await admitted).toMatchObject({ attempted: 3, pending: 3, skipped: 1 });
    await vi.waitFor(() => expect(f.dependencies.drainThreadLifecycle).toHaveBeenCalledOnce());
    expect(f.dependencies.destroyDiscord).not.toHaveBeenCalled();
    expect(f.dependencies.closeDatabase).not.toHaveBeenCalled();
    expect(
      f.runtime.ingress.run(() => service.preview("1", "2", "9", { ownerId: "9" })),
    ).toBeUndefined();
    for (const bulk of hooks) bulk.onLogicalSettled();
    logical.resolve();
    await shutdown;
    expect(f.dependencies.closeDatabase).toHaveBeenCalledOnce();
    expect(closeManually).toHaveBeenCalledTimes(3);
  });
  it("retains raw acknowledged preview-message writes inside source drain", async () => {
    const write = deferred();
    const f = createFixture();
    const service = createBulkCloseService({
      discord: {
        discover: () => Promise.resolve({ parent, threads }),
        observe: () => Promise.resolve({ parent, threads }),
      },
      manualClose: { closeManually: vi.fn() },
      isReady: () => f.runtime.getState() === "READY",
    });
    f.dependencies.quiesce = [{ name: "bulk-close", stop: () => service.stop() }];
    await f.runtime.start();
    const preview = await service.preview("1", "2", "9", { ownerId: "9" });
    if (!preview.ok) throw new Error(preview.reason);
    const publish = vi.fn(() => write.promise);
    const admitted = f.runtime.ingress.run(() => service.updatePreview(preview.session, publish));
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const shutdown = f.runtime.shutdown("test");
    await Promise.resolve();
    expect(f.dependencies.drainThreadLifecycle).not.toHaveBeenCalled();
    expect(f.dependencies.closeDatabase).not.toHaveBeenCalled();
    write.resolve();
    await admitted;
    await shutdown;
    expect(f.dependencies.drainThreadLifecycle).toHaveBeenCalledOnce();
  });
});

it("drains raw Modal observation after the bounded user failure and rejects new ingress during shutdown", async () => {
  vi.useFakeTimers();
  const f = createFixture();
  const gate = deferred<{
    parent: { id: string; guildId: string; type: ChannelType; name: string };
    threads: typeof threads;
  }>();
  const parent = { id: "2", guildId: "1", type: ChannelType.GuildText, name: "Parent" };
  const threads = [
    {
      guildId: "1",
      threadId: "10",
      type: ChannelType.PublicThread as const,
      parentId: "2",
      name: "Topic",
      archived: false,
      locked: false,
      ownerId: "9",
      createdTimestamp: 0,
    },
  ];
  const closeManually = vi.fn();
  const service = createBulkCloseService({
    discord: { discover: () => Promise.resolve({ parent, threads }), observe: () => gate.promise },
    manualClose: { closeManually },
    isReady: () => f.runtime.getState() === "READY",
  });
  f.dependencies.quiesce = [{ name: "bulk-close", stop: () => service.stop() }];
  const editReply = vi.fn((options: unknown) => {
    void options;
    return Promise.resolve({ id: "100" });
  });
  const deferReply = vi.fn(() => Promise.resolve());
  const client = new EventEmitter() as unknown as Client;
  const admitted: Promise<unknown>[] = [];
  registerDiscordCommandHandler(
    client,
    {
      bulkClose: service,
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as CommandDependencies,
    {
      run: (operation) => {
        const result = f.runtime.ingress.run(operation);
        if (result) admitted.push(result);
        return result;
      },
    },
  );
  await f.runtime.start();
  const ticket = service.createSetup("1", "9")!;
  const modal = {
    isChatInputCommand: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => true,
    customId: `btc:${ticket}:setup`,
    guildId: "1",
    user: { id: "9" },
    deferReply,
    editReply,
    fields: {
      getField: (key: string) => ({
        type: key === "parent" ? ComponentType.ChannelSelect : ComponentType.UserSelect,
        values: key === "parent" ? ["2"] : [],
      }),
      getTextInputValue: (key: string) => (key === "name" ? "Topic" : ""),
    },
  } as unknown as ModalSubmitInteraction;
  client.emit(Events.InteractionCreate, modal);
  await vi.advanceTimersByTimeAsync(0);
  expect(editReply.mock.calls.at(-1)?.[0]).toMatchObject({
    content: "Preparing bulk-close preview…",
  });
  let sourceDone = false;
  const source = admitted[0]!.then(() => {
    sourceDone = true;
  });
  await vi.advanceTimersByTimeAsync(BULK_PREPARATION_MS);
  expect(editReply.mock.calls.at(-1)?.[0]).toMatchObject({ content: BULK_PREPARATION_FAILURE });
  expect(sourceDone).toBe(false);
  const shutdown = f.runtime.shutdown("test");
  await vi.advanceTimersByTimeAsync(0);
  client.emit(Events.InteractionCreate, modal);
  expect(deferReply).toHaveBeenCalledOnce();
  expect(f.dependencies.destroyDiscord).not.toHaveBeenCalled();
  expect(f.dependencies.closeDatabase).not.toHaveBeenCalled();
  gate.resolve({ parent, threads });
  await source;
  await shutdown;
  expect(sourceDone).toBe(true);
  expect(f.dependencies.closeDatabase).toHaveBeenCalledOnce();
  expect(closeManually).not.toHaveBeenCalled();
  expect(editReply.mock.calls.at(-1)?.[0]).toMatchObject({ content: BULK_PREPARATION_FAILURE });
});
