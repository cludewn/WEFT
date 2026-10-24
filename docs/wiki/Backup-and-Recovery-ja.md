# バックアップと復旧

[ホーム](Home-ja) · [コマンド一覧](Command-Reference-ja) · [トラブルシューティング](Troubleshooting-ja) · [English](Backup-and-Recovery)

非公開のDBバックアップの取得、または信頼できるアーカイブの復元を行う手順です。Discordコマンドではなく、ホスト運用者が実行します。

<a id="choose-a-procedure"></a>

## 手順を選ぶ

| 目的                           | 進め方                                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 更新せずバックアップを取得する | アプリの停止確認→[取得と確認](#create-and-inspect-a-backup)→[同じ版で再起動](#continue-after-backup)                                                |
| 更新中にバックアップを取得する | [更新手順](Operations-ja#upgrade-in-order)に従い、新イメージ準備→旧アプリの停止確認→取得と確認→停止を維持して移行へ戻ります。                       |
| バックアップを復元する         | Discordへの影響評価→停止・対象確認→[DBを削除・再作成して復元](#restore-into-a-clean-target-database)→[確認・移行・起動](#verify-migrate-then-start) |
| 復元できるか確認する           | [分離した復元訓練](#private-storage-and-restore-drills)を行います。Discordは起動しません。                                                          |

DBを復元しても、Discordの送信・編集・名前・アーカイブ状態・削除・権限は戻りません。
**古い予約状態を復元すると、バックアップ後に送信済みの投稿が再び実行候補になる場合があります。**
復元判断の前に外部で起きた変更を確認してください。直前確認・保存ID・重複低減でも厳密な1回限りの復旧は保証できません。
リスクを評価し、復元先のDBを確認するまでアプリを停止しておきます。

<a id="prepare-a-stopped-known-deployment"></a>

## アクセスと停止状態を確認する

対応形式は、PostgreSQL 18の`pg_dump --format=custom`で取得した、単一DB全体のアーカイブです。
稼働中ボリュームのコピー、SQLのマージ、DBメジャー版変更、アプリのダウングレードはこの手順では扱いません。
復元はSQLを実行し得るため、信頼できるアーカイブだけ使ってください。

対象Composeチェックアウトで[停止確認](Operations-ja#stop-and-verify)を行います。
`docker compose stop -t 45 app`で停止し、終了コード0と今回の`shutdown_completed`を確認します。PostgreSQLは稼働させたままにします。
停止済みなら直近の該当停止を確認してください。未起動の新しい復元先は、そのDBへ接続するアプリがないことを確認します。
終了ログのためにDiscordを起動する必要はありません。クラッシュした環境や停止状況が不明な環境を、未起動として扱ってはいけません。先に調査してください。

続ける前に、次を確認してください。

- 対応するPostgreSQL 18のcustom形式と、選んだ手順に必要なDB権限があること。復元時はアーカイブの信頼性とDB作成権限も確認します。
- Composeプロジェクト、取得元・復元先のアプリ版、対象DB・ロールが正しいこと。
- アプリを停止し、PostgreSQLは稼働していること。
- 直近の該当停止を確認できること。または、この対象でWEFTを一度も起動しておらず、接続中のプロセスがないこと。クラッシュ・停止状況不明を未起動とは扱いません。

<a id="create-and-inspect-a-backup"></a>

## 取得・確認・記録する

アプリ停止中に、リポジトリ外の非公開ディレクトリへ保存します。

```sh
(
  set -e
  umask 077
  backup_dir="$HOME/weft-backups"
  mkdir -p -- "$backup_dir"
  chmod 700 -- "$backup_dir"
  partial_file=$(mktemp "$backup_dir/weft-pg18.XXXXXX.partial")
  archive_file="${partial_file%.partial}.dump"
  docker compose exec -T postgres sh -c 'exec pg_dump --no-password -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$partial_file"
  docker compose exec -T postgres pg_restore --list < "$partial_file" > /dev/null
  mv -- "$partial_file" "$archive_file"
  printf '%s\n' "$archive_file"
)
```

`-T`でバイナリ出力を保ち、`pg_dump`の標準出力は非公開ファイルだけへ送ります。両方のコマンドが成功した後だけ、一時ファイル（partial）を正式なバックアップ名へ変更します。
取得失敗でDBは変わりません。残ったpartialは正常バックアップではありません。
目次一覧は完全復元や安全性の検証ではありません。保存済みアーカイブの目次を次の手順で確認します。パスを直前に表示された実際のアーカイブへ置き換え、各コマンドの結果を確認してください。

```sh
backup_file='/absolute/private/path/to/weft-backup.dump'
test -s "$backup_file"
docker compose exec -T postgres pg_restore --list < "$backup_file"
```

UTC取得日時、DB名、PostgreSQLメジャー版、取得元WEFT・イメージの版、復元予定版を一緒に記録します。
目次では、次のスキーマを確認します。スキーマは、同じDB内のテーブルなどをまとめる単位です。

| スキーマ  | 復旧時に確認する理由                                                                 |
| --------- | ------------------------------------------------------------------------------------ |
| `public`  | WEFTの設定、管理対象の記録、予約、監査データを保存します。                           |
| `drizzle` | WEFTのDBマイグレーション履歴を保存します。                                           |
| `pgboss`  | スケジューラ内部のキューとジョブ状態を保存します。取得時に存在した場合に含まれます。 |

これらは別々のバックアップ対象ではなく、同じDBの一部です。アーカイブ全体を保持し、WEFTのテーブルだけを抽出したり、スケジューラ状態を除去したりしないでください。

<a id="continue-after-backup"></a>

### バックアップ取得後の進め方を選ぶ

アーカイブの取得・目次確認・記録が成功した後だけ、取得目的に応じて進みます。

- **更新せずバックアップを取得した場合:** 同じ取得元の版を起動し、[readiness](Installation-and-Setup-ja#verify-the-first-run)を確認します。取得だけならマイグレーションは不要です。起動前に、選択しているイメージがその取得元の版であることを確認してください。
- **更新中にバックアップを取得した場合:** アプリの停止とPostgreSQLの稼働を維持し、[更新手順](Operations-ja#upgrade-in-order)の手順5へ戻って、準備済みの更新先イメージで移行します。バックアップと移行の間に旧アプリを再起動しません。
- **復元訓練の場合:** Discordアプリを停止したまま、[分離した訓練](#private-storage-and-restore-drills)を続けます。

**バックアップの取得手順はここで終了です。** 以下の復元手順はDBを置き換える操作であり、別途判断した復旧時だけに使います。バックアップ取得や通常更新の一部として実行しないでください。

<a id="restore-into-a-clean-target-database"></a>

## 復元先を確認し、DBを削除・再作成して復元する

信頼できる空でないアーカイブ、取得元と復元先の版、Composeプロジェクト・DB・ロール、稼働中のPostgreSQL、該当する停止状態を確認します。
新しい版のバックアップを古いアプリへ復元しないでください。絶対パスを指定して目次を確認します。

```sh
backup_file='/absolute/private/path/to/weft-backup.dump'
test -s "$backup_file"
docker compose exec -T postgres pg_restore --list < "$backup_file"
docker compose ps -a app
docker compose ps postgres
docker compose exec -T postgres sh -c 'printf "target database: %s; role: %s\n" "$POSTGRES_DB" "$POSTGRES_USER"'
```

すべての結果を確認してください。次の操作は**設定された対象DBを削除します**。全確認が成功した後だけ実行します。
ロールには所有・削除、DB作成、復元オブジェクト作成の権限が必要です。単一DBのdumpにクラスタ全体のロール定義は含まれません。
元の所有者・権限を復元しないため、提供する単一ユーザーComposeでは復元ロールが所有します。外部DBでも同等の準備が必要です。

```sh
(
  set -e
  docker compose exec -T postgres sh -c 'exec dropdb --no-password -U "$POSTGRES_USER" --maintenance-db=postgres "$POSTGRES_DB"'
  docker compose exec -T postgres sh -c 'exec createdb --no-password -U "$POSTGRES_USER" --maintenance-db=postgres --template=template0 --owner="$POSTGRES_USER" "$POSTGRES_DB"'
  docker compose exec -T postgres sh -c 'exec pg_restore --no-password -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --single-transaction' < "$backup_file"
)
```

想定外の接続は強制切断せず、dropを失敗させて調査します。既存DBへマージせず、--clean --createも使いません。後者ではアーカイブがDB名を選ぶためです。
PostgreSQL 18の復元は1トランザクションでエラー時に失敗しますが、その前のdrop/createは取り消しません。
1つでも失敗したらアプリを停止したまま調査し、状態が不明なDBや、復元が途中までしか完了していないDBで起動しないでください。

<a id="verify-migrate-then-start"></a>

## 復元DBを確認・移行して起動する

最初にDB確認を実行します。結果を確認するまで、マイグレーションやアプリ起動へ進まないでください。

```sh
docker compose exec -T postgres sh -c 'exec psql -X -v ON_ERROR_STOP=1 --no-password -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
select current_database(), current_user;
select count(*) as guild_settings_rows from public.guild_settings;
select count(*) as drizzle_migration_rows from drizzle.__drizzle_migrations;
select to_regclass('pgboss.version') as pgboss_version_table;
SQL
```

固定件数を仮定せず、接続先DB・ロール、代表件数、マイグレーション履歴を照合します。クエリはWEFTデータの`public`、移行履歴の`drizzle`、スケジューラ状態の有無を確認する`pgboss.version`を参照します。スケジューラの全スキーマ・状態も保持してください。

DB確認が成功した後、対象版のマイグレーションを1プロセスだけ実行します。

```sh
docker compose run --rm app node dist/migrate.js
```

正常終了を確認してください。同じ版なら変更なし、新しい対象版ならコミット済みのマイグレーションを適用する場合があります。その後、DB確認を再実行します。ここまで成功した後だけアプリを起動し、[readiness](Installation-and-Setup-ja#verify-the-first-run)、起動時復旧、現在のDiscord状態を調べます。
readinessだけでは、復元した予約・記録が実際のDiscord上の状態と一致することは確認できません。

<a id="private-storage-and-restore-drills"></a>

## アーカイブを保護して復元を訓練する

アーカイブには予約・管理本文、ID、監査、設定、スケジューラ状態を含み得ます。運用中のデータと同様にアクセスを制限し、コミットや内容のログ出力はしないでください。
過去のバックアップには実行時の保持期間を超えた監査も残るため、別途管理します。

定期的に、復元テスト専用のPostgreSQL 18環境で実際の復元を確認してください。**訓練中はDiscordアプリを起動しません。** 破棄可能なテストデータだけを使用します。以下は準備・確認項目であり、リポジトリには訓練全体の実行ツール、テストデータ投入ツール、pg-boss単独の確認コマンドはありません。必要なDB専用ツールを用意してから、該当する訓練を始めてください。

### 分離した復元先を用意して識別する

検証するデータと同じ`compose.yaml`・アプリ版を使います。リポジトリ外の非公開設定ファイルに訓練専用のDB認証情報を用意し、Discord認証情報はファイルにも訓練プロセスの環境変数にも設定しません。本番の設定をコピーせず、次の対象を明確に区別してください。

- **Composeプロジェクト:** `weft-restore-drill-20261023`などの固有名を選び、**すべて**の呼び出しで`--project-name`を指定します。作業ディレクトリを変えるだけでは不十分です。

- **設定:** `--env-file`に訓練専用ファイル、`-f`に対象の`compose.yaml`を絶対パスで指定します。ホストにエクスポート済みの値がファイルより優先されるため、別のDB・ロール・ポートへ置き換わらないことを確認します。展開後の設定全体や認証情報は出力しません。

- **DBとロール:** `DATABASE_NAME`と`DATABASE_USER`に、例えば`weft_restore_drill`・`weft_drill_owner`という専用名を使い、新しい訓練専用パスワードを用意します。下記のDB確認で実際の接続先・ロールを確認します。既存ボリュームの初期化設定を変えても、中のDB・ロールは改名されません。

- **ポート:** `DATABASE_PORT`には未使用のホストポートを設定します。例えば`55432`が未使用なら使用できます。PostgreSQLコンテナ内部は5432のままで、移行用コンテナはこのプロジェクトのネットワーク上の`postgres:5432`へ接続します。

- **ボリューム:** 提供するComposeでは、プロジェクトごとの`postgres-data`ボリュームを`/var/lib/postgresql/`へマウントします。Dockerのコンテナ・ボリューム詳細で、実際のPostgreSQLコンテナのプロジェクトラベル、ボリューム名、マウント先を確認します。開発・本番のボリュームを流用せず、外部ボリュームへ差し替えません。

- **アーカイブ:** 訓練専用の非公開ディレクトリと新しい保存先を選び、取得元DB・版・期待するデータを記録します。通常環境のバックアップ保存先と混同しないでください。

次は、プロジェクト・設定・Compose定義を明示する**読取専用**の例です。パスとプロジェクト名は実際の訓練環境へ置き換えてください。

```sh
docker compose --project-name weft-restore-drill-20261023 --env-file /absolute/private/path/drill.conf -f /absolute/path/to/WEFT/compose.yaml ps -a
```

訓練とリンク先の手順で使う**すべて**の`docker compose`を、この指定を含む呼び出しに置き換えます。このページ前半のマイグレーション・取得・復元の実行例と、訓練後の削除も同様です。通常のチェックアウトで、指定なしのコマンドへ戻らないでください。詳細はDockerの[プロジェクト名の指定](https://docs.docker.com/compose/how-tos/project-name/)と[変数の優先順位](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)を参照してください。

### 訓練を実行して結果を照合する

1. 訓練用のPostgreSQLサービス**だけ**を起動します。プロジェクト、コンテナ、ホストポート、マウントされたボリュームを記録した訓練対象と照合し、そのDBへ接続するDiscordアプリがないことを確認します。単発の`node dist/migrate.js`でWEFTマイグレーションを適用します。この処理はDiscordへ接続せず、pg-bossも初期化しません。
2. レビュー済みのデータ投入ツールで、現在のDB構造に適合する識別可能なテスト行を用意します。設定・予約・監査の代表値と件数、Drizzle履歴、オブジェクトの所有権と設定ロールで利用できることを記録します。現在の制約を回避する行を独自に作成しないでください。
3. スケジューラ復旧も調べる場合は、インストール済みのpg-boss版を使うDB専用の確認ツールを先に用意します。訓練DBだけへ接続し、WEFTのアプリ起動用モジュールの読み込み、Discordへの接続、送信・クローズワーカーの登録をせずにpg-bossを起動・停止し、接続プールを閉じる必要があります。`pgboss.version`、期待するキュー、代表的なジョブ状態の有無を記録します。WEFTマイグレーションではこのスキーマを作成せず、初期化・内部移行はpg-bossが担当します。ツールが未準備なら、この部分は延期し、スケジューラの利用可能性は未検証と記録してください。
4. 訓練用のCompose指定と非公開保存先で[取得と目次確認](#create-and-inspect-a-backup)を行います。実際に存在した`public`・`drizzle`と、初期化済みなら`pgboss`を目次と照合します。訓練では取得後もDiscordアプリを起動しません。
5. **DB削除の直前**に、訓練用のCompose指定で`ps`と[復元前確認](#restore-into-a-clean-target-database)のDB・ロール確認を繰り返します。読取専用の`current_database()`・`current_user()`を含む[DB確認](#verify-migrate-then-start)も実行し、コンテナのプロジェクトラベル、ホストポート、ボリュームを再確認します。不一致や不明点があれば中止してください。

   この時点の訓練用DBには、手順2で投入したテストデータが残っています。対象を確認できた後だけ、既存の復元用コマンドを**訓練用DB**へ実行します。このコマンドは**DBと中のテストデータを削除し、DBを再作成してから、手順4のアーカイブを復元します**。既存DBへのデータ追加ではありません。強制切断やスキーマ初期化のコマンドを追加しません。

6. テストデータ投入時に用意した確認用クエリで、復元された行・件数、Drizzle履歴、所有権をバックアップ前の記録と照合します。

   上記の掲載済みSQLで確認できるのは、接続先DB・ロール、設定と移行履歴の行数、`pgboss.version`の有無です。すべてのテストデータの比較や、スケジューラのキュー・ジョブの確認は行いません。アーカイブの目次一覧が成功しただけでは不十分です。

   `pgboss`を含むアーカイブなら、復元された版テーブルに加え、別途用意した確認用クエリで手順3に記録したスケジューラ状態も照合します。新しく作成された空のスキーマで復旧成功と判断しないでください。

   同一版のWEFTマイグレーションが新規適用なしで成功することも確認します。**手順3でDB専用のpg-boss確認ツールを用意した場合だけ**、そのツールで起動・停止の互換性と、期待するキュー・状態を読めることを確認します。未準備の場合、pg-bossの起動とキュー・ジョブの利用可否は未検証として記録します。スケジューラ状態を消去せず、ワーカーやDiscordアプリも起動しません。

7. 不正なアーカイブのテストは、同じ破棄可能な対象だけで行います。0以外の終了コードとなり、アプリを起動しないことを確認します。復元トランザクションは先行するDB削除・作成を取り消せないため、失敗後は正常な再復元を確認するまで対象を使用できません。調査が終わるまで正常な訓練用アーカイブを保持します。

### 訓練を終了する

対象の識別情報、アプリ・PostgreSQLの版、アーカイブ取得元、復元前後の比較、コマンド結果、未検証項目を記録します。

データの復元確認とpg-bossの動作確認は分けて報告してください。行・履歴の照合が成功しても、確認できたのはそのデータの復元です。pg-boss確認ツールを使っていなければ、スケジューラの動作は未検証であり、スケジューラまで含む復元訓練は未完了です。初期化済みのpg-boss状態を含まないアーカイブでは、その状態の復旧を確認したことにもなりません。

秘密情報を含まない訓練報告は残し、本文・認証情報・アーカイブを添付しないでください。結果を記録して失敗の調査を終えたら、訓練プロジェクトのコンテナ・ネットワーク、確認済みの専用ボリューム、訓練用アーカイブ・テストデータ、一時設定・認証情報・確認ツールの一時ファイルだけを削除します。削除前に各対象のプロジェクトと識別情報を再確認してください。本番・開発環境、ソース、それらのバックアップは残します。対象プロジェクトの誤指定による無関係なデータの削除を避けるため、汎用のボリューム削除コマンドは掲載しません。

目次確認は訓練の代わりになりません。
詳細はリポジトリの[運用手順](https://github.com/cludewn/WEFT/blob/main/docs/development.md#production-backup-and-restore-operations)も参照してください。
