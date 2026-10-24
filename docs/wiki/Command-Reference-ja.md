# コマンド一覧

[ホーム](Home-ja) · [コマンド一覧](Command-Reference-ja) · [トラブルシューティング](Troubleshooting-ja) · [English](Command-Reference)

全**32操作**の正確な構文・入力・権限・結果を確認できます。種類ごとにコマンドを調べる場合は下の分類表、名前が分かっている場合は[全コマンドの索引](#all-commands)を使用してください。一連の手順を学ぶための機能ガイドは、別の列にまとめています。

<a id="choose-a-command-family"></a>

## コマンドの種類を選ぶ

| 種類       | 操作数 | コマンド一覧・詳細                              | 機能ガイド                                                                                                           |
| ---------- | ------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `/config`  | 14     | [設定コマンドの詳細](Commands-Config-ja)        | [サーバー設定](Configuration-ja)、[自動クローズ](Automatic-Close-ja)                                                 |
| `/thread`  | 8      | [スレッドコマンドの詳細](Commands-Thread-ja)    | [スレッド管理](Thread-Lifecycle-ja)、[予約クローズ](Scheduled-Thread-Close-ja)、[一括クローズ](Bulk-Thread-Close-ja) |
| `/message` | 10     | [メッセージコマンドの詳細](Commands-Message-ja) | [管理メッセージ](Managed-Messages-ja)、[予約投稿](Scheduled-Messages-ja)                                             |

すべてサーバー内専用です。実行者には、`/config`ではサーバーの管理（`ManageGuild`）、`/thread`ではスレッドの管理（`ManageThreads`）、`/message`ではメッセージの管理（`ManageMessages`）が必要です。Administratorは要求しません。対象の場所とWEFT自身の現在の権限は各詳細で確認してください。コマンドの表示だけでは実行許可になりません。

<a id="read-syntax"></a>

## 構文と例の読み方

構文欄の`command option:<value>`は説明用の表記であり、全体をコピーして実行する入力文字列ではありません。`<...>`は置き換える値、任意引数の`[...]`は省略可能な項目です。これらの括弧は入力しません。

1. 操作するサーバー・チャンネル・スレッドを確認し、`/`からWEFTのコマンド候補を選びます。コマンド名・引数名は英日共通です。
2. 通常の文字列引数は、該当する入力欄に値を入力します。日時などの空白を含む値も、その欄へ引用符なしで入力します。
3. choices付き文字列引数は、表示された選択肢を選びます。表示名はDiscordの言語に応じて変わり、内部の値とは異なる場合があります。値だけを書いたコマンド全体の貼り付けを操作手順として扱わないでください。
4. Channel引数は対象チャンネルを候補から選び、Boolean引数は真偽値を選びます。`#support`のような例は対象の説明であり、固定の文字列ではありません。
5. コマンドを実行します。フォームが開く操作では、入力後のフォーム送信で変更を依頼します。一括クローズはさらに候補選択と確定が必要です。

現在の32操作にautocomplete、Integer、Number、User型のスラッシュ引数はありません。`/thread bulk-close`の「親チャンネル」「スレッドの作成者」（英語ではParent・Owner）はフォーム内のChannel・User選択欄です。`/message schedule list`のページ移動はボタンです。

`after`・`at`が個々には任意でも、該当する操作ではどちらか1つが必要です。`frequency`で「毎週」を選ぶと`weekdays`も必要ですが、`weekdays`自体はカンマ区切りの文字列入力です。各コマンドの引数表で登録上の必須・任意と実行時の条件を確認してください。予約ID・投稿IDは実際の対象のものを使います。日付の例は書式を示すもので、実行時には範囲内の有効な未来の日時を選びます。

<a id="all-commands"></a>

## 個別コマンドを索引から探す

各項目から、そのコマンドの詳細へ直接移動できます。同じ種類のコマンドを比較する場合は、上の分類表からコマンド一覧を開いてください。

### /config

| コマンド                                                                                 | 確認する内容           |
| ---------------------------------------------------------------------------------------- | ---------------------- |
| [`/config show`](Commands-Config-ja#config-show)                                         | 設定の概要             |
| [`/config timezone`](Commands-Config-ja#config-timezone)                                 | 既定タイムゾーン       |
| [`/config closed-prefix set`](Commands-Config-ja#config-closed-prefix-set)               | プレフィックスの設定   |
| [`/config closed-prefix disable`](Commands-Config-ja#config-closed-prefix-disable)       | プレフィックスの無効化 |
| [`/config link-preview show`](Commands-Config-ja#config-link-preview-show)               | 現在のプレビューモード |
| [`/config link-preview mode`](Commands-Config-ja#config-link-preview-mode)               | プレビューモードの変更 |
| [`/config audit-log show`](Commands-Config-ja#config-audit-log-show)                     | 保存済み監査通知先     |
| [`/config audit-log set`](Commands-Config-ja#config-audit-log-set)                       | 監査通知先の設定       |
| [`/config audit-log disable`](Commands-Config-ja#config-audit-log-disable)               | 監査通知の無効化       |
| [`/config auto-close show`](Commands-Config-ja#config-auto-close-show)                   | 自動クローズの設定     |
| [`/config auto-close inactivity`](Commands-Config-ja#config-auto-close-inactivity)       | 無投稿期間             |
| [`/config auto-close bot-messages`](Commands-Config-ja#config-auto-close-bot-messages)   | ボット投稿の活動判定   |
| [`/config auto-close add-parent`](Commands-Config-ja#config-auto-close-add-parent)       | 親の有効化             |
| [`/config auto-close remove-parent`](Commands-Config-ja#config-auto-close-remove-parent) | 親の無効化             |

### /thread

| コマンド                                                         | 確認する内容                               |
| ---------------------------------------------------------------- | ------------------------------------------ |
| [`/thread close`](Commands-Thread-ja#thread-close)               | ロックしないアーカイブ                     |
| [`/thread open`](Commands-Thread-ja#thread-open)                 | 開いた状態の反映（アーカイブ解除は対象外） |
| [`/thread status`](Commands-Thread-ja#thread-status)             | 設定と現在の予約クローズ                   |
| [`/thread track`](Commands-Thread-ja#thread-track)               | 個別除外の解除                             |
| [`/thread untrack`](Commands-Thread-ja#thread-untrack)           | 個別除外の追加                             |
| [`/thread close-after`](Commands-Thread-ja#thread-close-after)   | 予約クローズの作成・置換                   |
| [`/thread cancel-close`](Commands-Thread-ja#thread-cancel-close) | 待機中の予約クローズの取消                 |
| [`/thread bulk-close`](Commands-Thread-ja#thread-bulk-close)     | 確認・選択後の一括クローズ                 |

### /message

| コマンド                                                                                      | 確認する内容                 |
| --------------------------------------------------------------------------------------------- | ---------------------------- |
| [`/message send`](Commands-Message-ja#message-send)                                           | 管理メッセージの作成         |
| [`/message edit`](Commands-Message-ja#message-edit)                                           | 管理メッセージの編集         |
| [`/message schedule create`](Commands-Message-ja#message-schedule-create)                     | 単発予約の作成               |
| [`/message schedule recurring-create`](Commands-Message-ja#message-schedule-recurring-create) | 毎日・毎週の定期投稿の作成   |
| [`/message schedule list`](Commands-Message-ja#message-schedule-list)                         | 終了していない予約の一覧     |
| [`/message schedule status`](Commands-Message-ja#message-schedule-status)                     | 予約1件の確認                |
| [`/message schedule edit`](Commands-Message-ja#message-schedule-edit)                         | 保存済み本文・埋め込みの変更 |
| [`/message schedule reschedule`](Commands-Message-ja#message-schedule-reschedule)             | 単発の送信日時の変更         |
| [`/message schedule recurrence-edit`](Commands-Message-ja#message-schedule-recurrence-edit)   | 繰り返し設定の変更           |
| [`/message schedule cancel`](Commands-Message-ja#message-schedule-cancel)                     | 予約・定期投稿の取消         |
