import { dynamicArguments, type DynamicMessageKey } from "./i18n-fixtures.js";
import { describe, expect, expectTypeOf, it } from "vitest";

import { enUS, type TranslationCatalog } from "../../src/i18n/en-US.js";
import { ja } from "../../src/i18n/ja.js";
import { createTranslator, resolveLocale, translate } from "../../src/i18n/translate.js";

describe("interaction localization", () => {
  it.each([
    ["ja", "ja"],
    ["en-US", "en-US"],
    ["en-GB", "en-US"],
    ["fr", "en-US"],
    [undefined, "en-US"],
    [null, "en-US"],
    ["", "en-US"],
    ["JA", "en-US"],
    [123, "en-US"],
    [{ locale: "ja" }, "en-US"],
  ])("resolves %j to %s", (input, expected) => {
    expect(resolveLocale(input)).toBe(expected);
  });

  it("keeps complete nonempty production catalogs with matching entry kinds", () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(enUS).sort());
    expect(Object.keys(dynamicArguments).sort()).toEqual(
      Object.keys(enUS)
        .filter((key) => typeof enUS[key as keyof typeof enUS] === "function")
        .sort(),
    );
    for (const key of Object.keys(enUS) as (keyof typeof enUS)[]) {
      expect(typeof ja[key]).toBe(typeof enUS[key]);

      for (const catalog of [enUS, ja]) {
        const entry = catalog[key];
        const result: unknown =
          typeof entry === "function"
            ? Reflect.apply(entry, undefined, dynamicArguments[key as DynamicMessageKey])
            : entry;
        if (typeof result !== "string") throw new Error(`Invalid catalog entry: ${key}`);
        expect(result.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("passes named parameters and Unicode unchanged in both languages", () => {
    const mode = "公開 🌸 e\u0301 <@123> **text**";
    expect(translate("en-US", "linkPreview.show", { mode })).toBe(`Link preview mode: ${mode}`);
    expect(translate("ja", "linkPreview.show", { mode })).toBe(`リンクプレビューモード: ${mode}`);
    expectTypeOf(ja).toMatchTypeOf<TranslationCatalog>();
    expectTypeOf(translate("ja", "linkPreview.show", { mode })).toEqualTypeOf<string>();
  });

  it.each([undefined, null, "", " \n ", 1, {}, () => "wrong kind"])(
    "falls back for a missing or invalid fixed entry (%j)",
    (entry) => {
      const t = createTranslator({ "linkPreview.loadFailed": entry });
      expect(t("ja", "linkPreview.loadFailed")).toBe("Could not load the preview configuration.");
    },
  );

  it.each([
    undefined,
    null,
    "invalid function",
    () => "",
    () => " \n ",
    () => 42,
    () => Promise.resolve("invalid async entry"),
    () => {
      throw new Error("broken translation");
    },
  ])("falls back with the same named arguments for an invalid dynamic entry (%j)", (entry) => {
    const t = createTranslator({ "linkPreview.show": entry });
    expect(t("ja", "linkPreview.show", { mode: "公開 🌸" })).toBe("Link preview mode: 公開 🌸");
  });

  it("ignores Japanese entries for an unsupported locale resolved to English", () => {
    const entry = () => {
      throw new Error("must not execute");
    };
    expect(
      createTranslator({ "linkPreview.show": entry })(resolveLocale("en-GB"), "linkPreview.show", {
        mode: "Off",
      }),
    ).toBe("Link preview mode: Off");
  });

  it("throws when canonical rendering fails instead of inventing a successful response", () => {
    const invalidParameter = {
      get mode(): string {
        throw new Error("unavailable parameter");
      },
    };
    expect(() => createTranslator({})("ja", "linkPreview.show", invalidParameter)).toThrow(
      "Invalid canonical translation: linkPreview.show",
    );
  });

  it.each(["en-US", "ja"] as const)(
    "describes no-op settings and empty preview accurately in %s",
    (locale) => {
      expect(
        translate(locale, "config.valueChanged", { timezone: true, value: "UTC", unchanged: true }),
      ).toBe(
        locale === "ja"
          ? "WEFTの既定タイムゾーンはUTCです（変更なし）。"
          : "WEFT default timezone: UTC (unchanged)",
      );
      expect(
        translate(locale, "config.botActivityChanged", { enabled: false, unchanged: true }),
      ).toBe(
        locale === "ja"
          ? "ボットの投稿を含めない設定です（変更なし）。"
          : "Bot posts: excluded (unchanged)",
      );
      expect(translate(locale, "config.parentEnabled", { channelId: "123", count: 0 })).toBe(
        locale === "ja"
          ? "<#123>の自動クローズを有効にしました。計測開始時刻の変更はありません。"
          : "Automatic close enabled for <#123>. No new activity baselines were needed.",
      );
      expect(translate(locale, "preview.empty")).toBe(
        locale === "ja"
          ? "プレビューに表示できる内容がありません。"
          : "No supported content is available for this preview.",
      );
      expect(translate(locale, "preview.failure")).toBe(
        locale === "ja"
          ? "WEFTはこのメッセージを表示できませんでした。"
          : "Could not show this message.",
      );
      expect(translate(locale, "list.time.historical")).toBe(
        locale === "ja" ? "取消前の予定日時" : "Scheduled time before cancellation",
      );
    },
  );
});

// Compiled by the ordinary typecheck; never execute deliberately invalid calls.
function translationTypeContract() {
  // @ts-expect-error Unknown translation keys are rejected.
  translate("ja", "unknown");
  // @ts-expect-error Dynamic entries require named parameters.
  translate("ja", "linkPreview.show");
  // @ts-expect-error Parameter names are checked.
  translate("ja", "linkPreview.show", { label: "Off" });
  // @ts-expect-error Parameter types are checked.
  translate("ja", "linkPreview.show", { mode: 1 });
  // @ts-expect-error Fixed entries take no arguments.
  translate("ja", "linkPreview.loadFailed", {});
  // @ts-expect-error Missing Japanese keys are rejected.
  const incomplete: TranslationCatalog = {};
  const invalid: TranslationCatalog = {
    ...ja,
    // @ts-expect-error Japanese dynamic entries must keep the canonical parameter contract.
    "linkPreview.show": ({ mode }: { mode: number }) => String(mode),
  };
  return { incomplete, invalid };
}
void translationTypeContract;

// Independent completed sentences guard readability and outcome certainty together.
describe.each(["en-US", "ja"] as const)("UI copy regressions (%s)", (locale) => {
  const japanese = locale === "ja";

  it("uses semantic setting values and distinguishes a no-op from a saved change", () => {
    expect(
      translate(locale, "config.valueChanged", {
        timezone: false,
        value: "[CLOSED]",
        unchanged: true,
      }),
    ).toBe(
      japanese
        ? "クローズ用プレフィックスは[CLOSED]です（変更なし）。"
        : "Closed prefix: [CLOSED] (unchanged)",
    );
    expect(
      translate(locale, "config.inactivityChanged", {
        inactivity: "12h",
        unchanged: false,
      }),
    ).toBe(japanese ? "無投稿期間を12hに変更しました。" : "Inactivity period: 12h (saved)");
    expect(translate(locale, "config.botActivity", { enabled: false })).toBe(
      japanese ? "ボットの投稿: 含めない" : "Bot posts: excluded",
    );
    expect(translate(locale, "thread.status.effective", { enabled: false })).toBe(
      japanese ? "自動クローズ: 対象外" : "Automatic close: not eligible",
    );
    expect(translate(locale, "thread.status.parentPolicy", { enabled: true })).toBe(
      japanese ? "親チャンネルの自動クローズ: 有効" : "Parent channel: enabled",
    );
    expect(
      translate(locale, "config.autoSummary", {
        count: 1,
        inactivity: "7d",
        botMessages: true,
      }),
    ).toBe(
      japanese
        ? "自動クローズ: 対象チャンネル1件／無投稿期間7d／ボットの投稿を含める"
        : "Automatic close: 1 channel, inactivity 7d, bot posts included",
    );
  });

  it("renders a confirmed one-time save without repeated qualifications or an empty final line", () => {
    expect(
      translate(locale, "message.scheduleCreated", {
        id: "schedule-1",
        channelId: "123",
        when: 1900000000,
        pending: false,
      }),
    ).toBe(
      japanese
        ? "単発予約`schedule-1`を保存しました。送信先: <#123>\n送信日時: <t:1900000000:F> (<t:1900000000:R>)"
        : "One-time schedule `schedule-1` saved. Channel: <#123>. Send time: <t:1900000000:F> (<t:1900000000:R>).",
    );
  });

  it("keeps execution-registration uncertainty after a confirmed recurring save", () => {
    expect(
      translate(locale, "message.recurringCreated", {
        id: "series-1",
        when: 1900000000,
        pending: true,
      }),
    ).toBe(
      japanese
        ? "定期投稿`series-1`を設定しました。初回: <t:1900000000:F>\n実行登録は未確認です。WEFTが自動で確認・調整します。"
        : "Recurring schedule `series-1` saved. First send: <t:1900000000:F>. Execution setup is unconfirmed; WEFT will check and repair it automatically.",
    );
  });

  it("keeps a confirmed cancellation distinct from queued-work cleanup", () => {
    expect(
      translate(locale, "message.scheduleCancelled", {
        id: "schedule-1",
        recurring: false,
        already: true,
        cleanupPending: true,
      }),
    ).toBe(
      japanese
        ? "単発予約`schedule-1`は取消済みです。実行待ち処理の停止は未確認です。WEFTが自動で確認・調整します。"
        : "One-time schedule `schedule-1` was already cancelled. Stopping queued work is unconfirmed; WEFT will check it automatically.",
    );
  });

  it("explains unchanged content without implying updates to running occurrences", () => {
    expect(
      translate(locale, "message.schedulePayloadEdited", {
        id: "series-1",
        recurring: true,
        unchanged: true,
      }),
    ).toBe(
      japanese
        ? "定期投稿`series-1`の内容に変更はありません。実行中・再試行待ちの回の内容は変わりません。"
        : "Recurring schedule `series-1` content unchanged. Running or retrying occurrences keep their previous content.",
    );
  });

  it("retains inspection guidance when saving itself is unconfirmed", () => {
    expect(translate(locale, "message.scheduleSaveUnconfirmed")).toBe(
      japanese
        ? "予約の保存は未確認です。実行登録は行っていません。再試行する前に予約を確認してください。"
        : "Could not confirm the schedule was saved. WEFT did not register execution. Check the schedule before retrying.",
    );
    expect(translate(locale, "message.editPartial", { id: "123" })).toBe(
      japanese
        ? "メッセージ`123`は編集済みですが、WEFTへの記録も元の内容への復元も未確認です。管理者にメッセージと記録の確認を依頼してください。"
        : "Message `123` was edited, but neither its WEFT record nor a safe restoration is confirmed. Ask an administrator to check the message and record.",
    );
  });
});

it.each(["en-US", "ja"] as const)(
  "keeps one-time selector guidance consistent across operations in %s",
  (locale) => {
    const qualifier =
      locale === "ja" ? "（afterとatのいずれかを指定）" : "(specify either after or at)";
    for (const option of ["after", "at"] as const) {
      const create = translate(locale, `command.message.schedule.create.${option}.description`);
      const reschedule = translate(
        locale,
        `command.message.schedule.reschedule.${option}.description`,
      );
      expect(create).toContain(qualifier);
      expect(reschedule).toBe(create);
      expect(create.length).toBeLessThanOrEqual(100);
    }
  },
);
