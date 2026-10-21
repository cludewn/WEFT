import type { TranslationCatalog } from "./en-US.js";

export const ja = {
  "command.config.description": "WEFTの設定を表示・変更します",
  "command.linkPreview.description": "リンクプレビューを設定します",
  "command.linkPreview.show.description": "リンクプレビューのモードを表示します",
  "command.linkPreview.mode.description": "リンクプレビューのモードを設定します",
  "command.linkPreview.value.description": "リンクプレビューの表示方法",
  "linkPreview.mode.hybrid": "自動表示＋プレビューボタン",
  "linkPreview.mode.public-only": "公開メッセージの自動表示のみ",
  "linkPreview.mode.button-only": "プレビューボタンのみ",
  "linkPreview.mode.off": "オフ",
  "linkPreview.show": ({ mode }) => `リンクプレビューモード: ${mode}`,
  "linkPreview.loadFailed": "WEFTはプレビュー設定を取得できませんでした。",
  "command.config.show.description": "WEFTの設定を表示します",
  "command.config.timezone.description": "WEFTの既定タイムゾーンを設定します",
  "command.config.timezone.value.description": "IANAタイムゾーン（例：Asia/Tokyo、UTC）",
  "command.config.closed-prefix.description": "クローズ用プレフィックスを設定します",
  "command.config.closed-prefix.set.description": "クローズ用プレフィックスを変更します",
  "command.config.closed-prefix.set.value.description": "クローズ用プレフィックス（1～20文字）",
  "command.config.closed-prefix.disable.description": "クローズ用プレフィックスを無効にします",
  "command.config.audit-log.description": "監査通知を設定します",
  "command.config.audit-log.show.description": "監査通知の送信先を表示します",
  "command.config.audit-log.set.description": "監査通知の送信先を設定します",
  "command.config.audit-log.set.channel.description": "テキストまたはアナウンスチャンネル",
  "command.config.audit-log.disable.description": "監査通知を無効にします",
  "command.config.auto-close.description": "自動クローズを設定します",
  "command.config.auto-close.show.description": "自動クローズの設定を表示します",
  "command.config.auto-close.inactivity.description":
    "自動クローズ対象になる無投稿期間を設定します",
  "command.config.auto-close.inactivity.value.description": "5分～365日（例：30m、12h、7d）",
  "command.config.auto-close.bot-messages.description":
    "ボットの投稿を無投稿期間の計測に含めるか設定します",
  "command.config.auto-close.bot-messages.value.description": "ボットの投稿も含める",
  "command.config.auto-close.add-parent.description": "親チャンネルの自動クローズを有効にします",
  "command.config.auto-close.add-parent.channel.description":
    "テキスト、アナウンスまたはフォーラムチャンネル",
  "command.config.auto-close.remove-parent.description": "親チャンネルの自動クローズを無効にします",
  "command.config.auto-close.remove-parent.channel.description": "設定済みの親チャンネル",
  "command.thread.description": "スレッドを管理します",
  "command.thread.bulk-close.description": "一括クローズの対象を選択します",
  "command.thread.close.description": "このスレッドを閉じます",
  "command.thread.open.description": "開いているスレッドのクローズ用プレフィックスを外します",
  "command.thread.close-after.description": "予約クローズを設定します",
  "command.thread.close-after.after.description":
    "クローズまでの時間（1分～365日／例：30m、2h、7d）",
  "command.thread.cancel-close.description": "このスレッドの予約クローズを取り消します",
  "command.thread.track.description": "自動クローズの除外設定を解除します",
  "command.thread.untrack.description": "このスレッドを自動クローズから除外します",
  "command.thread.status.description": "自動クローズと予約クローズの状態を表示します",
  "command.message.description": "メッセージの送信・編集・予約を行います",
  "command.message.send.description": "管理メッセージを送信します",
  "command.message.edit.description": "管理メッセージを編集します",
  "command.message.edit.message.description": "メッセージIDまたはメッセージリンク",
  "command.message.schedule.description": "予約投稿を管理します",
  "command.message.schedule.create.description": "単発の投稿を予約します",
  "command.message.schedule.create.after.description":
    "送信までの時間（afterとatのいずれかを指定）。例：30m、2h、7d",
  "command.message.schedule.create.at.description":
    "WEFTの既定タイムゾーンでYYYY-MM-DD HH:mm（afterとatのいずれかを指定）",
  "command.message.schedule.recurring-create.description": "定期投稿を設定します",
  "command.message.schedule.recurring-create.frequency.description":
    "daily（毎日）またはweekly（毎週）",
  "command.message.schedule.recurring-create.time.description": "24時間表記のHH:MM（例：09:30）",
  "command.message.schedule.recurring-create.weekdays.description":
    "曜日をカンマ区切り（例：mon,wed,fri）。frequency=dailyの場合は省略",
  "command.message.schedule.recurring-create.timezone.description":
    "IANAタイムゾーン（例：Asia/Tokyo、UTC）。省略時はWEFTの既定値",
  "command.message.schedule.cancel.description": "予約投稿を取り消します",
  "command.message.schedule.cancel.id.description": "予約ID",
  "command.message.schedule.status.description": "予約投稿の状態を表示します",
  "command.message.schedule.status.id.description": "予約ID",
  "command.message.schedule.list.description": "予約投稿の一覧を表示します",
  "command.message.schedule.edit.description": "予約投稿の内容を編集します",
  "command.message.schedule.edit.id.description": "予約ID",
  "command.message.schedule.reschedule.description": "単発予約の送信日時を変更します",
  "command.message.schedule.reschedule.id.description": "予約ID",
  "command.message.schedule.reschedule.after.description":
    "送信までの時間（afterとatのいずれかを指定）。例：30m、2h、7d",
  "command.message.schedule.reschedule.at.description":
    "WEFTの既定タイムゾーンでYYYY-MM-DD HH:mm（afterとatのいずれかを指定）",
  "command.message.schedule.recurrence-edit.description": "定期投稿の繰り返し設定を変更します",
  "command.message.schedule.recurrence-edit.id.description": "予約ID",
  "command.message.schedule.recurrence-edit.frequency.description":
    "daily（毎日）またはweekly（毎週）",
  "command.message.schedule.recurrence-edit.time.description": "24時間表記のHH:MM（例：09:30）",
  "command.message.schedule.recurrence-edit.weekdays.description":
    "曜日をカンマ区切り（例：mon,wed,fri）。frequency=dailyの場合は省略",
  "command.message.schedule.recurrence-edit.timezone.description":
    "IANAタイムゾーン（例：Asia/Tokyo、UTC）。省略時は変更しません",
  "command.choice.daily": "毎日",
  "command.choice.weekly": "毎週",
  "config.invalidTimezone": "IANAタイムゾーンを指定してください（例：Asia/Tokyo、UTC）。",
  "config.invalidPrefix":
    "クローズ用プレフィックスは制御文字を含まない1～20文字で指定してください。",
  "context.guild": "このコマンドはサーバー内でのみ使用できます。",
  "permission.manageGuild": "このコマンドには「サーバーの管理」権限が必要です。",
  "config.previewInvalid": "選択肢から表示モードを選んでください。",
  "config.previewUnconfirmed":
    "プレビューモードの変更結果を確認できませんでした。再試行する前に設定を確認してください。",
  "config.previewChanged": ({ mode, unchanged }) =>
    `リンクプレビューモード: ${mode}${unchanged ? "（変更なし）" : ""}`,
  "config.readFailed": "設定を取得できませんでした。時間をおいて再試行してください。",
  "config.disabled": "無効",
  "config.unknown": "不明",
  "config.show": ({ timezone, prefix, audit, automaticClose, mode }) =>
    `WEFTの既定タイムゾーン: ${timezone}\nクローズ用プレフィックス: ${prefix}\n${audit}\n${automaticClose}\nリンクプレビューモード: ${mode}`,
  "config.prefixDisabledAlready": "クローズ用プレフィックスはすでに無効です。",
  "config.prefixDisabled":
    "クローズ用プレフィックスを無効にしました。既存のスレッド名は変わりません。",
  "config.valueChanged": ({ timezone, value, unchanged }) =>
    `${timezone ? "WEFTの既定タイムゾーン" : "クローズ用プレフィックス"}${unchanged ? `は${value}です（変更なし）。` : `を${value}に変更しました。`}`,
  "config.changeUnconfirmed":
    "設定変更の結果を確認できませんでした。再試行する前に設定を確認してください。",
  "config.autoReadFailed":
    "自動クローズ設定を取得できませんでした。時間をおいて再試行してください。",
  "config.invalidInactivity": "5分～365日で指定してください（例：30m、12h、7d）。",
  "config.invalidParent": "テキスト・アナウンス・フォーラムチャンネルを指定してください。",
  "config.enablingParent": "このチャンネルの自動クローズを有効にしています…",
  "config.enumerationFailed":
    "スレッドを取得できなかったため、自動クローズを有効にしていません。時間をおいて再試行してください。",
  "config.noParents": "対象チャンネル: なし",
  "config.exclusionsApply": "スレッドごとの除外設定が優先されます。",
  "config.autoDisabled": ({ inactivity }) => `自動クローズ: 無効\n無投稿期間: ${inactivity}`,
  "config.autoSummary": ({ inactivity, count, botMessages }) =>
    `自動クローズ: 対象チャンネル${count}件／無投稿期間${inactivity}／ボットの投稿${botMessages ? "を含める" : "を含めない"}`,
  "config.autoThreshold": ({ inactivity }) => `無投稿期間: ${inactivity}`,
  "config.botActivity": ({ enabled }) => `ボットの投稿: ${enabled ? "含める" : "含めない"}`,
  "config.parents": ({ count, mentions, remaining }) =>
    `対象チャンネル（${count}件）: ${mentions}${remaining > 0 ? ` …ほか${remaining}件` : ""}`,
  "config.inactivityChanged": ({ inactivity, unchanged }) =>
    `${unchanged ? `無投稿期間は${inactivity}です（変更なし）。` : `無投稿期間を${inactivity}に変更しました。`}`,
  "config.botActivityChanged": ({ enabled, unchanged }) =>
    `ボットの投稿を${enabled ? "含める" : "含めない"}設定${unchanged ? "です（変更なし）。" : "に変更しました。"}`,
  "config.parentRemoved": ({ channelId, unchanged }) =>
    `<#${channelId}>の自動クローズは無効です${unchanged ? "（変更なし）" : ""}。`,
  "config.parentAlreadyEnabled": ({ channelId }) =>
    `<#${channelId}>の自動クローズはすでに有効です。`,
  "config.parentEnabled": ({ channelId, count }) =>
    `<#${channelId}>の自動クローズを有効にしました。${count === 0 ? "計測開始時刻の変更はありません。" : `${count}件のスレッドで無投稿期間の計測を開始しました。`}`,
  "config.auditDestination": ({ channelId }) =>
    `監査通知: ${channelId === null ? "無効" : `<#${channelId}>`}`,
  "config.auditReadFailed":
    "監査通知の設定を取得できませんでした。時間をおいて再試行してください。",
  "config.auditInvalid":
    "WEFTに「チャンネルを見る」「メッセージを送信」権限があるテキスト・アナウンスチャンネルを指定してください。",
  "config.auditUnconfirmed": "監査通知の変更は未確認です。再試行する前に設定を確認してください。",
  "config.auditDisabled": "監査通知を無効にしました。データベースへの監査記録の保存は継続します。",
  "config.auditAlreadyDisabled":
    "監査通知はすでに無効です。データベースへの監査記録の保存は継続します。",
  "config.auditChanged": ({ channelId, unchanged }) =>
    `監査通知の送信先は<#${channelId}>です${unchanged ? "（変更なし）" : ""}。`,
  "thread.unconfirmed":
    "最終結果を確認できませんでした。再試行する前にスレッドの現在の状態を確認してください。",
  "thread.actorPermission": "このコマンドには「スレッドの管理」権限が必要です。",
  "thread.botPermission": "現在の権限ではWEFTはこのスレッドを管理できません。",
  "thread.activeContext": "開いているスレッド内で使用してください。",
  "thread.locked":
    "ロックされたスレッドは閉じられません。手動でロックを解除してから再試行してください。",
  "thread.invalidName": "適用するクローズ用プレフィックスでは有効なスレッド名を作成できません。",
  "thread.failed":
    "スレッドの操作を完了できませんでした。再試行する前に現在の状態を確認してください。",
  "thread.context": "このコマンドは対応するスレッド内でのみ使用できます。",
  "thread.closing": "スレッドを閉じています…",
  "thread.opening": "開いているスレッドの状態を更新しています…",
  "thread.scheduling": "予約クローズを設定しています…",
  "thread.cancelling": "予約クローズを取り消しています…",
  "thread.tracking": "自動クローズの除外設定を解除しています…",
  "thread.untracking": "自動クローズから除外しています…",
  "thread.loadingStatus": "スレッドの状態を取得しています…",
  "thread.manualExecuting": "予約クローズが実行中のため、手動の操作は開始していません。",
  "thread.manualCancellationUnknown":
    "予約クローズの取消が未確認のため、スレッドの操作は開始していません。再試行する前に状態を確認してください。",
  "thread.closed": "スレッドを閉じました。",
  "thread.alreadyClosed": "スレッドはすでに閉じています。",
  "thread.pending":
    "WEFTが処理や結果確認を続けています。Discordのレート制限などで数分かかる場合があります。",
  "thread.opened": "開いているスレッドの状態をWEFTに反映しました。",
  "thread.alreadyOpen": "スレッドは開いています。変更はありません。",
  "thread.excluded": "自動クローズから除外しました。",
  "thread.alreadyExcluded": "すでに自動クローズから除外されています。",
  "thread.trackedEnabled": "除外設定を解除しました。このスレッドは自動クローズの対象です。",
  "thread.trackedDisabled":
    "除外設定を解除しました。親チャンネルの自動クローズが無効なため、このスレッドは対象外です。",
  "thread.alreadyTrackedEnabled": "除外設定はありません。このスレッドは自動クローズの対象です。",
  "thread.alreadyTrackedDisabled": "除外設定はありません。親チャンネルの自動クローズは無効です。",
  "thread.verifyFailed":
    "現在のスレッドまたは権限を確認できませんでした。時間をおいて再試行してください。",
  "thread.trackingUnknown":
    "除外設定の変更結果を確認できませんでした。再試行する前にスレッドの状態を確認してください。",
  "thread.statusFailed": "スレッドの状態を取得できませんでした。時間をおいて再試行してください。",
  "thread.trackingFailed":
    "自動クローズの除外設定を更新できませんでした。時間をおいて再試行してください。",
  "thread.notRecorded": "記録なし",
  "thread.none": "なし",
  "thread.executing": "実行中",
  "thread.baselineWarning":
    "記録時刻は計測開始時刻の場合があります。自動クローズは定期確認で実行します。",
  "thread.noSchedule": "予約クローズはありません。",
  "thread.cannotCancel": "予約クローズは実行中のため、取り消せません。",
  "thread.cancelUnknown":
    "予約クローズの取消は未確認です。再試行する前にスレッドの状態を確認してください。",
  "thread.invalidDuration": "1分～365日で指定してください（例：30m、2h、7d）。",
  "thread.scheduleActiveOnly": "予約クローズは開いているスレッドで設定してください。",
  "thread.scheduleLocked": "ロックを解除してから予約クローズを設定してください。",
  "thread.scheduleExecuting": "予約クローズが実行中です。完了後に再試行してください。",
  "thread.scheduleVerifyFailed":
    "スレッドの現在の状態を確認できませんでした。時間をおいて再試行してください。",
  "thread.scheduleUnknown":
    "予約クローズの保存は未確認です。再試行する前にスレッドの状態を確認してください。",
  "thread.status.effective": ({ enabled }) => `自動クローズ: ${enabled ? "対象" : "対象外"}`,
  "thread.status.parentPolicy": ({ enabled }) =>
    `親チャンネルの自動クローズ: ${enabled ? "有効" : "無効"}`,
  "thread.status.exclusion": ({ enabled }) => `除外設定: ${enabled ? "あり" : "なし"}`,
  "thread.status.inactivity": ({ inactivity }) => `無投稿期間: ${inactivity}`,
  "thread.status.activity": ({ when }) => `最終投稿または計測開始: ${when}`,
  "thread.status.scheduledClose": ({ when }) => `予約クローズ: ${when}`,
  "thread.schedule.cancelled": ({ id }) => `予約クローズ\`${id}\`を取り消しました。`,
  "thread.schedule.created": ({ id, when }) =>
    `予約クローズを設定しました。日時: ${when}\n予約ID: \`${id}\``,
  "thread.schedule.replaced": ({ id, when }) =>
    `予約クローズを変更しました。日時: ${when}\n予約ID: \`${id}\``,
  "thread.schedule.savedPending": ({ id, when }) =>
    `予約クローズ\`${id}\`を保存しました。日時: ${when}\n実行登録は未確認です。WEFTが自動で確認・調整します。`,
  "message.scheduleCreated": ({ id, channelId, when, pending }) =>
    `単発予約\`${id}\`を保存しました。送信先: <#${channelId}>\n送信日時: <t:${when}:F> (<t:${when}:R>)\n${pending ? "実行登録は未確認です。WEFTが自動で確認・調整します。" : ""}`.trimEnd(),
  "message.scheduleCancelled": ({ id, recurring, already, cleanupPending }) =>
    `${recurring ? "定期投稿" : "単発予約"}\`${id}\`${already ? "は取消済みです。" : "を取り消しました。"}${recurring ? "今後の投稿は予約されません。実行中の回は完了する場合があります。" : ""}${cleanupPending ? "実行待ち処理の停止は未確認です。WEFTが自動で確認・調整します。" : ""}`,
  "message.recurringCreated": ({ id, when, pending }) =>
    `定期投稿\`${id}\`を設定しました。初回: <t:${when}:F>\n${pending ? "実行登録は未確認です。WEFTが自動で確認・調整します。" : ""}`.trimEnd(),
  "message.recurrenceEdited": ({ id, deferred, pending }) =>
    `定期投稿\`${id}\`の繰り返し設定を変更しました。${deferred ? "実行中・再試行待ちの回には適用されません。次回はその処理が終わってから準備します。" : ""}${pending ? "実行登録は未確認です。WEFTが自動で確認・調整します。" : ""}`,
  "message.recurrenceUnchanged": ({ id }) => `定期投稿\`${id}\`の繰り返し設定に変更はありません。`,
  "message.schedulePayloadEdited": ({ id, recurring, unchanged }) =>
    `${recurring ? "定期投稿" : "単発予約"}\`${id}\`の内容${unchanged ? "に変更はありません。" : "を変更しました。"}${recurring ? "実行中・再試行待ちの回の内容は変わりません。" : ""}`,
  "message.rescheduled": ({ id, when, pending }) =>
    `単発予約\`${id}\`の送信日時を変更しました。\n<t:${when}:F> (<t:${when}:R>)\n${pending ? "実行登録は未確認です。WEFTが自動で確認・調整します。" : ""}`.trimEnd(),
  "message.sent": ({ id }) => `管理メッセージ\`${id}\`を送信しました。`,
  "message.managementUnconfirmed": ({ id }) =>
    `メッセージ\`${id}\`は送信済みですが、WEFTへの登録は未確認です。削除は試みていません。再試行や削除の前に状態を確認してください。`,
  "message.removalRejected": ({ id }) =>
    `メッセージ\`${id}\`は送信済みですが、WEFTでの確認・記録を完了できませんでした。取り消すための削除も拒否されました。次の操作の前に状態を確認し、必要なら手動で削除してください。`,
  "message.removalUnconfirmed": ({ id }) =>
    `メッセージ\`${id}\`は送信済みですが、WEFTでの確認・記録を完了できませんでした。削除結果も未確認です。残っている可能性があるため、再試行や削除の前に確認してください。`,
  "message.edited": ({ id }) => `管理メッセージ\`${id}\`を編集しました。`,
  "message.unchanged": ({ id }) => `管理メッセージ\`${id}\`の内容に変更はありません。`,
  "message.deletionUnconfirmed": ({ id }) =>
    `メッセージ\`${id}\`は見つかりませんでしたが、WEFTへの削除記録は未確認です。管理者に確認を依頼してください。`,
  "message.editPartial": ({ id }) =>
    `メッセージ\`${id}\`は編集済みですが、WEFTへの記録も元の内容への復元も未確認です。管理者にメッセージと記録の確認を依頼してください。`,
  "message.contentLabel": "本文",
  "message.contentDescription":
    "本文、埋め込みのタイトル・説明文・画像URLのいずれかを入力してください。",
  "message.embedTitleLabel": "埋め込みのタイトル",
  "message.embedDescriptionLabel": "埋め込みの説明文",
  "message.embedColorLabel": "カラーコード",
  "message.embedColorDescription": "例：#FF0000、FF0000",
  "message.embedImageLabel": "画像URL",
  "message.embedImageDescription": "http://またはhttps://で始まる画像URL",
  "message.sendModalTitle": "管理メッセージの送信",
  "message.editModalTitle": "管理メッセージの編集",
  "message.scheduleModalTitle": "投稿を予約",
  "message.recurringModalTitle": "定期投稿の設定",
  "message.scheduleEditModalTitle": "予約投稿の編集",
  "message.formFailed": "フォームを開けませんでした。時間をおいて再試行してください。",
  "message.scheduleContext":
    "サーバーのテキスト・アナウンスチャンネルか、スレッドで使用してください。",
  "message.context":
    "サーバーのテキスト・アナウンスチャンネルか、開いているスレッドで使用してください。",
  "message.managePermission": "「メッセージの管理」権限が必要です。",
  "message.timezoneTooLong": "このフォームではタイムゾーンの指定が長すぎます。",
  "message.scheduleReadFailed": "予約投稿を取得できませんでした。時間をおいて再試行してください。",
  "message.referenceScope": "このサーバーの同じチャンネルにあるメッセージを指定してください。",
  "message.invalidReference": "メッセージIDまたはメッセージリンクを指定してください。",
  "message.deletedTarget": "指定した管理メッセージは削除されています。",
  "message.readFailed": "管理メッセージを取得できませんでした。時間をおいて再試行してください。",
  "message.notFound": "このチャンネルでは、指定したメッセージの管理記録が見つかりません。",
  "message.invalidFrequency": "frequencyはdailyまたはweeklyを指定してください。",
  "message.invalidTime": "timeはHH:MM形式で指定してください（例：09:30）。",
  "message.invalidWeekdays":
    "weekdaysにはmon,tue,wed,thu,fri,sat,sunを使用できます。frequency=weeklyでは1つ以上を重複なしでカンマ区切りにし、frequency=dailyでは省略してください。",
  "message.invalidTimezone":
    "timezoneはIANAタイムゾーンを指定してください（例：Asia/Tokyo、UTC）。数値オフセットは使用できません。",
  "message.invalidRecurrence":
    "frequency、time（HH:MM）、weekdays、timezoneの入力を確認してください。",
  "message.emptyContent": "本文、埋め込みのタイトル・説明文・画像URLのいずれかを入力してください。",
  "message.contentTooLong": "メッセージ本文は2000文字以内にしてください。",
  "message.embedTitleTooLong": "埋め込みのタイトルは256文字以内にしてください。",
  "message.embedDescriptionTooLong": "埋め込みの説明は4000文字以内にしてください。",
  "message.invalidEmbedColor":
    "カラーコードは6桁の16進数で指定してください（例：#FF0000、FF0000）。",
  "message.embedColorOnly":
    "埋め込みは色の指定のみでは送信できません。タイトル・説明文・画像URLのいずれかも入力してください。",
  "message.embedImageTooLong": "埋め込みの画像URLは2048文字以内にしてください。",
  "message.invalidEmbedImage": "http://またはhttps://で始まる画像URLを入力してください。",
  "message.scheduleTarget":
    "このサーバーのテキスト・アナウンスチャンネルか、開いているスレッドで予約してください。",
  "message.scheduleArchived": "閉じているスレッドでは投稿を予約できません。",
  "message.schedulePermissionLost": "投稿の予約に必要な「メッセージの管理」権限がありません。",
  "message.sendBotPermission": "現在の権限ではWEFTはこのチャンネルにメッセージを送信できません。",
  "message.channelCheckFailed":
    "現在のチャンネルまたは権限を確認できませんでした。時間をおいて再試行してください。",
  "message.scheduleSaveUnconfirmed":
    "予約の保存は未確認です。実行登録は行っていません。再試行する前に予約を確認してください。",
  "message.cancelExecuting": "予約投稿は実行中のため、取り消せません。",
  "message.scheduleCompleted": "予約投稿は完了済みです。",
  "message.scheduleFailed": "予約投稿は失敗しています。",
  "message.scheduleNotFound": "このチャンネルでは指定されたIDの予約投稿が見つかりません。",
  "message.cancelUnconfirmed":
    "取消結果を確認できませんでした。再試行する前に予約を確認してください。",
  "message.scheduleConflict":
    "予約投稿が同時に変更されました。再試行する前に内容を確認してください。",
  "message.guildTimezoneInvalid":
    "WEFTの既定タイムゾーンが無効、または取得できませんでした。設定を確認するか、タイムゾーンを指定してください。",
  "message.recurringSaveUnconfirmed":
    "定期投稿の保存は未確認です。実行登録は行っていません。再試行する前に予約を確認してください。",
  "message.recurringUnavailable": "定期投稿は一時的に利用できません。",
  "message.oneTimeUseReschedule":
    "これは単発予約です。/message schedule rescheduleを使用してください。",
  "message.recurringConflict":
    "定期投稿が同時に変更されました。再試行する前に内容を確認してください。",
  "message.recurringNotFound": "このチャンネルでは指定されたIDの定期投稿が見つかりません。",
  "message.recurrenceUnconfirmed":
    "繰り返し設定の編集結果を確認できませんでした。再試行する前に予約を確認してください。",
  "message.recurringReadFailed": "定期投稿を取得できませんでした。時間をおいて再試行してください。",
  "message.timestampNote": "日時は閲覧者のタイムゾーンで表示されます。",
  "message.scheduledFor": "送信予定日時",
  "message.executingScheduledFor": "実行中の送信予定日時",
  "message.originalScheduledFor": "元の送信予定日時",
  "message.scheduleCorrupt": "予約投稿の状態に不整合があります。管理者による確認が必要です。",
  "message.scheduleStatusFailed":
    "予約投稿の状態を取得できませんでした。時間をおいて再試行してください。",
  "message.editExecuting": "予約投稿は実行中のため、編集できません。",
  "message.scheduleAlreadyCancelled": "予約投稿は取消済みです。",
  "message.scheduleEditConflict":
    "フォームを開いた後に予約投稿が変更されました。新しいフォームを開いて再試行してください。",
  "message.scheduleEditUnconfirmed":
    "予約投稿の編集結果を確認できませんでした。再試行する前に現在の予約を確認してください。",
  "message.unexpectedScheduleEdit":
    "予約内容の編集結果を確認できませんでした。再試行する前に現在の予約を確認してください。",
  "message.recurringUseRecurrenceEdit":
    "これは定期投稿です。/message schedule recurrence-editを使用してください。",
  "message.rescheduleConflict":
    "予約投稿が同時に変更されました。内容を確認して日時変更を再試行してください。",
  "message.rescheduleUnconfirmed":
    "日時変更の結果を確認できませんでした。再試行する前に現在の予約を確認してください。",
  "message.rescheduleExecuting": "予約投稿は実行中のため、日時を変更できません。",
  "message.unexpectedReschedule":
    "送信日時の変更結果を確認できませんでした。再試行する前に現在の予約を確認してください。",
  "message.sendArchived": "閉じているスレッドにはメッセージを送信できません。",
  "message.sendPermission": "WEFTからの送信には「メッセージの管理」権限が必要です。",
  "message.sendRejected":
    "Discordがメッセージの送信を拒否しました。メッセージは送信されていません。",
  "message.sendUnconfirmed":
    "Discordでメッセージが送信されたか確認できませんでした。再試行する前にチャンネルを確認してください。",
  "message.alreadyAbsent":
    "送信後の確認・記録を完了できませんでした。メッセージは確認時点では存在しませんでした。",
  "message.sendCompensated": "送信後の確認・記録を完了できなかったため、メッセージを削除しました。",
  "message.deletionDetected":
    "Discordのメッセージはすでに存在せず、WEFTで削除済みとして記録しました。",
  "message.editConflict":
    "フォームを開いた後にメッセージが変更されました。新しいフォームを開いて再試行してください。",
  "message.editPermissionLost": "編集に必要な「メッセージの管理」権限がありません。",
  "message.stateMismatch":
    "Discord上のこのメッセージがWEFTの記録と一致しません。編集する前に管理者による確認が必要です。",
  "message.editArchived": "閉じているスレッドではメッセージを編集できません。",
  "message.invalidEditableTarget":
    "このチャンネルでWEFTが編集できるメッセージか確認できませんでした。",
  "message.editBotPermission": "現在の権限ではWEFTはこのメッセージを編集できません。",
  "message.messageCheckFailed":
    "現在のメッセージまたは権限を確認できませんでした。時間をおいて再試行してください。",
  "message.editRejected": "Discordがメッセージの編集を拒否しました。",
  "message.editNotApplied": "Discordは編集を適用しませんでした。WEFTの記録は変更していません。",
  "message.editUnconfirmed":
    "Discordで編集が適用されたか確認できませんでした。管理者による確認が必要です。",
  "message.stateCheckFailed": "WEFTの記録を確認できませんでした。時間をおいて再試行してください。",
  "message.editCompensated":
    "WEFTへの編集記録が未確認のため、メッセージを変更前の内容に復元しました。",
  "message.editFormExpired": "このメッセージ編集フォームは無効か期限切れです。",
  "message.scheduleFormExpired": "この予約投稿のフォームは無効か期限切れです。",
  "message.recurringFormExpired": "この定期投稿のフォームは無効か期限切れです。",
  "message.scheduleEditFormExpired": "この予約投稿の編集フォームは無効か期限切れです。",
  "message.status.creator": ({ id }) => `作成者: <@${id}> (\`${id}\`)`,
  "message.status.weekdays": ({ days }) => `曜日: ${days}\n`,
  "message.status.recurring": ({ id }) => `定期投稿\`${id}\``,
  "message.status.oneTime": ({ id }) => `単発予約\`${id}\``,
  "message.status.series": ({ state }) => `定期投稿の状態: ${state}`,
  "message.status.state": ({ state }) => `状態: ${state}`,
  "message.status.occurrenceState": ({ state }) => `実行回の状態: ${state}`,
  "message.status.target": ({ id }) => `送信先: <#${id}>`,
  "message.status.revision": ({ revision }) => `リビジョン: ${revision}`,
  "message.status.recurrence": ({ daily }) => `繰り返し設定: ${daily ? "毎日" : "毎週"}`,
  "message.status.localTime": ({ days, time }) => `${days}現地時刻: ${time}`,
  "message.status.timezone": ({ timezone }) => `予約のタイムゾーン: ${timezone}`,
  "message.status.occurrence": ({ id }) => `現在の実行回: ${id === null ? "なし" : `\`${id}\``}`,
  "message.status.occurrenceRetries": ({ count }) => `実行回の再試行回数: ${count ?? "なし"}`,
  "message.status.retries": ({ count }) => `再試行回数: ${count}`,
  "message.status.link": ({ guildId, channelId, messageId }) =>
    `メッセージ: https://discord.com/channels/${guildId}/${channelId}/${messageId}`,
  "message.none": "なし",
  "schedule.error.MISSING_SELECTOR": "afterとatのいずれかを指定してください。",
  "schedule.error.CONFLICTING_SELECTORS":
    "afterとatのいずれかを指定してください。両方は指定できません。",
  "schedule.error.INVALID_DURATION": "1m～365dで指定してください（例：30m、2h、7d）。",
  "schedule.error.INVALID_AT_FORMAT":
    "WEFTの既定タイムゾーンでYYYY-MM-DD HH:mm形式を指定してください。",
  "schedule.error.INVALID_AT_DATE": "存在する日付を指定してください。",
  "schedule.error.INVALID_GUILD_TIMEZONE":
    "日時を指定する前に、WEFTの既定タイムゾーンを設定してください。",
  "schedule.error.TIMEZONE_UNAVAILABLE":
    "WEFTの既定タイムゾーンを取得できませんでした。時間をおいて再試行してください。",
  "schedule.error.DST_GAP":
    "設定されたタイムゾーンには存在しない時刻です。別の時刻を指定してください。",
  "schedule.error.DST_OVERLAP":
    "設定されたタイムゾーンで2回現れる時刻です。別の時刻を選ぶか、afterを使ってください。",
  "schedule.error.TOO_SOON": "メッセージは1分以上先の日時に予約してください。",
  "schedule.error.TOO_FAR": "現在時刻から365日以内の日時を指定してください。",
  "list.unavailable": "予約投稿を取得できませんでした。時間をおいて再試行してください。",
  "list.restart": "この一覧操作は無効です。/message schedule listを再実行してください。",
  "list.display_error": "ページ全体を表示できなかったため、予約を表示していません。",
  "list.previous": "前へ",
  "list.next": "次へ",
  "list.capacity": "開いている予約一覧が多いため、時間をおいて再試行してください。",
  "list.time.historicalCompact": "取消前予定",
  "list.time.historical": "取消前の予定日時",
  "list.time.nextCompact": "次回予定",
  "list.time.next": "次回の予定日時",
  "list.time.lastCompact": "直近の予定",
  "list.time.last": "直近の予定日時",
  "list.time.currentCompact": "今回予定",
  "list.time.current": "今回の予定日時",
  "list.invalidPage": "ページは正の整数で指定してください。",
  "list.none": "なし",
  "list.empty": ({ page }) => `${page}ページ目に有効・実行中の予約投稿はありません。`,
  "list.header": ({ page }) => `予約投稿 — ${page}ページ目`,
  "list.oneTimeRow": ({ id, state, when, creator }) =>
    `- \`${id}\` 単発 · ${state}\n  予定: <t:${when}:F> · 作成者: ${creator}`,
  "list.recurringRow": ({ id, daily, state, occurrence, label, when, creator }) =>
    `- \`${id}\` 定期投稿 ${daily ? "毎日" : "毎週"}\n予約: ${state} · 実行回: ${occurrence}\n${label}: <t:${when}:F> · 作成者: ${creator}`,
  "bulk.controlFailure": "この一括クローズ操作は無効です。/thread bulk-closeを再実行してください。",
  "bulk.preparationFailure": "候補を表示できませんでした。/thread bulk-closeを再実行してください。",
  "bulk.nameFilter": ({ name }) => `スレッド名に含む文字列（大文字・小文字を区別）: ${name}`,
  "bulk.ownerFilter": ({ id }) => `作成者ID: ${id}`,
  "bulk.ageFilter": ({ minutes, cutoff }) =>
    `作成から${minutes}分以上経過\n作成日時の上限: <t:${cutoff}:F>`,
  "bulk.candidate": ({ ordinal }) => `候補${ordinal}`,
  "bulk.threadLink": ({ ordinal, name, guildId, threadId }) =>
    `${ordinal}. ${name} • [開く](https://discord.com/channels/${guildId}/${threadId})`,
  "bulk.unavailableThread": ({ ordinal }) => `${ordinal}. 対象を表示できません。`,
  "bulk.footer": ({ page, pages, candidates, selected }) =>
    `${page}/${pages}ページ • 候補: ${candidates}件 • 選択: ${selected}件`,
  "bulk.selectPlaceholder": "このページのスレッドを選択",
  "bulk.unnamedThread": "名前のないスレッド",
  "bulk.targetUnavailable": "対象を表示できません",
  "bulk.previous": "前へ",
  "bulk.next": "次へ",
  "bulk.clearPage": "このページの選択を解除",
  "bulk.confirm": "選択したスレッドを一括クローズ",
  "bulk.cancel": "キャンセル",
  "bulk.selectionGuidance":
    "対象を選択して一括クローズを実行してください。他ページの選択も対象です。",
  "bulk.title": "スレッドの一括クローズ",
  "bulk.parent": "親チャンネル",
  "bulk.conditions": "条件（すべてに一致）",
  "bulk.noFilters": "なし。対象を手動で選んでください。",
  "bulk.beforeConfirm": "実行前の確認",
  "bulk.closeWarning": "• プレフィックスが有効なら付加し、スレッドを閉じます。",
  "bulk.cancelWarning":
    "• 予約クローズを取り消す場合があります。閉じる処理が失敗しても予約は戻りません。",
  "bulk.partialWarning":
    "• 状態・条件・権限の変化でスキップや失敗が起こり、一部だけ完了する場合があります。後から完了する処理もあります。",
  "bulk.snapshotWarning": "• 候補は固定です。後から条件に合ったスレッドは追加されません。",
  "bulk.expires": "有効期限",
  "bulk.setupTitle": "スレッドの一括クローズ設定",
  "bulk.owner": "スレッドの作成者",
  "bulk.nameContains": "スレッド名に含む文字列",
  "bulk.nameDescription": "スレッド名の一部を指定。大文字・小文字を区別します",
  "bulk.createdOlder": "作成からの経過時間",
  "bulk.ageDescription": "指定時間以上前に作成されたスレッドが対象（例：30m、2h、7d）",
  "bulk.invalidSetup": "親チャンネルを1つ選び、絞り込み条件を確認してください。",
  "bulk.preparing": "一括クローズのプレビューを準備しています…",
  "bulk.confirmed": "一括クローズを開始しました。結果は別のメッセージで表示します。",
  "bulk.cancelled": "一括クローズをキャンセルしました。",
  "bulk.cancelledNoWork": "一括クローズをキャンセルしました。対象への操作は開始していません。",
  "bulk.result": ({ selected, attempted, closed, alreadyClosed, pending, failed, skipped }) =>
    `一括クローズの結果\n選択: ${selected}件\n開始: ${attempted}件\n閉じた対象: ${closed}件\nすでに閉じていた対象: ${alreadyClosed}件\n処理継続中: ${pending}件\n失敗または結果未確認: ${failed}件\nスキップ: ${skipped}件\n処理継続中の対象はWEFTが対応を続けます。失敗または結果未確認でも変更済みの場合があります。再試行前に確認してください。スキップした対象の操作は開始していません。`,
  "bulk.invalidFilter": "作成からの経過時間は1分～365日で指定してください（例：30m、2h、7d）。",
  "bulk.unavailable": "選択した親チャンネルまたは現在の管理権限を確認できませんでした。",
  "bulk.empty": "条件に合う、開いているスレッドはありません。",
  "bulk.tooMany": "対象のスレッドが50件を超えています。条件を絞って再試行してください。",
  "bulk.capacity": "一括クローズ画面が上限に達しています。期限切れになるまでお待ちください。",
  "preview.failure": "WEFTはこのメッセージを表示できませんでした。",
  "preview.empty": "プレビューに表示できる内容がありません。",
  "preview.spoiler": "[ネタバレ部分を省略]",
  "preview.button": "プレビュー",
  "preview.original": "元のメッセージを開く",
  "preview.numberedButton": ({ ordinal }) => `プレビュー${ordinal}`,
  "preview.more": ({ count }) => `ほか${count}件`,
  "preview.userMention": ({ id }) => `@ユーザー:${id}`,
  "preview.roleMention": ({ id }) => `@ロール:${id}`,
  "preview.channelMention": ({ id }) => `#チャンネル:${id}`,
  "audit.label.source": "種別",
  "audit.label.event": "イベント",
  "audit.label.outcome": "結果",
  "audit.label.actor": "実行者の種類",
  "audit.label.actorId": "実行ユーザーID",
  "audit.label.threadId": "スレッドID",
  "audit.label.channelId": "チャンネルID",
  "audit.label.messageId": "メッセージID",
  "audit.label.scheduleId": "予約アクションID",
  "audit.label.occurrenceId": "実行回ID",
  "audit.label.failureCode": "失敗コード",
  "audit.label.failureStage": "失敗段階",
  "audit.label.discordEvidence": "Discord操作の確認状況",
  "audit.label.databaseEffect": "データベースへの反映",
  "audit.label.compensationEvidence": "取消・復元の確認状況",
  "audit.label.skipReason": "スキップ理由",
  "audit.label.previousDestination": "変更前の送信先ID",
  "audit.label.newDestination": "変更後の送信先ID",
  "audit.label.previousMode": "変更前のモード",
  "audit.label.newMode": "変更後のモード",
  "audit.label.setting": "設定項目",
  "audit.label.targetType": "対象の種類",
  "audit.label.targetId": "対象ID",
  "audit.label.auditId": "監査ID",
  "audit.title": "WEFTの監査通知",
  "audit.occurredAt": ({ when }) => `発生日時: \`${when}\``,
  "audit.reason.rename": "WEFTによるスレッド名の更新",
  "audit.reason.close": "WEFTによるスレッドのクローズ",
} satisfies TranslationCatalog;
