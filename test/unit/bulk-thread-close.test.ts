import { ChannelType as C } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BULK_ADMISSION_MS,
  BULK_SESSION_CAPACITY,
  createBulkCloseService,
  matchesBulkCloseFilters,
  normalizeBulkCloseFilters,
  selectBulkCloseSnapshot,
} from "../../src/bulk-thread-close.js";
import type {
  BulkCloseDiscord,
  BulkCloseIdentity,
  BulkCloseSession,
  BulkCloseThread,
} from "../../src/bulk-thread-close.js";
import type { ScheduledThreadCloseCommandService } from "../../src/scheduled-thread-close-command.js";
import type { BulkThreadCloseHooks } from "../../src/thread-lifecycle.js";

const parent = { id: "2", guildId: "1", name: "Parent", type: C.GuildText };
const epoch = Date.parse("2026-10-04T00:00:00Z");
function thread(id = "10", changes: Partial<BulkCloseThread> = {}): BulkCloseThread {
  return {
    guildId: "1",
    threadId: id,
    parentId: "2",
    type: C.PublicThread,
    name: "Topic",
    ownerId: "9",
    createdTimestamp: epoch - 60_000,
    archived: false,
    locked: false,
    ...changes,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(count = 1) {
  let ready = true;
  let clock = epoch;
  const targets = Array.from({ length: count }, (_, i) => thread(String(i + 10)));
  const discord: BulkCloseDiscord = {
    discover: vi.fn(() => Promise.resolve({ parent, threads: [...targets] })),
    observe: vi.fn<BulkCloseDiscord["observe"]>((_guild, _parent, _actor, ids) =>
      Promise.resolve({
        parent,
        threads: targets
          .filter((target) => ids.includes(target.threadId))
          .map((target) => ({ ...target })),
      }),
    ),
  };
  const hooks: BulkThreadCloseHooks[] = [];
  const closeManually = vi.fn<ScheduledThreadCloseCommandService["closeManually"]>(
    async (_guild, _thread, _actor, bulk) => {
      hooks.push(bulk!);
      if (!(await bulk!.checkSelection()) || !bulk!.canAdmit()) {
        bulk!.onLogicalSettled();
        return {
          outcome: "LIFECYCLE",
          result: { ok: false, code: "BULK_SELECTION_CHANGED", bulkSkipped: "INELIGIBLE" },
        };
      }
      bulk!.onAttemptStarted();
      bulk!.onLogicalSettled();
      return { outcome: "LIFECYCLE", result: { ok: true, changed: true } };
    },
  );
  const service = createBulkCloseService({
    discord,
    manualClose: { closeManually },
    isReady: () => ready,
    now: () => clock,
  });
  async function preview(): Promise<{ session: BulkCloseSession; identity: BulkCloseIdentity }> {
    const result = await service.preview("1", "2", "9", { nameContains: "Topic" });
    if (!result.ok) throw new Error(result.reason);
    service.bind(result.session, "100");
    return { session: result.session, identity: { guildId: "1", actorId: "9", messageId: "100" } };
  }
  return {
    service,
    discord,
    closeManually,
    hooks,
    targets,
    preview,
    advance: (ms: number) => {
      clock += ms;
    },
    shutdown: () => {
      ready = false;
      service.stop();
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("bulk filters and selection", () => {
  it.each([
    { creationAge: "0m" },
    { creationAge: "366d" },
    { creationAge: "1.5h" },
    { creationAge: "1h 2m" },
  ])("rejects missing or invalid conditions %j", (input) => {
    expect(() => normalizeBulkCloseFilters(input, epoch)).toThrow();
  });
  it("normalizes only duration, fixes an inclusive creation cutoff and ANDs exact filters", () => {
    const filters = normalizeBulkCloseFilters(
      { nameContains: "Top", ownerId: "9", creationAge: " 1M " },
      epoch,
    );
    expect(filters).toEqual({
      nameContains: "Top",
      ownerId: "9",
      creationAgeMs: 60_000,
      creationCutoff: epoch - 60_000,
    });
    expect(matchesBulkCloseFilters(thread(), filters)).toBe(true);
    for (const changes of [
      { name: "topic" },
      { name: "Top*" },
      { ownerId: "09" },
      { createdTimestamp: epoch - 59_999 },
      { createdTimestamp: null },
      { createdTimestamp: NaN },
    ]) {
      expect(matchesBulkCloseFilters(thread("10", changes), filters)).toBe(changes.name === "Top*");
    }
    expect(
      matchesBulkCloseFilters(thread("10", { name: "[a-z]*" }), { nameContains: "[a-z]*" }),
    ).toBe(true);
    expect(
      matchesBulkCloseFilters(thread("10", { name: "alphabet" }), { nameContains: "[a-z]*" }),
    ).toBe(false);
  });
  it.each([C.GuildText, C.GuildAnnouncement, C.GuildForum])(
    "selects unmanaged eligible children under supported parent %s",
    (type) => {
      const targetType = type === C.GuildAnnouncement ? C.AnnouncementThread : C.PublicThread;
      expect(
        selectBulkCloseSnapshot(
          { parent: { ...parent, type }, threads: [thread("10", { type: targetType })] },
          { ownerId: "9" },
        ),
      ).toEqual(["10"]);
    },
  );
  it("excludes private, archived, locked, wrong guild/parent/type/media and deduplicates stable numeric ID order", () => {
    const invalid: Partial<BulkCloseThread>[] = [
      { type: C.PrivateThread },
      { archived: true },
      { locked: true },
      { guildId: "3" },
      { parentId: "3" },
      { type: C.AnnouncementThread },
    ];
    const threads = [
      thread("100"),
      thread("9"),
      thread("10"),
      thread("10"),
      ...invalid.map((change, i) => thread(String(200 + i), change)),
    ];
    expect(selectBulkCloseSnapshot({ parent, threads }, { nameContains: "Top" })).toEqual([
      "9",
      "10",
      "100",
    ]);
    expect(
      selectBulkCloseSnapshot(
        { parent: { ...parent, type: C.GuildMedia }, threads },
        { ownerId: "9" },
      ),
    ).toEqual([]);
  });
  it.each([0, 1, 50, 51])("handles %s matches without truncation", async (count) => {
    const f = fixture(count);
    const result = await f.service.preview("1", "2", "9", { ownerId: "9" });
    if (count === 0 || count === 51)
      expect(result).toEqual({ ok: false, reason: count === 0 ? "EMPTY" : "TOO_MANY" });
    else expect(result.ok && result.session.candidateIds).toHaveLength(count);
    expect(f.closeManually).not.toHaveBeenCalled();
  });
});

describe("bulk sessions and identity races", () => {
  it.each([{ guildId: "3" }, { actorId: "8" }, { messageId: "101" }])(
    "rejects identity mismatch %j",
    async (change) => {
      const f = fixture();
      const { session, identity } = await f.preview();
      expect(await f.service.confirm(session.id, { ...identity, ...change })).toBeUndefined();
      expect(f.service.cancel(session.id, { ...identity, ...change })).toBeUndefined();
      expect(await f.service.page(session.id, { ...identity, ...change }, 0)).toBeUndefined();
      expect(f.closeManually).not.toHaveBeenCalled();
    },
  );
  it("rejects stale, expired and cancelled sessions; parallel Confirm consumes once", async () => {
    const f = fixture();
    const { session, identity } = await f.preview();
    const results = await Promise.all([
      f.service.confirm(session.id, identity),
      f.service.confirm(session.id, identity),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await results.find(Boolean)!.result;
    expect(f.closeManually).toHaveBeenCalledOnce();
    expect(await f.service.confirm(session.id, identity)).toBeUndefined();
    expect(f.service.cancel(session.id, identity)).toBeUndefined();
    expect(await f.service.page(session.id, identity, 0)).toBeUndefined();
    const cancelled = await f.preview();
    expect(f.service.cancel(cancelled.session.id, identity)?.state).toBe("CANCELLED");
    expect(await f.service.confirm(cancelled.session.id, identity)).toBeUndefined();
    const expired = await f.preview();
    f.advance(300_000);
    expect(await f.service.confirm(expired.session.id, identity)).toBeUndefined();
    expect(await f.service.confirm("bad-id", identity)).toBeUndefined();
  });
  it.each(["expiry", "cancel", "shutdown"])(
    "rechecks %s after asynchronous confirmation authorization",
    async (race) => {
      const f = fixture();
      const { session, identity } = await f.preview();
      const gate = deferred<undefined>();
      vi.mocked(f.discord.observe).mockImplementationOnce(async () => {
        await gate.promise;
        return { parent, threads: [] };
      });
      const confirmation = f.service.confirm(session.id, identity);
      if (race === "expiry") f.advance(300_000);
      else if (race === "cancel") f.service.cancel(session.id, identity);
      else f.shutdown();
      gate.resolve(undefined);
      expect(await confirmation).toBeUndefined();
      expect(f.closeManually).not.toHaveBeenCalled();
    },
  );
  it("enforces finite capacity without live eviction, retains terminal sessions until original expiry, cleans lazily", async () => {
    const f = fixture();
    const sessions = [];
    for (let i = 0; i < BULK_SESSION_CAPACITY; i++) sessions.push(await f.preview());
    expect(await f.service.preview("1", "2", "9", { ownerId: "9" })).toEqual({
      ok: false,
      reason: "CAPACITY",
    });
    const first = sessions[0]!;
    expect(await f.service.page(first.session.id, first.identity, 0)).toBeDefined();
    f.service.cancel(first.session.id, first.identity);
    expect(await f.service.preview("1", "2", "9", { ownerId: "9" })).toEqual({
      ok: false,
      reason: "CAPACITY",
    });
    f.advance(300_000);
    expect((await f.preview()).session.state).toBe("PREVIEW");
  });
  it("pagination rechecks consumption and terminal control removal follows in-flight page writes", async () => {
    const f = fixture(11);
    const { session, identity } = await f.preview();
    const gate = deferred<undefined>();
    vi.mocked(f.discord.observe).mockImplementationOnce(async () => {
      await gate.promise;
      return { parent, threads: [] };
    });
    const page = f.service.page(session.id, identity, 1);
    const confirmed = await f.service.confirm(session.id, identity);
    gate.resolve(undefined);
    expect(await page).toBeUndefined();
    await confirmed!.result;
    const f2 = fixture();
    const p = await f2.preview();
    const writeGate = deferred<undefined>();
    const writes: string[] = [];
    const writing = f2.service.updatePreview(p.session, async () => {
      await writeGate.promise;
      writes.push("page");
    });
    await Promise.resolve();
    f2.service.cancel(p.session.id, p.identity);
    const stale = f2.service.updatePreview(p.session, () => {
      writes.push("stale");
      return Promise.resolve();
    });
    const terminal = f2.service.updatePreview(
      p.session,
      () => {
        writes.push("clear");
        return Promise.resolve();
      },
      true,
    );
    writeGate.resolve(undefined);
    await Promise.all([writing, stale, terminal]);
    expect(writes).toEqual(["page", "clear"]);
  });
  it("a restart loses confirmations and never resumes snapshot work", async () => {
    const f = fixture();
    const preview = await f.preview();
    const restarted = fixture();
    expect(await restarted.service.confirm(preview.session.id, preview.identity)).toBeUndefined();
    expect(restarted.closeManually).not.toHaveBeenCalled();
  });
});

describe("bulk orchestration ownership", () => {
  it("never adds new matches, skips changed snapshot targets and propagates actor", async () => {
    const f = fixture(2);
    const { session, identity } = await f.preview();
    f.targets.push(thread("99"));
    f.targets[0]!.name = "Changed";
    const confirmed = await f.service.confirm(session.id, identity);
    const counts = await confirmed!.result;
    expect(counts).toMatchObject({ selected: 2, attempted: 1, closed: 1, skipped: 1 });
    expect(f.closeManually.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ["1", "10", "9"],
      ["1", "11", "9"],
    ]);
  });
  it.each([
    { archived: true },
    { locked: true },
    { parentId: "3" },
    { type: C.PrivateThread },
    { ownerId: "8" },
    { createdTimestamp: null },
  ])("revalidates eligibility before admission %j", async (changes) => {
    const f = fixture();
    const result = await f.service.preview("1", "2", "9", { ownerId: "9", creationAge: "1m" });
    if (!result.ok) throw new Error("Preview failed");
    f.service.bind(result.session, "100");
    Object.assign(f.targets[0]!, changes);
    const confirmed = await f.service.confirm(result.session.id, {
      guildId: "1",
      actorId: "9",
      messageId: "100",
    });
    expect(await confirmed!.result).toMatchObject({ attempted: 0, skipped: 1 });
  });
  it("keeps global slots across sessions and PENDING until logical settlement, then admits waiters", async () => {
    vi.useFakeTimers();
    const f = fixture(4);
    const p1 = await f.preview();
    const p2 = await f.preview();
    f.closeManually.mockImplementation((_g, _t, _a, bulk) => {
      f.hooks.push(bulk!);
      bulk!.onAttemptStarted();
      return Promise.resolve({ outcome: "LIFECYCLE", result: { ok: false, pending: true } });
    });
    const c1 = await f.service.confirm(p1.session.id, p1.identity);
    const c2 = await f.service.confirm(p2.session.id, p2.identity);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.closeManually).toHaveBeenCalledTimes(3);
    // A caller PENDING and elapsed observation budget release no logical slot.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.closeManually).toHaveBeenCalledTimes(3);
    f.hooks[0]!.onLogicalSettled();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.closeManually).toHaveBeenCalledTimes(4);
    f.advance(BULK_ADMISSION_MS + 1);
    await vi.advanceTimersByTimeAsync(BULK_ADMISSION_MS + 1);
    const results = await Promise.all([c1!.result, c2!.result]);
    expect(results.reduce((n, c) => n + c.attempted, 0)).toBe(4);
    expect(results.reduce((n, c) => n + c.skipped, 0)).toBe(4);
    for (const bulk of f.hooks) bulk.onLogicalSettled();
    expect(f.closeManually).toHaveBeenCalledTimes(4);
  });
  it("bounds stalled manual preparation response while retaining logical slots", async () => {
    vi.useFakeTimers();
    const f = fixture(4);
    const p = await f.preview();
    const gate = deferred<never>();
    f.closeManually.mockImplementation((_g, _t, _a, bulk) => {
      f.hooks.push(bulk!);
      bulk!.onAttemptStarted();
      return gate.promise;
    });
    const confirmed = await f.service.confirm(p.session.id, p.identity);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.closeManually).toHaveBeenCalledTimes(3);
    f.advance(BULK_ADMISSION_MS + 1);
    await vi.advanceTimersByTimeAsync(BULK_ADMISSION_MS + 1);
    expect(await confirmed!.result).toMatchObject({
      selected: 4,
      attempted: 3,
      pending: 3,
      skipped: 1,
    });
    for (const bulk of f.hooks) bulk.onLogicalSettled();
  });
  it.each(["deadline", "shutdown"])(
    "a preflight crossing %s cannot start an attempt",
    async (race) => {
      const f = fixture();
      const p = await f.preview();
      const gate = deferred<undefined>();
      f.closeManually.mockImplementation(async (_g, _t, _a, bulk) => {
        await gate.promise;
        if (!bulk!.canAdmit()) {
          bulk!.onLogicalSettled();
          return {
            outcome: "LIFECYCLE",
            result: { ok: false, code: "BULK_SELECTION_CHANGED", bulkSkipped: "NOT_STARTED" },
          };
        }
        throw new Error("Unexpected admission");
      });
      const confirmed = await f.service.confirm(p.session.id, p.identity);
      if (race === "deadline") f.advance(BULK_ADMISSION_MS + 1);
      else f.shutdown();
      gate.resolve(undefined);
      expect(await confirmed!.result).toMatchObject({ attempted: 0, skipped: 1 });
    },
  );
  it("allows exact admission deadline equality but not a caller timed out before admission", async () => {
    vi.useFakeTimers();
    const f = fixture(2);
    const p = await f.preview();
    let index = 0;
    f.closeManually.mockImplementation((_g, _t, _a, bulk) => {
      if (index++ === 0) {
        f.advance(BULK_ADMISSION_MS);
        expect(bulk!.canAdmit()).toBe(true);
        bulk!.onAttemptStarted();
        bulk!.onLogicalSettled();
        return Promise.resolve({ outcome: "LIFECYCLE", result: { ok: true, changed: true } });
      }
      return new Promise((resolve) => {
        setTimeout(() => {
          expect(bulk!.canAdmit()).toBe(false);
          bulk!.onLogicalSettled();
          resolve({
            outcome: "LIFECYCLE",
            result: { ok: false, code: "BULK_SELECTION_CHANGED", bulkSkipped: "NOT_STARTED" },
          });
        }, 15_001);
      });
    });
    const confirmation = await f.service.confirm(p.session.id, p.identity);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await confirmation!.result).toMatchObject({ attempted: 1, closed: 1, skipped: 1 });
    await vi.advanceTimersByTimeAsync(1);
  });

  it("shutdown wakes capacity waiters and retains started operations", async () => {
    const f = fixture(4);
    const p = await f.preview();
    f.closeManually.mockImplementation((_g, _t, _a, bulk) => {
      f.hooks.push(bulk!);
      bulk!.onAttemptStarted();
      return Promise.resolve({ outcome: "LIFECYCLE", result: { ok: false, pending: true } });
    });
    const confirmed = await f.service.confirm(p.session.id, p.identity);
    await Promise.resolve();
    await Promise.resolve();
    f.shutdown();
    expect(await confirmed!.result).toMatchObject({ attempted: 3, pending: 3, skipped: 1 });
    expect(await f.service.confirm(p.session.id, p.identity)).toBeUndefined();
    expect(await f.service.preview("1", "2", "9", { ownerId: "9" })).toMatchObject({ ok: false });
  });
  it("classifies existing ownership separately from started failures, schedule execution and Pending", async () => {
    const f = fixture(7);
    const p = await f.preview();
    let index = 0;
    f.closeManually.mockImplementation((_g, _t, _a, bulk) => {
      const i = index++;
      if (i !== 0) bulk!.onAttemptStarted();
      bulk!.onLogicalSettled();
      const results = [
        {
          outcome: "LIFECYCLE",
          result: { ok: false, code: "BULK_SELECTION_CHANGED", bulkSkipped: "EXISTING_OPERATION" },
        },
        { outcome: "LIFECYCLE", result: { ok: true, changed: true } },
        { outcome: "LIFECYCLE", result: { ok: true, changed: false } },
        { outcome: "LIFECYCLE", result: { ok: false, pending: true } },
        { outcome: "LIFECYCLE", result: { ok: false, code: "BULK_SELECTION_CHANGED" } },
        { outcome: "PERSISTENCE_FAILURE" },
        { outcome: "EXECUTION_IN_PROGRESS" },
      ] as const;
      return Promise.resolve(results[i]!);
    });
    const confirmed = await f.service.confirm(p.session.id, p.identity);
    expect(await confirmed!.result).toEqual({
      selected: 7,
      attempted: 5,
      closed: 1,
      alreadyClosed: 1,
      pending: 1,
      failed: 2,
      skipped: 2,
    });
  });
});

describe("interactive candidate selection", () => {
  it.each([{}, { nameContains: "" }, { nameContains: " \n\t", creationAge: "  " }])(
    "normalizes blank optional filters %j",
    (input) => {
      expect(normalizeBulkCloseFilters(input, epoch)).toEqual({});
    },
  );
  it("preserves nonblank literal edge spaces", () => {
    const filters = normalizeBulkCloseFilters({ nameContains: " Topic " }, epoch);
    expect(filters.nameContains).toBe(" Topic ");
    expect(matchesBulkCloseFilters(thread(), filters)).toBe(false);
    expect(matchesBulkCloseFilters(thread("10", { name: "A Topic B" }), filters)).toBe(true);
  });
  it.each([0, 1, 50, 51])(
    "unfiltered %s candidates obey the same cap and never preselect",
    async (count) => {
      const f = fixture(count);
      const result = await f.service.preview("1", "2", "9", {});
      if (count === 0 || count === 51)
        expect(result).toEqual({ ok: false, reason: count === 0 ? "EMPTY" : "TOO_MANY" });
      else {
        if (!result.ok) throw new Error(result.reason);
        expect(result.session.candidateIds).toHaveLength(count);
        expect(result.session.selectedIds.size).toBe(0);
        f.service.bind(result.session, "100");
        expect(
          await f.service.confirm(result.session.id, {
            guildId: "1",
            actorId: "9",
            messageId: "100",
          }),
        ).toBeUndefined();
      }
      expect(f.closeManually).not.toHaveBeenCalled();
    },
  );
  it("selects multiple, deselects, clears only the page and persists other pages", async () => {
    const f = fixture(12);
    const { session, identity } = await f.preview();
    expect([...session.selectedIds]).toEqual(session.candidateIds);
    expect(f.service.select(session.id, identity, 0, session.revision, ["10", "11"])).toBe(session);
    expect(session.selectedIds.size).toBe(4);
    await f.service.page(session.id, identity, 1);
    f.service.select(session.id, identity, 1, session.revision, []);
    expect([...session.selectedIds]).toEqual(["10", "11"]);
    await f.service.page(session.id, identity, 0);
    expect([...session.selectedIds]).toEqual(["10", "11"]);
    f.service.select(session.id, identity, 0, session.revision, ["11"]);
    expect([...session.selectedIds]).toEqual(["11"]);
    f.service.select(session.id, identity, 0, session.revision, []);
    expect(session.selectedIds.size).toBe(0);
    expect(await f.service.confirm(session.id, identity)).toBeUndefined();
    expect(f.closeManually).not.toHaveBeenCalled();
  });
  it.each(
    [["99"], ["10", "10"], ["20"], ["bad"], [null], "10", undefined].map((values) => ({ values })),
  )("rejects injected, duplicate, wrong-page or malformed values %j", async ({ values }) => {
    const f = fixture(11);
    const { session, identity } = await f.preview();
    expect(f.service.select(session.id, identity, 0, 0, values)).toBeUndefined();
    expect(session.selectedIds.size).toBe(11);
    expect(session.revision).toBe(0);
  });
  it.each([{ guildId: "3" }, { actorId: "8" }, { messageId: "101" }])(
    "rejects selection identity %j",
    async (change) => {
      const f = fixture();
      const { session, identity } = await f.preview();
      expect(f.service.select(session.id, { ...identity, ...change }, 0, 0, [])).toBeUndefined();
      expect(session.selectedIds.size).toBe(1);
    },
  );
  it("rejects stale revisions, expiry and cancellation", async () => {
    const f = fixture();
    const { session, identity } = await f.preview();
    f.service.select(session.id, identity, 0, 0, []);
    expect(f.service.select(session.id, identity, 0, 0, ["10"])).toBeUndefined();
    f.advance(300000);
    expect(f.service.select(session.id, identity, 0, 1, ["10"])).toBeUndefined();
    expect(f.service.select("lost", identity, 0, 0, [])).toBeUndefined();
    const next = await f.preview();
    f.service.cancel(next.session.id, identity);
    expect(f.service.select(next.session.id, identity, 0, 0, [])).toBeUndefined();
  });
  it("freezes selection after awaited authorization, excludes deselected targets and never grows", async () => {
    const f = fixture(3);
    const { session, identity } = await f.preview();
    const gate = deferred<undefined>();
    vi.mocked(f.discord.observe).mockImplementationOnce(async () => {
      await gate.promise;
      return { parent, threads: [] };
    });
    const confirmation = f.service.confirm(session.id, identity);
    f.service.select(session.id, identity, 0, 0, ["11"]);
    f.targets.push(thread("99"));
    gate.resolve(undefined);
    const confirmed = (await confirmation)!;
    expect(confirmed.executionIds).toEqual(["11"]);
    expect(Object.isFrozen(confirmed.executionIds)).toBe(true);
    expect(f.service.select(session.id, identity, 0, 1, ["10"])).toBeUndefined();
    expect(await confirmed.result).toMatchObject({ selected: 1, attempted: 1, closed: 1 });
    expect(f.closeManually.mock.calls.map((call) => call[1])).toEqual(["11"]);
    expect(session.candidateIds).toEqual(["10", "11", "12"]);
  });
  it("a selection revision invalidates an in-flight page renderer", async () => {
    const f = fixture(11);
    const { session, identity } = await f.preview();
    const gate = deferred<undefined>();
    vi.mocked(f.discord.observe).mockImplementationOnce(async () => {
      await gate.promise;
      return { parent, threads: f.targets };
    });
    const page = f.service.page(session.id, identity, 1, 0);
    f.service.select(session.id, identity, 0, 0, ["10"]);
    gate.resolve(undefined);
    expect(await page).toBeUndefined();
    expect(session.page).toBe(0);
    expect(session.selectedIds.size).toBe(2);
  });
  it("unconfigured filters admit targets despite changed name/owner/missing creation timestamp", async () => {
    const f = fixture();
    const result = await f.service.preview("1", "2", "9", {});
    if (!result.ok) throw new Error(result.reason);
    f.service.bind(result.session, "100");
    const identity = { guildId: "1", actorId: "9", messageId: "100" };
    f.service.select(result.session.id, identity, 0, 0, ["10"]);
    Object.assign(f.targets[0]!, { name: "Other", ownerId: null, createdTimestamp: null });
    const confirmed = await f.service.confirm(result.session.id, identity);
    expect(await confirmed!.result).toMatchObject({ selected: 1, closed: 1 });
  });
});

describe("bounded setup tickets", () => {
  it("consumes once, rejects wrong actor/guild and loses tickets on restart", () => {
    const f = fixture();
    const id = f.service.createSetup("1", "9")!;
    expect(f.service.consumeSetup(id, "1", "8")).toBe(false);
    expect(f.service.consumeSetup(id, "2", "9")).toBe(false);
    expect(fixture().service.consumeSetup(id, "1", "9")).toBe(false);
    expect(f.service.consumeSetup(id, "1", "9")).toBe(true);
    expect(f.service.consumeSetup(id, "1", "9")).toBe(false);
    expect(f.closeManually).not.toHaveBeenCalled();
  });
  it("bounds capacity without eviction; expiry and shutdown invalidate tickets", () => {
    const f = fixture();
    const ids = Array.from({ length: BULK_SESSION_CAPACITY }, () =>
      f.service.createSetup("1", "9")!,
    );
    expect(f.service.createSetup("1", "9")).toBeUndefined();
    expect(f.service.consumeSetup(ids[0]!, "1", "9")).toBe(true);
    const last = f.service.createSetup("1", "9")!;
    f.advance(300000);
    expect(f.service.consumeSetup(last, "1", "9")).toBe(false);
    const next = f.service.createSetup("1", "9")!;
    f.shutdown();
    expect(f.service.consumeSetup(next, "1", "9")).toBe(false);
    expect(f.service.createSetup("1", "9")).toBeUndefined();
  });
});
