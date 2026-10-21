import { ComponentType } from "discord.js";
import { readFileSync } from "node:fs";
import type { ChatInputCommandInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";

import { resolveGuildLocale } from "../../src/i18n/translate.js";
import type { AppLocale } from "../../src/i18n/translate.js";
import {
  scheduledMessageListMessage,
  createScheduledMessageListNavigation,
} from "../../src/messages/scheduled-message-list.js";
import type { ScheduledMessageCommandService } from "../../src/messages/scheduled-message-command.js";
import {
  buildBulkCloseModal,
  renderBulkClosePage,
} from "../../src/threads/bulk-thread-close-command.js";
import type { BulkCloseService } from "../../src/threads/bulk-thread-close.js";
import {
  createManagedMessageSendModal,
  createManagedMessageEditModal,
  createScheduledMessageCreateModal,
  createRecurringMessageCreateModal,
  createScheduledMessageEditModal,
} from "../../src/messages/message-command.js";
import { renderPreview } from "../../src/link-previews/link-preview.js";
import { previewComponents } from "../../src/link-previews/link-preview-discord.js";
import { createAuditNotificationDispatcher } from "../../src/audit/audit-notification-dispatcher.js";
import {
  formatAuditNotification,
  type AuditNotificationRecord,
  type AuditSource,
} from "../../src/audit/audit-notification-format.js";

const id = "123e4567-e89b-42d3-a456-000000000001";
const ticket = "123e4567-e89b-42d3-a456-000000000000";
const creatorUserId = "18446744073709551615";
type ListResult = Awaited<ReturnType<ScheduledMessageCommandService["list"]>>;
const tenRows = () =>
  Array.from({ length: 10 }, (_, index) => ({
    kind: "RECURRING" as const,
    scheduledActionId: `123e4567-e89b-42d3-a456-${String(index).padStart(12, "0")}`,
    creatorUserId,
    status: "ACTIVE" as const,
    executeAt: new Date(-8_640_000_000_000_000),
    frequency: "WEEKLY" as const,
    weekdayMask: 127,
    localTime: "23:59",
    timezone: "Asia/Tokyo",
    currentOccurrenceStatus: "RETRY_PENDING" as const,
  }));

it.each([
  [{ available: true, preferredLocale: "ja" }, "ja"],
  [{ available: true, preferredLocale: "en-US" }, "en-US"],
  [{ available: true, preferredLocale: "en-GB" }, "en-US"],
  [{ available: false, preferredLocale: "ja" }, "en-US"],
  [{ preferredLocale: "ja" }, "en-US"],
  [null, "en-US"],
  [undefined, "en-US"],
] as const)("resolves existing Guild state %j without I/O", (guild, expected) =>
  expect(resolveGuildLocale(guild)).toBe(expected),
);

describe.each(["en-US", "ja"] as const)(
  "localized presentation limits (%s)",
  (locale: AppLocale) => {
    it("preserves all ten full IDs and uppercase states in a retry-pending scheduled page", () => {
      const rows = tenRows();
      const rendered = scheduledMessageListMessage(
        { outcome: "FOUND", hasNext: false, schedules: rows },
        900_719_925_474_100,
        locale,
      );
      expect(rendered.displayable).toBe(true);
      expect(rendered.content.length).toBe(locale === "en-US" ? 1950 : 1768);
      expect(rendered.content.length).toBeLessThanOrEqual(2000);
      for (const row of rows) {
        expect(rendered.content).toContain(`\`${row.scheduledActionId}\``);
        expect(rendered.content).toContain(`<@${creatorUserId}> \`${creatorUserId}\``);
      }
      expect(rendered.content.split("**RETRY_PENDING**")).toHaveLength(11);
      expect(rendered.content).toContain(locale === "ja" ? "定期投稿 毎週" : "Recurring weekly");
    });

    it("fits the widest cancelled series with an occurrence still executing", () => {
      const rows = tenRows().map((row) => ({
        ...row,
        status: "CANCELLED" as const,
        currentOccurrenceStatus: "EXECUTING" as const,
      }));
      const rendered = scheduledMessageListMessage(
        { outcome: "FOUND", hasNext: false, schedules: rows },
        900_719_925_474_100,
        locale,
      );
      expect(rendered.displayable).toBe(true);
      expect(rendered.content.length).toBe(locale === "en-US" ? 1980 : 1768);
      expect(rendered.content.length).toBeLessThanOrEqual(2000);
      expect(rendered.content.split("**CANCELLED**")).toHaveLength(11);
      expect(rendered.content.split("**EXECUTING**")).toHaveLength(11);
      expect(rendered.content).toContain(locale === "ja" ? "取消前予定: <t:" : "Was due: <t:");
      for (const row of rows) expect(rendered.content).toContain(`\`${row.scheduledActionId}\``);
    });

    it("returns typed success at 2000 and typed failure at 2001 without truncating IDs", async () => {
      const rows = tenRows();
      const result: ListResult = { outcome: "FOUND", hasNext: true, schedules: rows };
      const initial = scheduledMessageListMessage(result, 1, locale);
      rows[9]!.scheduledActionId += "x".repeat(2000 - initial.content.length);
      const boundary = scheduledMessageListMessage(result, 1, locale);
      expect(boundary.displayable).toBe(true);
      expect(boundary.content.length).toBe(2000);
      expect(boundary.content).toContain(rows[9]!.scheduledActionId);
      rows[9]!.scheduledActionId += "x";
      const overflow = scheduledMessageListMessage(result, 1, locale);
      expect(overflow).toEqual({
        displayable: false,
        content:
          locale === "ja"
            ? "ページ全体を表示できなかったため、予約を表示していません。"
            : "The complete page could not be displayed safely. No schedules are shown.",
      });
      const list = vi.fn<ScheduledMessageCommandService["list"]>().mockResolvedValue(result);
      const navigation = createScheduledMessageListNavigation({ list });
      const editReply = vi.fn().mockResolvedValue({ id: "response" });
      await navigation.start({
        locale,
        createdTimestamp: Date.now(),
        guildId: "guild",
        channelId: "channel",
        user: { id: "actor" },
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply,
      } as unknown as ChatInputCommandInteraction);
      expect(editReply).toHaveBeenCalledExactlyOnceWith({
        content: overflow.content,
        components: [],
        allowedMentions: { parse: [] },
      });
      expect(list).toHaveBeenCalledOnce();
    });

    it.each(["invalid-date", "unicode-overflow"])(
      "removes controls for %s rendering without exposing any row",
      async (reason) => {
        const rows = tenRows();
        if (reason === "invalid-date") rows[0]!.executeAt = new Date(Number.NaN);
        else rows[0]!.scheduledActionId = "😀e\u0301\ud800".repeat(1000);
        const display = scheduledMessageListMessage(
          { outcome: "FOUND", hasNext: false, schedules: rows },
          1,
          locale,
        );
        expect(display.displayable).toBe(false);
        expect(display.content).not.toContain(rows[0]!.scheduledActionId);
        expect(display.content.length).toBeLessThanOrEqual(2000);
        const list = vi
          .fn<ScheduledMessageCommandService["list"]>()
          .mockResolvedValue({ outcome: "FOUND", hasNext: false, schedules: rows });
        const editReply = vi.fn().mockResolvedValue({ id: "response" });
        await createScheduledMessageListNavigation({ list }).start({
          locale,
          createdTimestamp: Date.now(),
          guildId: "guild",
          channelId: "channel",
          user: { id: "actor" },
          deferReply: vi.fn().mockResolvedValue(undefined),
          editReply,
        } as unknown as ChatInputCommandInteraction);
        expect(editReply.mock.calls[0]![0]).toEqual({
          content: display.content,
          components: [],
          allowedMentions: { parse: [] },
        });
      },
    );

    it("keeps all payload Modals within limits with identical identities and authored prefills", () => {
      const payload = {
        content: "🌸e\u0301 **authored** <@123>\n".repeat(20),
        embed: {
          title: "😀".repeat(128),
          description: "e\u0301".repeat(2000),
          color: 0xff0000,
          imageUrl: "https://example.invalid/image.png",
        },
      };
      const modals = [
        createManagedMessageSendModal(locale),
        createManagedMessageEditModal(creatorUserId, 1, payload, locale),
        createScheduledMessageCreateModal(
          { kind: "AT", localDateTime: "2030-01-01 09:30" },
          locale,
        ),
        createRecurringMessageCreateModal(
          { frequency: "weekly", weekdays: "mon,wed", time: "09:30", timezone: "Asia/Tokyo" },
          locale,
        ),
        createScheduledMessageEditModal(id, 1, payload, locale),
        buildBulkCloseModal(ticket, locale),
      ];
      for (const modal of modals) {
        const json = modal.toJSON();
        expect(json.title.length).toBeLessThanOrEqual(45);
        expect(json.custom_id.length).toBeLessThanOrEqual(100);
        expect(json.components).toHaveLength(modal === modals[5] ? 4 : 5);
        for (const component of json.components) {
          if (component.type !== ComponentType.Label) throw new Error("Expected Label component");
          expect(component.label.length).toBeLessThanOrEqual(45);
          expect(component.description?.length ?? 0).toBeLessThanOrEqual(100);
        }
      }
      const edit = modals[1]!.toJSON().components as {
        component: { custom_id: string; value?: string };
      }[];
      expect(edit.map((label) => label.component.value)).toEqual([
        payload.content,
        payload.embed.title,
        payload.embed.description,
        "#FF0000",
        payload.embed.imageUrl,
      ]);
      expect(edit.map((label) => label.component.custom_id)).toEqual([
        "managed-message:content",
        "managed-message:embed-title",
        "managed-message:embed-description",
        "managed-message:embed-color",
        "managed-message:embed-image-url",
      ]);
    });

    it("bounds all fifty bulk candidates, filters and controls with Unicode and hostile Markdown", () => {
      const candidateIds = Array.from({ length: 50 }, (_, index) => String(index + 100));
      const hostile = "😀e\u0301\ud800 [masked](https://example.invalid) @everyone <@123>\n".repeat(
        25,
      );
      for (let page = 0; page < 5; page++) {
        const view = {
          session: {
            id: ticket,
            guildId: "1",
            candidateIds,
            selectedIds: new Set(candidateIds),
            filters: {
              nameContains: hostile,
              ownerId: creatorUserId,
              creationAgeMs: 60000,
              creationCutoff: 1900000000000,
            },
            expiresAt: 1900000000000,
          },
          parent: { name: hostile },
          threads: candidateIds
            .slice(page * 10, page * 10 + 10)
            .map((threadId) => ({ threadId, name: hostile })),
          page,
          revision: 0,
        } as unknown as NonNullable<Awaited<ReturnType<BulkCloseService["page"]>>>;
        const rendered = renderBulkClosePage(view, locale);
        const json = JSON.parse(JSON.stringify(rendered)) as {
          content: string;
          embeds: {
            title: string;
            description: string;
            fields: { name: string; value: string }[];
            footer: { text: string };
          }[];
          components: {
            components: {
              label?: string;
              placeholder?: string;
              custom_id: string;
              options?: { label: string; description: string; value: string }[];
            }[];
          }[];
        };
        expect(rendered.allowedMentions).toEqual({ parse: [] });
        expect(json.content.length).toBeLessThanOrEqual(2000);
        const embed = json.embeds[0]!;
        expect(embed.description.length).toBeLessThanOrEqual(4096);
        expect(embed.title.length).toBeLessThanOrEqual(256);
        expect(embed.footer.text.length).toBeLessThanOrEqual(2048);
        let total = embed.title.length + embed.description.length + embed.footer.text.length;
        for (const field of embed.fields) {
          expect(field.name.length).toBeLessThanOrEqual(256);
          expect(field.value.length).toBeLessThanOrEqual(1024);
          total += field.name.length + field.value.length;
        }
        expect(total).toBeLessThanOrEqual(6000);
        for (const row of json.components)
          for (const component of row.components) {
            expect(component.label?.length ?? 0).toBeLessThanOrEqual(80);
            expect(component.placeholder?.length ?? 0).toBeLessThanOrEqual(150);
            expect(component.custom_id.length).toBeLessThanOrEqual(100);
            for (const option of component.options ?? []) {
              expect(option.label.length).toBeLessThanOrEqual(100);
              expect(option.description.length).toBeLessThanOrEqual(100);
              expect(candidateIds).toContain(option.value);
              expect(option.label).not.toContain("\ud800");
            }
          }
        expect(embed.description).not.toContain("[masked](https://example.invalid)");
        expect(embed.description).not.toContain("<@123>");
      }
    });

    it("localizes empty and spoiler preview text without changing authored content, location or link identities", () => {
      const message = {
        author: "作者 🌸",
        content: "plain 🌸 ||PRIVATE_SPOILER||",
        timestamp: "2030-01-01T00:00:00Z",
        attachments: [],
        forwarded: false,
      };
      const rendered = renderPreview(message, "#場所 › スレッド", locale);
      expect(rendered.description).toBe(
        locale === "ja" ? "plain 🌸 [ネタバレ部分を省略]" : "plain 🌸 [spoiler omitted]",
      );
      expect(rendered.author?.name).toBe(message.author);
      expect(rendered.footer.text).toBe("#場所 › スレッド");
      expect(renderPreview({ ...message, content: "" }, "#場所", locale).description).toBe(
        locale === "ja"
          ? "プレビューに表示できる内容がありません。"
          : "No supported content is available for this preview.",
      );
      const long = renderPreview(
        { ...message, author: "😀".repeat(200), content: "e\u0301😀\ud800\n".repeat(1000) },
        "🌸".repeat(200),
        locale,
      );
      expect(long.description!.length).toBeLessThanOrEqual(1500);
      expect(long.author!.name.length).toBeLessThanOrEqual(128);
      expect(long.footer.text.length).toBeLessThanOrEqual(128);
      const components = previewComponents(
        [{ target: { guildId: "1", channelId: "2", messageId: "3" }, ordinal: 6 }],
        7,
        locale,
      );
      expect(components[0]!.components[0]).toMatchObject({
        label: locale === "ja" ? "プレビュー6" : "Preview 6",
        custom_id: "lp:1:1:2:3",
      });
    });
  },
);

const sources: AuditSource[] = [
  "THREAD",
  "SCHEDULED_THREAD_CLOSE",
  "MANAGED_MESSAGE",
  "SCHEDULED_MESSAGE",
  "RECURRING_MESSAGE",
  "AUDIT_LOG_DESTINATION",
  "LINK_PREVIEW",
  "GUILD_CONFIGURATION",
  "ADMINISTRATIVE_OPERATION_FAILURE",
  "MANAGED_MESSAGE_EXECUTION_FAILURE",
];
describe("background audit localization", () => {
  it.each(sources)(
    "localizes only allowed labels for %s while retaining raw safe values and nonce",
    (source) => {
      const record: AuditNotificationRecord = {
        source,
        auditId: id,
        guildId: "1",
        actorType: "USER",
        actorUserId: "2",
        event: source === "MANAGED_MESSAGE_EXECUTION_FAILURE" ? "MANAGED_MESSAGE_EDIT" : "SET",
        outcome: source === "MANAGED_MESSAGE_EXECUTION_FAILURE" ? "PARTIAL" : "SUCCESS",
        occurredAt: new Date("2030-01-01T00:00:00Z"),
        threadId: "PRIVATE_THREAD",
        channelId: "PRIVATE_CHANNEL",
        messageId: "PRIVATE_MESSAGE",
        scheduledActionId: "PRIVATE_SCHEDULE",
        targetId: "PRIVATE_TARGET",
        failureStage: "DISCORD_MUTATION",
        failureCode: "MUTATION_REJECTED",
        discordEvidence: "REJECTED",
        databaseEffect: "NOT_ATTEMPTED",
        compensationEvidence: "NOT_REQUIRED",
      };
      const en = formatAuditNotification(record, "en-US")!;
      const ja = formatAuditNotification(record, "ja")!;
      expect(en.content).toContain(`Source: \`${source}\``);
      expect(en.content).toContain(`Outcome: \`${record.outcome}\``);
      expect(en.content).toContain("Actor type: `USER`");
      expect(en.content).toContain("Actor user ID: `2`");
      expect(ja.content).toContain(`種別: \`${source}\``);
      expect(ja.content).toContain(`結果: \`${record.outcome}\``);
      expect(ja.content).toContain("実行ユーザーID: `2`");
      expect(ja.content).toContain("発生日時: `2030-01-01T00:00:00.000Z`");
      expect(ja.content.startsWith("WEFTの監査通知\n")).toBe(true);
      expect(ja.content).not.toContain("Source:");
      if (source === "MANAGED_MESSAGE_EXECUTION_FAILURE") {
        expect(ja.content).toContain("Discord操作の確認状況: `REJECTED`");
        expect(ja.content).toContain("取消・復元の確認状況: `NOT_REQUIRED`");
        expect(ja.content).toContain("データベースへの反映: `NOT_ATTEMPTED`");
        expect(
          formatAuditNotification({ ...record, discordEvidence: "UNCONFIRMED" }, "ja"),
        ).toBeUndefined();
      }
      expect(ja.nonce).toBe(en.nonce);
      for (const value of [en.content, ja.content]) {
        expect(value.length).toBeLessThanOrEqual(1800);
        expect(value).not.toMatch(/<@|@everyone|@here/);
        if (
          source === "ADMINISTRATIVE_OPERATION_FAILURE" ||
          source === "MANAGED_MESSAGE_EXECUTION_FAILURE"
        )
          expect(value).not.toContain("PRIVATE_");
      }
      expect(
        formatAuditNotification({ ...record, actorUserId: "日本語の生値" }, "ja"),
      ).toBeUndefined();
    },
  );

  it.each(["ja", "en-US", "en-GB", undefined])(
    "uses synchronous background locale %s without changing publication, destination or drain",
    async (locale) => {
      const audit: AuditNotificationRecord = {
        source: "THREAD",
        auditId: id,
        guildId: "1",
        event: "CLOSE",
        outcome: "SUCCESS",
        actorType: "SYSTEM",
        occurredAt: new Date("2030-01-01T00:00:00Z"),
      };
      const send = vi.fn().mockResolvedValue("SENT");
      const readDestination = vi.fn().mockResolvedValue("123");
      const load = vi.fn().mockResolvedValue(audit);
      const localeForGuild = vi.fn(() => locale);
      const dispatcher = createAuditNotificationDispatcher({
        projection: { load },
        readDestination,
        discord: { send },
        localeForGuild,
        logger: { warn: vi.fn() },
      });
      dispatcher.publish({ source: "THREAD", auditId: id });
      await dispatcher.drain();
      expect(load).toHaveBeenCalledExactlyOnceWith({ source: "THREAD", auditId: id });
      expect(localeForGuild).toHaveBeenCalledExactlyOnceWith("1");
      expect(readDestination).toHaveBeenCalledExactlyOnceWith("1");
      expect(send).toHaveBeenCalledExactlyOnceWith({
        guildId: "1",
        destinationId: "123",
        ...formatAuditNotification(audit, locale === "ja" ? "ja" : "en-US"),
      });
      expect(
        (send.mock.calls[0]![0] as { content: string }).content.startsWith(
          locale === "ja" ? "WEFTの監査通知\n" : "WEFT audit\n",
        ),
      ).toBe(true);
    },
  );
});

it("audits English literals at all authored UI boundaries, excluding logs, exceptions and technical syntax", () => {
  const files = [
    "guild/config-command.ts",
    "threads/thread-command.ts",
    "messages/message-command.ts",
    "messages/scheduled-message-list.ts",
    "threads/bulk-thread-close-command.ts",
    "link-previews/link-preview.ts",
    "link-previews/link-preview-discord.ts",
    "audit/audit-notification-format.ts",
    "threads/thread-discord.ts",
  ];
  const violations: string[] = [];
  for (const file of files) {
    const text = readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8");
    expect(text).not.toContain("error.message");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node)
      ) {
        const raw = ts.isTemplateExpression(node) ? node.getText(source) : node.text;
        let ancestor = node.parent;
        let exempt = false;
        while (ancestor && !ts.isFunctionLike(ancestor)) {
          if (ts.isNewExpression(ancestor) || ts.isImportDeclaration(ancestor)) exempt = true;
          // Internal Error subclass constructor messages are operational diagnostics.
          if (
            ts.isCallExpression(ancestor) &&
            ancestor.expression.kind === ts.SyntaxKind.SuperKeyword
          )
            exempt = true;
          if (
            ts.isPropertyAssignment(node.parent) &&
            node.parent.name.getText(source) === "value" &&
            ts.isCallExpression(ancestor) &&
            ts.isPropertyAccessExpression(ancestor.expression) &&
            ancestor.expression.name.text === "addChoices"
          )
            exempt = true;
          if (
            ts.isCallExpression(ancestor) &&
            ts.isPropertyAccessExpression(ancestor.expression) &&
            ["debug", "info", "warn", "error"].includes(ancestor.expression.name.text)
          )
            exempt = true;
          ancestor = ancestor.parent;
        }
        const parent = node.parent;
        // Translation keys can contain TypeScript syntax; command syntax remains untranslated.
        if (
          ts.isCallExpression(parent) &&
          ts.isIdentifier(parent.expression) &&
          parent.expression.text === "translate" &&
          parent.arguments[1] === node
        )
          exempt = true;
        if (raw === "/message schedule status id:<schedule-id>") exempt = true;
        const visibleBuilder =
          ts.isCallExpression(parent) &&
          ts.isPropertyAccessExpression(parent.expression) &&
          ["setLabel", "setTitle", "setDescription", "setPlaceholder"].includes(
            parent.expression.name.text,
          );
        const visibleProperty =
          ts.isPropertyAssignment(parent) &&
          [
            "label",
            "placeholder",
            "title",
            "description",
            "content",
            "name",
            "value",
            "text",
          ].includes(parent.name.getText(source));
        if (
          !exempt &&
          !raw.startsWith("^") &&
          (/[A-Za-z]{2,}[ ][A-Za-z]{2,}/.test(raw) ||
            ((visibleBuilder || visibleProperty) &&
              /^[A-Za-z]+[.!]?$/.test(raw) &&
              !/^[A-Z_]+$/.test(raw)))
        )
          violations.push(
            `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${raw}`,
          );
        if (ts.isTemplateExpression(node)) return;
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(violations).toEqual([]);
});
