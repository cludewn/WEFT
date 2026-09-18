import { asc, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase, type DatabaseClient } from "../../src/database.js";
import { scheduledActions } from "../../src/scheduled-action-persistence.js";
import type { ScheduledMessageDiscord } from "../../src/scheduled-message-discord.js";
import { createScheduledMessageExecutor } from "../../src/scheduled-message-execution.js";
import {
  createScheduledMessageStore,
  scheduledMessageAudits,
  scheduledMessageStates,
  type CreateScheduledMessage,
  type ScheduledMessageDefinition,
} from "../../src/scheduled-message-persistence.js";

const guildId = "scheduled-admin-guild";
const channelId = "scheduled-admin-channel";
const actorId = "scheduled-admin-actor";
const baseTime = new Date("2031-01-01T00:00:00.000Z");
const database = createDatabase(loadTestDatabaseConfig());
const store = createScheduledMessageStore(database.client);

beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
});

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await database.close();
});

describe("scheduled message administration persistence", () => {
  it("lists only scoped nonterminal SEND_MESSAGE rows in stable pages without payload fields", async () => {
    const definitions: ScheduledMessageDefinition[] = [];
    for (let index = 0; index < 12; index += 1) {
      definitions.push(
        await store.create(
          creation(
            `list-${index.toString().padStart(2, "0")}`,
            new Date(baseTime.getTime() + (index % 3) * 60_000),
            `secret-${index}`,
          ),
        ),
      );
    }
    await store.claimExecution(definitions[1]!.action.id, 0);
    await store.cancel({
      scheduledActionId: definitions[2]!.action.id,
      guildId,
      channelId,
      actorId,
      auditId: "list-cancel-audit",
      occurredAt: baseTime,
    });
    await store.create({
      ...creation("wrong-channel", baseTime, "wrong-channel-secret"),
      channelId: "other-channel",
    });
    await database.client.insert(scheduledActions).values({
      id: "list-close-action",
      guildId,
      actionType: "CLOSE_THREAD",
      targetId: channelId,
      status: "ACTIVE",
      executeAt: baseTime,
    });

    const first = await store.listNonterminal(guildId, channelId, 0);
    const second = await store.listNonterminal(guildId, channelId, 10);
    expect(first).toMatchObject({ outcome: "FOUND" });
    expect(second).toMatchObject({ outcome: "FOUND" });
    if (first.outcome !== "FOUND" || second.outcome !== "FOUND") throw new Error("list failed");
    expect(first.schedules).toHaveLength(10);
    expect(second.schedules).toHaveLength(1);
    expect([...first.schedules, ...second.schedules]).toEqual(
      [...first.schedules, ...second.schedules].toSorted(
        (left, right) =>
          left.executeAt.getTime() - right.executeAt.getTime() ||
          left.scheduledActionId.localeCompare(right.scheduledActionId),
      ),
    );
    expect(first.schedules.some((item) => item.status === "EXECUTING")).toBe(true);
    expect(JSON.stringify([...first.schedules, ...second.schedules])).not.toContain("secret-");
    expect(Object.keys(first.schedules[0]!).toSorted()).toEqual([
      "creatorUserId",
      "executeAt",
      "scheduledActionId",
      "status",
    ]);
  });

  it("does not disclose a wrong-context payload and distinguishes lifecycle states", async () => {
    const active = await store.create(creation("editable-active", baseTime, "private payload"));
    await expect(store.findEditable(active.action.id, guildId, "wrong-channel")).resolves.toEqual({
      outcome: "NOT_FOUND_OR_WRONG_CONTEXT",
    });
    await expect(store.findEditable(active.action.id, guildId, channelId)).resolves.toMatchObject({
      outcome: "ACTIVE",
      definition: { revision: 0, payload: { content: "private payload" } },
    });
    await store.claimExecution(active.action.id, 0);
    await expect(store.findEditable(active.action.id, guildId, channelId)).resolves.toEqual({
      outcome: "EXECUTING",
    });
  });

  it("keeps exact edit no-ops audit-free and commits one revision with one exact audit", async () => {
    const initial = await store.create(creation("edit-state", baseTime, "before"));
    await expect(
      store.edit({
        ...scope(initial),
        actorId,
        expectedRevision: 0,
        payload: initial.payload,
        auditId: "no-op-audit",
        occurredAt: baseTime,
      }),
    ).resolves.toMatchObject({ outcome: "UNCHANGED", definition: { revision: 0 } });

    const changedPayload = {
      content: "after",
      embed: {
        title: "title",
        description: "description",
        color: 0,
        imageUrl: "https://example.invalid/edit.png",
      },
    };
    await expect(
      store.edit({
        ...scope(initial),
        actorId,
        expectedRevision: 0,
        payload: changedPayload,
        auditId: "edit-audit",
        occurredAt: baseTime,
      }),
    ).resolves.toMatchObject({
      outcome: "EDITED",
      definition: {
        revision: 1,
        payload: changedPayload,
        action: { id: initial.action.id, executeAt: initial.action.executeAt },
        creatorUserId: actorId,
        retryCount: 0,
        resultMessageId: null,
      },
    });
    await expect(
      database.client
        .select()
        .from(scheduledMessageAudits)
        .where(eq(scheduledMessageAudits.scheduledActionId, initial.action.id))
        .orderBy(asc(scheduledMessageAudits.occurredAt), asc(scheduledMessageAudits.id)),
    ).resolves.toEqual([
      expect.objectContaining({ event: "CREATED" }),
      expect.objectContaining({
        id: "edit-audit",
        event: "EDITED",
        actorType: "USER",
        actorId,
        outcome: "SUCCESS",
        failureCode: null,
        resultMessageId: null,
        content: "after",
      }),
    ]);
  });

  it("linearizes edit and reschedule against revision-aware execution claims in both orders", async () => {
    const editWins = await store.create(creation("edit-wins", baseTime, "before"));
    await expect(edit(editWins, "edited", "edit-wins-audit")).resolves.toMatchObject({
      outcome: "EDITED",
      definition: { revision: 1 },
    });
    await expect(store.claimExecution(editWins.action.id, 0)).resolves.toMatchObject({
      outcome: "NOT_TRANSITIONED",
      current: { action: { status: "ACTIVE" }, revision: 1 },
    });

    const executionWinsEdit = await store.create(
      creation("execution-wins-edit", baseTime, "before"),
    );
    await expect(store.claimExecution(executionWinsEdit.action.id, 0)).resolves.toMatchObject({
      outcome: "COMMITTED",
    });
    await expect(edit(executionWinsEdit, "late", "late-edit-audit")).resolves.toEqual({
      outcome: "EXECUTING",
    });

    const rescheduleWins = await store.create(creation("reschedule-wins", baseTime, "before"));
    await expect(
      reschedule(rescheduleWins, 0, new Date(baseTime.getTime() + 3_600_000), "reschedule-audit"),
    ).resolves.toMatchObject({ outcome: "RESCHEDULED", definition: { revision: 1 } });
    await expect(store.claimExecution(rescheduleWins.action.id, 0)).resolves.toMatchObject({
      outcome: "NOT_TRANSITIONED",
      current: { action: { status: "ACTIVE" }, revision: 1 },
    });

    const executionWinsReschedule = await store.create(
      creation("execution-wins-reschedule", baseTime, "before"),
    );
    await store.claimExecution(executionWinsReschedule.action.id, 0);
    await expect(
      reschedule(
        executionWinsReschedule,
        0,
        new Date(baseTime.getTime() + 7_200_000),
        "late-reschedule-audit",
      ),
    ).resolves.toEqual({ outcome: "EXECUTING" });
  });

  it("skips when an outer due read is followed by a reschedule to the future", async () => {
    const dueAt = new Date(baseTime.getTime() - 1_000);
    const initial = await store.create(creation("future-after-outer-due-read", dueAt, "payload"));
    const [outerRead] = await database.client
      .select()
      .from(scheduledActions)
      .where(eq(scheduledActions.id, initial.action.id));
    expect(outerRead?.executeAt.getTime()).toBeLessThanOrEqual(baseTime.getTime());

    const futureExecuteAt = new Date(baseTime.getTime() + 60_000);
    await expect(
      reschedule(initial, 0, futureExecuteAt, "future-after-outer-due-read-audit"),
    ).resolves.toMatchObject({
      outcome: "RESCHEDULED",
      definition: { revision: 1, action: { executeAt: futureExecuteAt } },
    });
    const auditsBeforeExecution = await database.client
      .select()
      .from(scheduledMessageAudits)
      .where(eq(scheduledMessageAudits.scheduledActionId, initial.action.id));
    const discord = {
      preflight: vi.fn<ScheduledMessageDiscord["preflight"]>(),
      createMessage: vi.fn<ScheduledMessageDiscord["createMessage"]>(),
      deleteMessage: vi.fn<ScheduledMessageDiscord["deleteMessage"]>(),
    } satisfies ScheduledMessageDiscord;
    const executor = createScheduledMessageExecutor({ store, discord, now: () => baseTime });

    await expect(executor.execute(initial.action.id)).resolves.toEqual({
      outcome: "SKIPPED",
      reason: "NOT_DUE",
    });

    expect(discord.preflight).not.toHaveBeenCalled();
    expect(discord.createMessage).not.toHaveBeenCalled();
    await expect(store.find(initial.action.id)).resolves.toMatchObject({
      action: { status: "ACTIVE", executeAt: futureExecuteAt },
      revision: 1,
      retryCount: 0,
      payload: initial.payload,
      resultMessageId: null,
    });
    await expect(
      database.client
        .select()
        .from(scheduledMessageAudits)
        .where(eq(scheduledMessageAudits.scheduledActionId, initial.action.id)),
    ).resolves.toEqual(auditsBeforeExecution);
  });

  it("allows only one mutation from the same expected revision", async () => {
    const editEdit = await store.create(creation("edit-edit", baseTime, "before"));
    await expect(edit(editEdit, "winner", "edit-edit-winner")).resolves.toMatchObject({
      outcome: "EDITED",
    });
    await expect(edit(editEdit, "loser", "edit-edit-loser")).resolves.toEqual({
      outcome: "CONFLICT",
    });

    const editReschedule = await store.create(creation("edit-reschedule", baseTime, "before"));
    await edit(editReschedule, "winner", "edit-reschedule-winner");
    await expect(
      reschedule(editReschedule, 0, new Date(baseTime.getTime() + 60_000), "edit-reschedule-loser"),
    ).resolves.toEqual({ outcome: "CONFLICT" });

    const rescheduleEdit = await store.create(creation("reschedule-edit", baseTime, "before"));
    await reschedule(
      rescheduleEdit,
      0,
      new Date(baseTime.getTime() + 60_000),
      "reschedule-edit-winner",
    );
    await expect(edit(rescheduleEdit, "loser", "reschedule-edit-loser")).resolves.toEqual({
      outcome: "CONFLICT",
    });

    const rescheduleReschedule = await store.create(
      creation("reschedule-reschedule", baseTime, "before"),
    );
    await reschedule(
      rescheduleReschedule,
      0,
      new Date(baseTime.getTime() + 60_000),
      "reschedule-winner",
    );
    await expect(
      reschedule(
        rescheduleReschedule,
        0,
        new Date(baseTime.getTime() + 120_000),
        "reschedule-loser",
      ),
    ).resolves.toEqual({ outcome: "CONFLICT" });
  });

  it("confirms stable edit and reschedule audits even after a later revision commits", async () => {
    const editInitial = await store.create(creation("ambiguous-edit", baseTime, "before"));
    const editResponseLoss = createScheduledMessageStore(
      responseLossDatabase(async () => {
        await store.edit({
          ...scope(editInitial),
          actorId,
          expectedRevision: 1,
          payload: { content: "later edit", embed: null },
          auditId: "later-edit-audit",
          occurredAt: new Date(baseTime.getTime() + 1_000),
        });
      }),
    );
    await expect(
      editResponseLoss.edit({
        ...scope(editInitial),
        actorId,
        expectedRevision: 0,
        payload: { content: "first edit", embed: null },
        auditId: "ambiguous-edit-audit",
        occurredAt: baseTime,
      }),
    ).resolves.toMatchObject({ outcome: "EDITED", definition: { revision: 1 } });
    await expect(store.find(editInitial.action.id)).resolves.toMatchObject({
      revision: 2,
      payload: { content: "later edit" },
    });

    const rescheduleInitial = await store.create(
      creation("ambiguous-reschedule", baseTime, "before"),
    );
    const firstExecuteAt = new Date(baseTime.getTime() + 60_000);
    const rescheduleResponseLoss = createScheduledMessageStore(
      responseLossDatabase(async () => {
        await store.reschedule({
          ...scope(rescheduleInitial),
          actorId,
          expectedRevision: 1,
          executeAt: new Date(baseTime.getTime() + 120_000),
          auditId: "later-reschedule-audit",
          occurredAt: new Date(baseTime.getTime() + 1_000),
        });
      }),
    );
    await expect(
      rescheduleResponseLoss.reschedule({
        ...scope(rescheduleInitial),
        actorId,
        expectedRevision: 0,
        executeAt: firstExecuteAt,
        auditId: "ambiguous-reschedule-audit",
        occurredAt: baseTime,
      }),
    ).resolves.toMatchObject({
      outcome: "RESCHEDULED",
      definition: { revision: 1, action: { executeAt: firstExecuteAt } },
    });
    await expect(store.find(rescheduleInitial.action.id)).resolves.toMatchObject({ revision: 2 });
  });
});

function creation(id: string, executeAt: Date, content: string): CreateScheduledMessage {
  return {
    scheduledActionId: id,
    auditId: `${id}-created-audit`,
    guildId,
    channelId,
    actorId,
    executeAt,
    payload: { content, embed: null },
    occurredAt: new Date(baseTime.getTime() - 60_000),
  };
}

function scope(definition: ScheduledMessageDefinition) {
  return {
    scheduledActionId: definition.action.id,
    guildId: definition.action.guildId,
    channelId: definition.action.targetId,
  };
}

function edit(definition: ScheduledMessageDefinition, content: string, auditId: string) {
  return store.edit({
    ...scope(definition),
    actorId,
    expectedRevision: definition.revision,
    payload: { content, embed: null },
    auditId,
    occurredAt: baseTime,
  });
}

function reschedule(
  definition: ScheduledMessageDefinition,
  expectedRevision: number,
  executeAt: Date,
  auditId: string,
) {
  return store.reschedule({
    ...scope(definition),
    actorId,
    expectedRevision,
    executeAt,
    auditId,
    occurredAt: baseTime,
  });
}

async function cleanup(): Promise<void> {
  await database.client
    .delete(scheduledMessageAudits)
    .where(eq(scheduledMessageAudits.guildId, guildId));
  const actions = await database.client
    .select({ id: scheduledActions.id })
    .from(scheduledActions)
    .where(eq(scheduledActions.guildId, guildId));
  const actionIds = actions.map((action) => action.id);
  if (actionIds.length === 0) return;
  await database.client
    .delete(scheduledMessageStates)
    .where(inArray(scheduledMessageStates.scheduledActionId, actionIds));
  await database.client.delete(scheduledActions).where(inArray(scheduledActions.id, actionIds));
}

function responseLossDatabase(afterCommit: () => Promise<void>): DatabaseClient {
  const transaction = database.client.transaction.bind(database.client);
  return new Proxy(database.client, {
    get(target, property): unknown {
      if (property === "transaction") {
        return async (callback: never) => {
          await transaction(callback);
          await afterCommit();
          throw new Error("injected transaction response loss");
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
