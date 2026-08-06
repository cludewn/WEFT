import type { ChannelType } from "discord.js";

import type { GuildSettingsStore } from "./guild-settings.js";
import type {
  ManagedThread,
  ManagedThreadStore,
  ThreadAuditAction,
  ThreadAuditStore,
} from "./thread-persistence.js";

export const DISCORD_THREAD_NAME_LIMIT = 100;

export const THREAD_FAILURE_CODES = [
  "UNSUPPORTED_CONTEXT",
  "THREAD_NOT_ACTIVE",
  "THREAD_LOCKED",
  "ACTOR_PERMISSION_MISSING",
  "BOT_PERMISSION_MISSING",
  "INVALID_THREAD_NAME",
  "DISCORD_FETCH_FAILED",
  "DISCORD_RENAME_FAILED",
  "DISCORD_ARCHIVE_FAILED",
  "SETTINGS_READ_FAILED",
  "STATE_READ_FAILED",
  "STATE_WRITE_FAILED",
  "AUDIT_WRITE_FAILED",
] as const;
export type ThreadFailureCode = (typeof THREAD_FAILURE_CODES)[number];

export type SupportedThreadType =
  ChannelType.AnnouncementThread | ChannelType.PublicThread | ChannelType.PrivateThread;

export type ThreadSnapshot = {
  guildId: string;
  threadId: string;
  type: SupportedThreadType;
  name: string;
  archived: boolean;
  locked: boolean;
};

export type ThreadLifecycleDiscord = {
  fetchThread: (guildId: string, threadId: string) => Promise<ThreadSnapshot | undefined>;
  actorCanManage: (guildId: string, threadId: string, actorId: string) => Promise<boolean>;
  botCanManage: (guildId: string, threadId: string) => Promise<boolean>;
  renameThread: (guildId: string, threadId: string, name: string) => Promise<void>;
  archiveThread: (guildId: string, threadId: string) => Promise<void>;
};

export type ThreadLifecycleResult =
  { ok: true; changed: boolean } | { ok: false; code: ThreadFailureCode };

export class InvalidThreadNameError extends Error {
  constructor() {
    super("The closed prefix leaves no room for a thread title");
    this.name = "InvalidThreadNameError";
  }
}

export class BotThreadPermissionError extends Error {
  constructor() {
    super("WEFT lacks a required thread permission");
    this.name = "BotThreadPermissionError";
  }
}

export function addClosedPrefix(title: string, prefix: string): string {
  const marker = `${prefix} `;
  if (title.startsWith(marker)) {
    return title;
  }

  const markerLength = [...marker].length;
  const remainingLength = DISCORD_THREAD_NAME_LIMIT - markerLength;
  if (remainingLength < 1) {
    throw new InvalidThreadNameError();
  }

  const truncatedTitle = [...title].slice(0, remainingLength).join("");
  if (truncatedTitle.length === 0) {
    throw new InvalidThreadNameError();
  }
  return `${marker}${truncatedTitle}`;
}

export function removeClosedPrefix(title: string, prefix: string): string {
  const marker = `${prefix} `;
  if (!title.startsWith(marker)) {
    return title;
  }

  const openedTitle = title.slice(marker.length);
  if ([...openedTitle].length === 0) {
    throw new InvalidThreadNameError();
  }
  return openedTitle;
}

type LifecycleDependencies = {
  discord: ThreadLifecycleDiscord;
  guildSettings: GuildSettingsStore;
  managedThreads: ManagedThreadStore;
  audits: ThreadAuditStore;
};

type Actor = { type: "USER"; id: string } | { type: "SYSTEM" };

export type ThreadLifecycleService = {
  close: (guildId: string, threadId: string, actorId: string) => Promise<ThreadLifecycleResult>;
  open: (guildId: string, threadId: string, actorId: string) => Promise<ThreadLifecycleResult>;
  autoOpen: (guildId: string, threadId: string) => Promise<ThreadLifecycleResult>;
};

class LifecycleFailure extends Error {
  constructor(readonly code: ThreadFailureCode) {
    super(code);
    this.name = "LifecycleFailure";
  }
}

export function createThreadLifecycleService(
  dependencies: LifecycleDependencies,
): ThreadLifecycleService {
  const { discord, guildSettings, managedThreads, audits } = dependencies;

  async function audit(
    guildId: string,
    threadId: string,
    action: ThreadAuditAction,
    actor: Actor,
    outcome: "SUCCESS" | "FAILURE",
    failureCode?: ThreadFailureCode,
  ): Promise<void> {
    await audits.record({
      guildId,
      threadId,
      action,
      actorType: actor.type,
      ...(actor.type === "USER" ? { actorId: actor.id } : {}),
      outcome,
      ...(failureCode === undefined ? {} : { failureCode }),
    });
  }

  async function fail(
    guildId: string,
    threadId: string,
    action: ThreadAuditAction,
    actor: Actor,
    error: unknown,
    fallback: ThreadFailureCode,
  ): Promise<ThreadLifecycleResult> {
    const code =
      error instanceof LifecycleFailure
        ? error.code
        : error instanceof BotThreadPermissionError
          ? "BOT_PERMISSION_MISSING"
          : error instanceof InvalidThreadNameError
            ? "INVALID_THREAD_NAME"
            : fallback;
    try {
      await audit(guildId, threadId, action, actor, "FAILURE", code);
    } catch {
      return { ok: false, code: "AUDIT_WRITE_FAILED" };
    }
    return { ok: false, code };
  }

  async function fetchSupported(guildId: string, threadId: string): Promise<ThreadSnapshot> {
    const thread = await discord.fetchThread(guildId, threadId);
    if (thread === undefined) {
      throw new LifecycleFailure("UNSUPPORTED_CONTEXT");
    }
    return thread;
  }

  async function requirePermissions(
    guildId: string,
    threadId: string,
    actorId?: string,
  ): Promise<void> {
    if (actorId !== undefined && !(await discord.actorCanManage(guildId, threadId, actorId))) {
      throw new LifecycleFailure("ACTOR_PERMISSION_MISSING");
    }
    if (!(await discord.botCanManage(guildId, threadId))) {
      throw new LifecycleFailure("BOT_PERMISSION_MISSING");
    }
  }

  async function close(
    guildId: string,
    threadId: string,
    actorId: string,
  ): Promise<ThreadLifecycleResult> {
    const actor: Actor = { type: "USER", id: actorId };
    let fallback: ThreadFailureCode = "DISCORD_FETCH_FAILED";
    try {
      const initial = await fetchSupported(guildId, threadId);
      if (initial.locked) {
        throw new LifecycleFailure("THREAD_LOCKED");
      }
      await requirePermissions(guildId, threadId, actorId);

      fallback = "SETTINGS_READ_FAILED";
      const settings = await guildSettings.getOrCreate(guildId);
      fallback = "STATE_READ_FAILED";
      const existing = await managedThreads.find(guildId, threadId);
      const appliedPrefix =
        existing?.lifecycleState === "CLOSED" ? existing.appliedPrefix : settings.closedPrefix;

      fallback = "DISCORD_FETCH_FAILED";
      const beforeRename = await fetchSupported(guildId, threadId);
      if (beforeRename.locked) {
        throw new LifecycleFailure("THREAD_LOCKED");
      }
      await requirePermissions(guildId, threadId, actorId);
      let changed = existing?.lifecycleState !== "CLOSED";
      const closedName = addClosedPrefix(beforeRename.name, appliedPrefix);
      if (closedName !== beforeRename.name) {
        fallback = "DISCORD_RENAME_FAILED";
        await discord.renameThread(guildId, threadId, closedName);
        changed = true;
      }

      fallback = "STATE_WRITE_FAILED";
      await managedThreads.saveClosed(guildId, threadId, appliedPrefix);

      fallback = "DISCORD_FETCH_FAILED";
      const beforeArchive = await fetchSupported(guildId, threadId);
      if (beforeArchive.locked) {
        throw new LifecycleFailure("THREAD_LOCKED");
      }
      await requirePermissions(guildId, threadId, actorId);
      if (!beforeArchive.archived) {
        fallback = "DISCORD_ARCHIVE_FAILED";
        await discord.archiveThread(guildId, threadId);
        changed = true;
      }

      fallback = "AUDIT_WRITE_FAILED";
      await audit(guildId, threadId, "CLOSE", actor, "SUCCESS");
      return { ok: true, changed };
    } catch (error) {
      return fail(guildId, threadId, "CLOSE", actor, error, fallback);
    }
  }

  async function reconcileOpen(
    guildId: string,
    threadId: string,
    action: "OPEN" | "AUTO_OPEN",
    actor: Actor,
  ): Promise<ThreadLifecycleResult> {
    let fallback: ThreadFailureCode = "DISCORD_FETCH_FAILED";
    try {
      const initial = await fetchSupported(guildId, threadId);
      if (initial.archived) {
        throw new LifecycleFailure("THREAD_NOT_ACTIVE");
      }

      fallback = "STATE_READ_FAILED";
      const managed = await managedThreads.find(guildId, threadId);
      if (managed?.lifecycleState !== "CLOSED") {
        if (action === "OPEN") {
          await requirePermissions(guildId, threadId, actor.type === "USER" ? actor.id : undefined);
          fallback = "AUDIT_WRITE_FAILED";
          await audit(guildId, threadId, action, actor, "SUCCESS");
        }
        return { ok: true, changed: false };
      }

      await requirePermissions(guildId, threadId, actor.type === "USER" ? actor.id : undefined);
      return await completeOpen(guildId, threadId, managed, action, actor);
    } catch (error) {
      return fail(guildId, threadId, action, actor, error, fallback);
    }
  }

  async function completeOpen(
    guildId: string,
    threadId: string,
    managed: ManagedThread,
    action: "OPEN" | "AUTO_OPEN",
    actor: Actor,
  ): Promise<ThreadLifecycleResult> {
    let fallback: ThreadFailureCode = "DISCORD_FETCH_FAILED";
    try {
      const beforeRename = await fetchSupported(guildId, threadId);
      if (beforeRename.archived) {
        throw new LifecycleFailure("THREAD_NOT_ACTIVE");
      }
      await requirePermissions(guildId, threadId, actor.type === "USER" ? actor.id : undefined);

      const openedName = removeClosedPrefix(beforeRename.name, managed.appliedPrefix);
      if (openedName !== beforeRename.name) {
        fallback = "DISCORD_RENAME_FAILED";
        await discord.renameThread(guildId, threadId, openedName);
      }

      fallback = "STATE_WRITE_FAILED";
      await managedThreads.markOpen(guildId, threadId);
      fallback = "AUDIT_WRITE_FAILED";
      await audit(guildId, threadId, action, actor, "SUCCESS");
      return { ok: true, changed: true };
    } catch (error) {
      return fail(guildId, threadId, action, actor, error, fallback);
    }
  }

  return {
    close,
    open: (guildId, threadId, actorId) =>
      reconcileOpen(guildId, threadId, "OPEN", { type: "USER", id: actorId }),
    autoOpen: (guildId, threadId) =>
      reconcileOpen(guildId, threadId, "AUTO_OPEN", { type: "SYSTEM" }),
  };
}
