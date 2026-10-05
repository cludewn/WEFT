import { randomUUID } from "node:crypto";

import { ChannelType } from "discord.js";

import { isSnowflake } from "./link-preview.js";
import { parseRelativeDuration } from "./relative-duration.js";
import type { ScheduledThreadCloseCommandService } from "./scheduled-thread-close-command.js";
import type { ThreadSnapshot } from "./thread-lifecycle.js";

export const BULK_CONFIRMATION_TTL_MS = 300_000;
export const BULK_ADMISSION_MS = 300_000;
export const BULK_SESSION_CAPACITY = 128;
export const BULK_TARGET_LIMIT = 50;
export const BULK_PAGE_SIZE = 10;
export const BULK_CONCURRENCY = 3;
export const BULK_CALLER_WAIT_MS = 15_000;

export type BulkCloseFilters = Readonly<{
  nameContains?: string;
  ownerId?: string;
  creationAgeMs?: number;
  creationCutoff?: number;
}>;
export type BulkCloseThread = ThreadSnapshot & {
  parentId: string | null;
  ownerId: string | null;
  createdTimestamp: number | null;
};
export type BulkCloseParent = { id: string; guildId: string; type: ChannelType; name: string };
export type BulkCloseObservation = { parent: BulkCloseParent; threads: BulkCloseThread[] };
export type BulkCloseReadStage =
  | "parent_fetch"
  | "guild_fetch"
  | "roles_fetch"
  | "actor_member_fetch"
  | "bot_member_fetch"
  | "active_enumeration"
  | "candidate_fetch";
export type BulkCloseReadContext = {
  signal: AbortSignal;
  read: (stage: BulkCloseReadStage, work: () => Promise<unknown>) => Promise<unknown>;
};
export type BulkCloseDiscord = {
  discover: (
    guildId: string,
    parentId: string,
    actorId: string,
    context?: BulkCloseReadContext,
  ) => Promise<BulkCloseObservation | undefined>;
  observe: (
    guildId: string,
    parentId: string,
    actorId: string,
    ids: readonly string[],
    context?: BulkCloseReadContext,
  ) => Promise<BulkCloseObservation | undefined>;
};
export type BulkCloseIdentity = { guildId: string; actorId: string; messageId: string };
export type BulkCloseSession = {
  readonly id: string;
  readonly guildId: string;
  readonly actorId: string;
  readonly parentId: string;
  readonly filters: BulkCloseFilters;
  readonly candidateIds: readonly string[];
  readonly selectedIds: Set<string>;
  readonly expiresAt: number;
  messageId: string | undefined;
  state: "PREVIEW" | "EXECUTING" | "CANCELLED" | "EXPIRED";
  responseTail: Promise<void>;
  page: number;
  revision: number;
};
export type BulkCloseCounts = {
  selected: number;
  attempted: number;
  closed: number;
  alreadyClosed: number;
  pending: number;
  failed: number;
  skipped: number;
};
export type BulkClosePreviewResult =
  | { ok: true; session: BulkCloseSession }
  | { ok: false; reason: "INVALID_FILTER" | "UNAVAILABLE" | "EMPTY" | "TOO_MANY" | "CAPACITY" };

export function normalizeBulkCloseFilters(
  input: { nameContains?: string; ownerId?: string; creationAge?: string },
  now: number,
): BulkCloseFilters {
  const nameContains = input.nameContains?.trim() ? input.nameContains : undefined;
  if (input.ownerId !== undefined && !isSnowflake(input.ownerId))
    throw new Error("Invalid owner ID");
  const duration = input.creationAge?.trim() ? parseRelativeDuration(input.creationAge) : undefined;
  return Object.freeze({
    ...(nameContains === undefined ? {} : { nameContains }),
    ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
    ...(duration === undefined ? {} : { creationAgeMs: duration, creationCutoff: now - duration }),
  });
}
export function isBulkCloseParent(type: ChannelType): boolean {
  return [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(
    type,
  );
}
export function isBulkCloseChild(parent: BulkCloseParent, thread: BulkCloseThread): boolean {
  return (
    isBulkCloseParent(parent.type) &&
    thread.guildId === parent.guildId &&
    thread.parentId === parent.id &&
    thread.type ===
      (parent.type === ChannelType.GuildAnnouncement
        ? ChannelType.AnnouncementThread
        : ChannelType.PublicThread)
  );
}
export function matchesBulkCloseFilters(
  thread: BulkCloseThread,
  filters: BulkCloseFilters,
): boolean {
  return (
    (filters.nameContains === undefined || thread.name.includes(filters.nameContains)) &&
    (filters.ownerId === undefined || thread.ownerId === filters.ownerId) &&
    (filters.creationCutoff === undefined ||
      (thread.createdTimestamp !== null &&
        Number.isFinite(thread.createdTimestamp) &&
        thread.createdTimestamp <= filters.creationCutoff))
  );
}
export function selectBulkCloseSnapshot(
  observation: BulkCloseObservation,
  filters: BulkCloseFilters,
): string[] {
  const ids = new Set(
    observation.threads
      .filter(
        (thread) =>
          isBulkCloseChild(observation.parent, thread) &&
          !thread.archived &&
          !thread.locked &&
          isSnowflake(thread.threadId) &&
          matchesBulkCloseFilters(thread, filters),
      )
      .map((thread) => thread.threadId),
  );
  // Canonical decimal IDs sorted numerically without conversion to Number or creation-time inference.
  return [...ids].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
}

type Dependencies = {
  discord: BulkCloseDiscord;
  manualClose: Pick<ScheduledThreadCloseCommandService, "closeManually">;
  isReady: () => boolean;
  now?: () => number;
};
export type BulkCloseService = ReturnType<typeof createBulkCloseService>;

export function createBulkCloseService({
  discord,
  manualClose,
  isReady,
  now = Date.now,
}: Dependencies) {
  const sessions = new Map<string, BulkCloseSession>();
  const setups = new Map<string, { guildId: string; actorId: string; expiresAt: number }>();
  const waiters = new Set<() => void>();
  let occupied = 0;
  let stopped = false;
  const ready = () => !stopped && isReady();
  const wake = () => {
    for (const notify of [...waiters]) notify();
  };
  const cleanup = () => {
    for (const [id, setup] of setups) if (setup.expiresAt <= now()) setups.delete(id);
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now()) {
        if (session.state === "PREVIEW") session.state = "EXPIRED";
        sessions.delete(id);
      }
    }
  };
  const current = (id: string, identity: BulkCloseIdentity): BulkCloseSession | undefined => {
    cleanup();
    const session = sessions.get(id);
    if (
      !ready() ||
      !session ||
      session.state !== "PREVIEW" ||
      session.guildId !== identity.guildId ||
      session.actorId !== identity.actorId ||
      session.messageId !== identity.messageId
    )
      return;
    return session;
  };
  async function acquire(deadline: number): Promise<(() => void) | undefined> {
    while (ready() && now() <= deadline) {
      if (occupied < BULK_CONCURRENCY) {
        occupied++;
        let released = false;
        return () => {
          if (!released) {
            released = true;
            occupied--;
            wake();
          }
        };
      }
      await new Promise<void>((resolve) => {
        const notify = () => {
          clearTimeout(timer);
          waiters.delete(notify);
          resolve();
        };
        const timer = setTimeout(notify, Math.max(1, deadline - now() + 1));
        waiters.add(notify);
      });
    }
  }
  async function execute(
    session: BulkCloseSession,
    executionIds: readonly string[],
    deadline: number,
  ): Promise<BulkCloseCounts> {
    type Outcome = "closed" | "alreadyClosed" | "pending" | "failed" | "skipped";
    const records: { attempted: boolean; outcome: Outcome }[] = executionIds.map(() => ({
      attempted: false,
      outcome: "skipped",
    }));
    let next = 0;
    async function worker(): Promise<void> {
      while (next < executionIds.length) {
        const index = next++;
        const release = await acquire(deadline);
        if (!release) continue;
        const record = records[index]!;
        const threadId = executionIds[index]!;
        let callerWaiting = true;
        let settled = false;
        const finish = () => {
          settled = true;
          release();
        };
        // The lifecycle owns this promise, including stalled cancellation preparation and late finalization.
        const result = manualClose
          .closeManually(session.guildId, threadId, session.actorId, {
            checkSelection: async () => {
              const observed = await discord.observe(
                session.guildId,
                session.parentId,
                session.actorId,
                [threadId],
              );
              const thread = observed?.threads.find((item) => item.threadId === threadId);
              return observed &&
                thread &&
                isBulkCloseChild(observed.parent, thread) &&
                !thread.archived &&
                !thread.locked &&
                matchesBulkCloseFilters(thread, session.filters)
                ? thread
                : undefined;
            },
            canAdmit: () => callerWaiting && ready() && now() <= deadline,
            onAttemptStarted: () => {
              record.attempted = true;
              record.outcome = "pending";
            },
            onLogicalSettled: finish,
          })
          .then(
            (result) => {
              if (result.outcome === "EXECUTION_IN_PROGRESS") {
                // The wrapper established that cancellation could not start; no close effects occurred.
                record.attempted = false;
                record.outcome = "skipped";
              } else if (result.outcome === "PERSISTENCE_FAILURE") {
                record.outcome = record.attempted ? "failed" : "skipped";
              } else if (result.result.ok) {
                record.outcome = result.result.changed ? "closed" : "alreadyClosed";
              } else if (!result.result.pending && result.result.bulkSkipped) {
                record.attempted = false;
                record.outcome = "skipped";
              } else {
                record.outcome = record.attempted
                  ? result.result.pending
                    ? "pending"
                    : "failed"
                  : "skipped";
              }
            },
            () => {
              record.outcome = record.attempted ? "failed" : "skipped";
            },
          );
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          result,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, BULK_CALLER_WAIT_MS);
          }),
        ]);
        if (timer) clearTimeout(timer);
        callerWaiting = false;
        if (!record.attempted && !settled) record.outcome = "skipped";
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    const counts: BulkCloseCounts = {
      selected: executionIds.length,
      attempted: 0,
      closed: 0,
      alreadyClosed: 0,
      pending: 0,
      failed: 0,
      skipped: 0,
    };
    for (const record of records) {
      if (record.attempted) counts.attempted++;
      counts[record.outcome]++;
    }
    return counts;
  }
  return {
    createSetup(guildId: string, actorId: string) {
      cleanup();
      if (
        !ready() ||
        !isSnowflake(guildId) ||
        !isSnowflake(actorId) ||
        setups.size >= BULK_SESSION_CAPACITY
      )
        return;
      const id = randomUUID();
      setups.set(id, { guildId, actorId, expiresAt: now() + BULK_CONFIRMATION_TTL_MS });
      return id;
    },
    consumeSetup(id: string, guildId: string, actorId: string) {
      cleanup();
      const ticket = setups.get(id);
      if (!ready() || !ticket || ticket.guildId !== guildId || ticket.actorId !== actorId)
        return false;
      setups.delete(id);
      return true;
    },
    async preview(
      guildId: string,
      parentId: string,
      actorId: string,
      input: Parameters<typeof normalizeBulkCloseFilters>[0],
      context?: BulkCloseReadContext,
    ): Promise<BulkClosePreviewResult> {
      if (
        !ready() ||
        context?.signal.aborted ||
        !isSnowflake(guildId) ||
        !isSnowflake(parentId) ||
        !isSnowflake(actorId)
      )
        return { ok: false, reason: "UNAVAILABLE" };
      let filters: BulkCloseFilters;
      const startedAt = now();
      try {
        filters = normalizeBulkCloseFilters(input, startedAt);
      } catch {
        return { ok: false, reason: "INVALID_FILTER" };
      }
      let observed: BulkCloseObservation | undefined;
      try {
        observed = await discord.discover(guildId, parentId, actorId, context);
      } catch {
        return { ok: false, reason: "UNAVAILABLE" };
      }
      if (!ready() || context?.signal.aborted || !observed)
        return { ok: false, reason: "UNAVAILABLE" };
      const ids = selectBulkCloseSnapshot(observed, filters);
      if (!ids.length) return { ok: false, reason: "EMPTY" };
      if (ids.length > BULK_TARGET_LIMIT) return { ok: false, reason: "TOO_MANY" };
      cleanup();
      if (sessions.size >= BULK_SESSION_CAPACITY) return { ok: false, reason: "CAPACITY" };
      const session: BulkCloseSession = {
        id: randomUUID(),
        guildId,
        parentId,
        actorId,
        filters,
        candidateIds: Object.freeze(ids),
        selectedIds: new Set(Object.keys(filters).length ? ids : []),
        expiresAt: now() + BULK_CONFIRMATION_TTL_MS,
        messageId: undefined,
        state: "PREVIEW",
        responseTail: Promise.resolve(),
        page: 0,
        revision: 0,
      };
      sessions.set(session.id, session);
      return { ok: true, session };
    },
    bind(session: BulkCloseSession, messageId: string) {
      if (sessions.get(session.id) === session && ready()) session.messageId = messageId;
    },
    discardPreview(session: BulkCloseSession) {
      if (sessions.get(session.id) === session && session.state === "PREVIEW") {
        session.state = "EXPIRED";
        sessions.delete(session.id);
      }
    },
    findPreview: current,
    select(
      id: string,
      identity: BulkCloseIdentity,
      page: number,
      revision: number,
      values: unknown,
    ) {
      const session = current(id, identity);
      if (
        !session ||
        session.page !== page ||
        session.revision !== revision ||
        revision >= 999999 ||
        !Array.isArray(values)
      )
        return;
      const pageIds = session.candidateIds.slice(
        page * BULK_PAGE_SIZE,
        (page + 1) * BULK_PAGE_SIZE,
      );
      if (
        new Set(values).size !== values.length ||
        values.some(
          (value: unknown) =>
            typeof value !== "string" ||
            !isSnowflake(value) ||
            !pageIds.includes(value) ||
            !session.candidateIds.includes(value),
        )
      )
        return;
      for (const value of pageIds) session.selectedIds.delete(value);
      for (const value of values as string[]) session.selectedIds.add(value);
      session.revision++;
      return session;
    },
    async page(
      id: string,
      identity: BulkCloseIdentity,
      page: number,
      expectedRevision?: number,
      context?: BulkCloseReadContext,
    ) {
      const session = current(id, identity);
      if (
        !session ||
        context?.signal.aborted ||
        !Number.isInteger(page) ||
        page < 0 ||
        page >= Math.ceil(session.candidateIds.length / BULK_PAGE_SIZE) ||
        (expectedRevision !== undefined && session.revision !== expectedRevision) ||
        session.revision >= 999999
      )
        return;
      const revision = session.revision;
      const ids = session.candidateIds.slice(page * BULK_PAGE_SIZE, (page + 1) * BULK_PAGE_SIZE);
      let observed: BulkCloseObservation | undefined;
      try {
        observed = await discord.observe(
          session.guildId,
          session.parentId,
          session.actorId,
          ids,
          context,
        );
      } catch {
        return;
      }
      if (
        !observed ||
        context?.signal.aborted ||
        current(id, identity) !== session ||
        session.revision !== revision
      )
        return;
      if (session.page !== page) {
        session.page = page;
        session.revision++;
      }
      return {
        session,
        parent: observed.parent,
        threads: ids.map((threadId) => observed.threads.find((item) => item.threadId === threadId)),
        page,
        revision: session.revision,
      };
    },
    async confirm(id: string, identity: BulkCloseIdentity) {
      const session = current(id, identity);
      if (!session) return;
      let observed: BulkCloseObservation | undefined;
      try {
        observed = await discord.observe(session.guildId, session.parentId, session.actorId, []);
      } catch {
        return;
      }
      if (!observed || current(id, identity) !== session || !session.selectedIds.size) return;
      const executionIds = Object.freeze(
        session.candidateIds.filter((id) => session.selectedIds.has(id)),
      );
      if (!executionIds.length) return;
      session.state = "EXECUTING"; // Synchronous consumption, after all awaited authorization.
      const deadline = now() + BULK_ADMISSION_MS;
      return { session, executionIds, result: execute(session, executionIds, deadline) };
    },
    cancel(id: string, identity: BulkCloseIdentity) {
      const session = current(id, identity);
      if (!session) return;
      session.state = "CANCELLED";
      return session;
    },
    // Serialize only preview-message writes. Final control removal follows any earlier raw page edit.
    async updatePreview(
      session: BulkCloseSession,
      update: () => Promise<unknown>,
      terminal = false,
    ) {
      const response = session.responseTail.then(async () => {
        if (terminal || (ready() && session.state === "PREVIEW" && session.expiresAt > now()))
          await update();
      });
      session.responseTail = response.catch(() => undefined);
      await response;
    },
    stop() {
      stopped = true;
      for (const session of sessions.values())
        if (session.state === "PREVIEW") session.state = "EXPIRED";
      sessions.clear();
      setups.clear();
      wake();
    },
  };
}
