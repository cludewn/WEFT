# 更新と運用

[ホーム](Home-ja) · [コマンド一覧](Command-Reference-ja) · [トラブルシューティング](Troubleshooting-ja) · [English](Operations)

導入済みのWEFTを保守するホスト運用者向けの手順です。アプリは同時に1台だけ稼働させます。正常停止・マイグレーション中もPostgreSQLを起動しておいてください。

日常の確認には次の手順を使い、保守の前には[正常停止を確認](#stop-and-verify)してください。更新する場合は[更新手順](#upgrade-in-order)へ進みます。再起動後は、readinessに加えて[遅延処理も確認](#restart-and-delayed-work)します。

<a id="observe-health-and-logs"></a>

## 通常の稼働を確認する

1. 対象のComposeチェックアウトで`docker compose ps`を実行し、コンテナ状態を確認します。
2. [コンテナ内のreadiness確認](Installation-and-Setup-ja#verify-the-first-run)を実行します。
3. [アプリのログの確認方法](#inspect-operation-logs)に従い、非公開ログで起動・実行結果・停止のイベントを調べます。
4. 更新・再起動後は、見当たらない処理を代替作成する前に[遅延処理の確認](#restart-and-delayed-work)へ進みます。

| 確認先・応答状態    | HTTPステータス・応答            | 確認できること                                                                                         |
| ------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /health/live`  | 200、`{"status":"alive"}`       | ローカルのヘルス監視用HTTPサーバーが応答しています。依存先は調べません。                               |
| `GET /health/ready` | 200、`{"status":"ready"}`       | 起動が`READY`に達し、Discordクライアントが利用可能な状態で、読取専用DBクエリが成功したことを示します。 |
| readinessが不成立   | 503、`{"status":"unavailable"}` | いずれかの条件を確認できていません。下記のアプリログで調べます。                                       |

readinessだけでは予約の実行やDiscordと保存状態の一致は確認できません。不成立の場合は、[起動・readinessの調査](Troubleshooting-ja#startup-migration-or-readiness-failure)へ進んでください。ログは非公開とし、設定、トークン、接続文字列、本文、未加工のエラーを公開しないでください。確認の範囲や間隔は[ヘルス監視の制限](#health-check-limits)で説明します。

<a id="inspect-operation-logs"></a>

## アプリのログで処理を調べる

ホスト運用者は、アプリコンテナが出力するJSON形式のログを読めます。対象のComposeプロジェクトから、次の読取専用コマンドを実行します。`30m`は、最初の操作と再起動があればその時刻も含む期間へ調整してください。

```sh
docker compose logs --since 30m --no-color app
```

ここでも導入環境のプロジェクト名・設定ファイル・Composeファイルの指定を使用します。`event`欄を読み、操作日時と、記録されていれば`guildId`（サーバーID）、`threadId`（スレッドID）、`scheduledActionId`（予約ID）、`occurrenceId`（定期投稿の実行回ID）を保存した応答と照合します。すべてのイベントに全IDがあるわけではありません。これはWEFTの処理を調べるログであり、[DBの監査履歴](Audit-and-Privacy-ja#audit-storage-reference)やDiscord通知とは別です。

- **起動・停止:** `application_ready`は起動完了、`startup_step_failed`の`startupStep`は失敗した起動段階です。停止は`shutdown_completed`・`shutdown_timed_out`も照合します。

- **結果不明のクローズ・状態反映:** `thread_lifecycle_failed`・`thread_lifecycle_outcome_unknown`の対象ID、操作、`failureCode`を確認します。`thread_lifecycle_reconciliation_`で始まるイベントは、結果確認のためDiscordを再取得する処理です。警告では対象取得不能・読取拒否・再確認の予定などを調べられますが、元の変更が拒否された証明ではありません。

- **自動クローズ:** `automatic_close_candidate_execution_failed`の対象ID、`outcome`（結果）、`failureCode`を確認します。`automatic_close_sweep_scan_failed`は候補ページの取得失敗です。`automatic_close_sweep_completed`は集計で、候補0件なら出力しません。

- **予約クローズの実行:** `scheduled_thread_close_execution_finished`の`scheduledActionId`、`outcome`、該当時の`reason`・`failureCode`を、実際のスレッドと予約に照合します。

- **保存したクローズ予約の実行準備:** `scheduled_thread_close_startup_recovery_completed`・`scheduled_thread_close_runtime_reconciliation_completed`は、起動時・定期確認で保存予約から実行指示を再登録する処理の集計です。末尾が`_failed`なら確認処理の失敗を調べます。集計の完了は、個別スレッドのクローズ完了ではありません。

- **予約投稿・定期投稿:** `scheduled_message_execution_finished`の予約IDと結果、`recurring_execution_finished`の実行回IDと結果を確認します。`recurring_execution_unconfirmed`は結果を確定できなかった状態です。代替投稿の前にlist・statusと実際の投稿先も照合します。

- **監査通知の不達:** `audit_notification_delivery`の`source`（監査の種類）、`auditId`、`outcome`と、記録があれば送信先・サーバーIDを確認します。元の管理操作の失敗を示すイベントではありません。

既定の`LOG_LEVEL=info`では、`thread_lifecycle_pending`や個別処理段階など、debug専用の詳細は出力しません。設定したレベルによってはさらに記録が減り、古いコンテナのログを取得できない場合もあります。該当行がないことは成功・失敗・処理なしの証明ではありません。結果不明の変更を再現する目的で再起動やログ設定変更を行わないでください。応答・現在のDiscord状態・取得できたログでも解決しない場合は、その情報を保存し、DBを調査できる運用者が該当する保存記録を調べます。全スレッド操作の進捗表示や監査履歴検索を行うスラッシュコマンドはありません。

ログは非公開で保管します。共有するのは必要なイベント欄を安全に伏せたものだけとし、認証情報・本文・設定全体を公開しないでください。

<a id="stop-and-verify"></a>

## アプリを停止して正常終了を確認する

意図したComposeプロジェクトから実行します。

```sh
stop_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose stop -t 45 app
docker compose ps -a app
docker compose ps postgres
docker compose logs --since "$stop_started_at" --no-color app
```

アプリが終了コード0で停止し、この停止に対応したshutdown_completedがあり、PostgreSQLが動き続けていることを確認します。
docker compose stopの成功だけで正常終了とは判断できません。WEFTは全体で30秒の終了期限、コンテナは45秒の猶予を持ちます。
期限超過や終了処理の失敗では0以外の終了コードを返します。その結果だけで実行中の処理が成功したとは判断できません。停止未確認・失敗はバックアップ・復元・更新の前に調査してください。

<a id="upgrade-in-order"></a>

## 順序に従って更新する

別のチェックアウトへ移る場合は、既存環境と同じComposeプロジェクト・非公開設定・PostgreSQLボリュームを選ぶことを確認してください。必要に応じて同じプロジェクト名と設定ファイルの指定を各Composeコマンドへ引き継ぎます。ディレクトリに基づく既定値では、別のプロジェクトを選ぶ場合があります。ビルド・マイグレーションの前に、次の読取専用確認を実施します。移行時と同じComposeプロジェクト・非公開設定ファイル・Composeファイルを選び、必要に応じて導入環境の`--project-name`・`--env-file`・`-f`指定をすべての呼び出しに付けてください。

```sh
docker compose ps -a app
docker compose ps postgres
docker compose exec -T postgres sh -c 'exec psql -X -v ON_ERROR_STOP=1 --no-password -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
select current_database(), current_user;
SQL
```

導入時の運用記録と照合し、既存のアプリ・PostgreSQLコンテナと公開ホストポートが対象環境のものであることを確認します。返されたDB名・ロールは、新しい移行用コンテナに指定するDB名・ユーザーと一致する必要があります。Dockerのコンテナ詳細画面で、PostgreSQLコンテナのComposeプロジェクトラベルと接続ボリュームも運用記録と照合してください。DB名の一致だけでは、別プロジェクトとの取り違えを防げません。正しい識別情報が不明、コマンドが失敗、または値が不一致の場合は、移行前に中止して原因を解決します。調査のために展開後の設定全体や認証情報を出力しないでください。

バックアップは既存DBをアーカイブへ書き出す操作であり、復元はDBをアーカイブの内容に置き換える操作です。**通常のBot更新ではDBの削除・再作成や、アーカイブからの復元を行いません。** `dropdb`・`createdb`や、データ復元としての`pg_restore`は実行しません。バックアップ手順の`pg_restore --list`は目次を読むだけで、DBを復元しません。取得・目次確認・記録だけを行い、下記の更新手順へ戻ってください。

先に上記の対象確認を完了してから、次の順で進めます。全工程でPostgreSQLを維持し、手順3の停止後は手順5のマイグレーションが成功するまでアプリを停止したままにします。

1. 更新先のソース・イメージ、マイグレーション要件、コマンド変更を確認し、新しいイメージとコミット済みの`drizzle/`を一体で管理します。これとは別に、導入時の運用記録とDockerのコンテナ詳細から、現在稼働しているアプリのソース版・イメージIDを控えます。バックアップの取得元はこの旧版であり、新しいチェックアウトの版ではありません。
2. 更新先のチェックアウトで`docker compose build app`を実行し、成功を確認します。このコマンドはアプリの起動・再作成をせずにビルドするため、イメージの準備中は旧アプリを稼働させておけます。新しいイメージはまだ起動しません。
3. [停止確認の手順](#stop-and-verify)で旧アプリを止めます。終了コード0、この停止に対応する`shutdown_completed`、PostgreSQLの継続稼働を確認してください。停止失敗や確認不能なら、バックアップ・移行の前に調査します。
4. アプリを停止したまま、[バックアップの取得・目次確認・記録](Backup-and-Recovery-ja#create-and-inspect-a-backup)を行います。手順1で控えた旧ソース版・イメージを取得元、新しい版を移行予定先としてアーカイブと一緒に記録し、取得と確認の成功後だけ次へ進んでください。**このバックアップ後に旧アプリを再起動しません。** バックアップガイドの[取得後の進め方](Backup-and-Recovery-ja#continue-after-backup)では更新の経路を選び、このページの手順5へ戻ります。復元やDB削除の実行ブロックには進みません。
5. 準備済みの更新先イメージで、マイグレーションを**1プロセスだけ**実行します。

   ```sh
   docker compose run --rm app node dist/migrate.js
   ```

   この単発プロセスの終了コード0と、出力の`migration_succeeded`を確認します。`migration_failed`や0以外の終了コードなら調査し、結果を非公開で保存してください。これは移行コマンド自身の出力であり、停止中アプリのログとは別です。失敗時はアプリを停止したままにします。状態が不明なDBや、一部の変更だけが適用されたDBで新旧いずれのアプリも起動せず、適用済みSQL・journalの書換えや導入先での変更SQLの生成も行いません。

6. 移行成功後だけ、準備したアプリを`docker compose up -d app`で起動します。[readiness](Installation-and-Setup-ja#verify-the-first-run)と、復旧ログ・実際のDiscordでの結果を含む[再起動後の遅延処理](#restart-and-delayed-work)を確認してください。コンテナ設定を変更した場合は正常停止確認後に、準備済みイメージで`docker compose up -d --no-deps --force-recreate app`などを使い、アプリだけ再作成します。
7. 更新先ソースのツールから、[コマンド登録手順](Installation-and-Setup-ja#register-commands)に従い、実際に使ったサーバー単位・グローバルの各範囲へコマンドを再登録します。再起動だけでは登録されません。読取専用コマンドと、確認用リソースを使った代表的な操作も確認し、ソース版、バックアップの保存先、マイグレーション結果、確認結果を非公開で記録します。

WEFTのマイグレーションは明示実行で追記専用です。通常起動では行いません。
スケジューラ自身のDBスキーマはスケジューラ起動時に移行し、WEFTのマイグレーションで管理しません。
原因不明の予約投稿・実行指示の障害のためにスケジューラ状態を消去しないでください。記載した復旧手順はDB・アプリのダウングレードに対応しません。

<a id="restart-and-delayed-work"></a>

## 再起動後の遅延処理を確認する

1. [通常の稼働確認](#observe-health-and-logs)でreadinessと起動・復旧ログを確認します。
2. 元の各投稿先チャンネルで[`/message schedule list`](Commands-Message-ja#message-schedule-list)を引数なしで実行します。調べたい予約は、[`/message schedule status`](Commands-Message-ja#message-schedule-status)の`id`に保存した予約IDを入力して確認します。完了・取消済みの予約は一覧にないため、控えたIDを使用してください。代替予約を作る前に、実際の投稿先と、結果の投稿リンクがあればその内容を確認します。
3. 予約クローズを設定したスレッド内で、[`/thread status`](Commands-Thread-ja#thread-status)を引数なしで実行します。現在の予約を確認した後、実際のアーカイブ状態を確認してください。statusは処理継続中の状態反映をすべて表示するものではありません。

これらのDiscordコマンドには、それぞれ現在の実行者権限が必要です。結果ごとの次の行動は、[予約投稿](Scheduled-Messages-ja#read-the-status-and-verify-delivery)と[予約クローズ](Scheduled-Thread-Close-ja)で確認してください。再起動しても、期限を過ぎた処理がすべて実行される保証はありません。

- 起動時は受付開始前に保存予約を確認します。最初の定期確認が終わるまでreadinessを待たせることはありません。
- 自動クローズの計測開始時刻の補完は、成功を保証しません。
- 未完了のスレッド操作は、Discordへの要求と結果確認を待つ間、起動中のアプリで追跡します。プロセス終了でその追跡情報は失われ、停止時にすべての変更が完了する保証はありません。再起動後の追加操作の前に、元の応答・現在のスレッド・取得できるログを確認してください。
- [予約クローズ](Scheduled-Thread-Close-ja#execution-and-downtime)と[予約投稿](Scheduled-Messages-ja#late-work-restart-and-retries)は異なる復旧規則に従います。
- 一括選択・一覧の操作部品は無効になります。代替予約の作成前に未確認の送信を調べます。

確認に失敗したら[トラブルシューティング](Troubleshooting-ja#startup-migration-or-readiness-failure)、データ復旧には[バックアップと復旧](Backup-and-Recovery-ja)を使用してください。

<a id="health-check-limits"></a>

## 詳細: ヘルス監視とログ

DB確認の待機は最大2秒です。readinessはキュー確認・修復・Discordとの整合性・次の操作の成功を保証しません。

Composeはコンテナ内で30秒ごとに確認し、1回5秒、3回失敗でunhealthy、起動猶予は60秒です。ヘルスポートは公開しません。unhealthyの場合は不成立の条件を調査してください。その結果だけでは、それ以前のDiscord操作の成否は判断できません。
