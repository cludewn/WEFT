# インストールと初期設定

[ホーム](Home-ja) · [コマンド一覧](Command-Reference-ja) · [トラブルシューティング](Troubleshooting-ja) · [English](Installation-and-Setup)

Discordアプリの準備からWEFTの起動までを説明します。セルフホストには、ホスト、非公開設定、PostgreSQLデータ、バックアップの保守が必要です。

<a id="prerequisites"></a>

## 稼働環境を用意する

| 必要なもの                                        | 用途                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| Gitと、導入する版のWEFTのソース一式               | Compose、ソース、対応するマイグレーションを用意します。                          |
| Docker・Docker Compose                            | WEFTアプリ1台とPostgreSQL 18をビルド・実行します。                               |
| ホストのNode.js 24とCorepack                      | コマンド登録ツールを実行します。pnpmは`package.json`に固定された版を使用します。 |
| Discordアプリの管理とサーバーへの導入ができる権限 | ボットを作成し、必要なアクセスを付与します。                                     |

同時に稼働するWEFTは1台です。Web管理画面、DM操作、クラスタ運用、汎用モデレーション機能には対応しません。

**Discordアプリの作成・導入→非公開設定→ビルド・PostgreSQL起動→マイグレーション→コマンド登録→WEFT起動→確認→サーバー設定**の順で進めます。

<a id="create-and-install-the-discord-application"></a>

## Discordアプリを作成して導入する

1. [Discord Developer Portal](https://discord.com/developers/applications)でアプリを作成します。
   Application IDを控え、Bot設定からトークンを取得して非公開で保管します。
2. **Guild Install**だけを設定します。User InstallとDMには対応しません。
   Discord Provided Linkで`bot`と`applications.commands`のスコープを選びます。
3. WEFTの機能を使用するため、**チャンネルを見る**、**スレッドの管理**、**メッセージを送信**、
   **スレッドでメッセージを送信**、**メッセージ履歴を読む**、**埋め込みリンク**の権限を選びます。Administratorは付与しません。
4. リンク検出のため、Bot → Privileged Gateway Intentsの**Message Content Intent**を有効にします。
   Server MembersとPresenceは不要です。プレビューをオフにしても、実行時のIntent設定は動的には除去されません。
5. 対象サーバーへ導入し、チャンネルの権限上書きを確認します。導入時の権限だけでは各チャンネルでの有効な権限は決まりません。現在のロールとチャンネルの権限上書きも確認してください。
   非公開スレッドは実際のアクセスが必要です。WEFTが送信のために自動参加することはありません。

| コマンドの種類       | 実行者に必要な権限 |
| -------------------- | ------------------ |
| `/config`            | サーバーの管理     |
| `/thread`            | スレッドの管理     |
| `/message`と予約投稿 | メッセージの管理   |

コマンドの表示だけでは許可になりません。WEFT自身の権限は別に確認し、Administratorを使わず必要なチャンネル権限を付与してください。

<a id="prepare-the-checkout-and-configuration"></a>

## チェックアウトと非公開設定を準備する

導入する版のWEFTのソース一式を用意してください。以降のコマンドは、`compose.yaml`、`package.json`、
`.env.example`があるルートディレクトリで実行します。まず、コマンド登録に使うツールをインストールします。

```sh
corepack pnpm install --frozen-lockfile
```

チェックアウトのルートで、`.env.example`から非公開のローカル設定ファイルを作成します。

```sh
umask 077
cp -n .env.example .env
chmod 600 .env
```

`cp -n`は既存の`.env`を上書きしません。すでにファイルがある場合は、その設定を更新してください。
非公開のエディターで`DATABASE_NAME`、`DATABASE_USER`、十分に強い`DATABASE_PASSWORD`を設定します。
`DISCORD_TOKEN`と`DISCORD_APPLICATION_ID`には、先ほど取得したボットトークンとApplication IDを設定します。
サーバー単位でコマンドを登録する場合は、`DISCORD_GUILD_ID`にサーバーIDを設定してください。
認証情報を含むファイルをコミットしたり、内容をIssueへ貼ったり、設定全体を出力したりしないでください。

ホストとコンテナの接続先の違い・任意設定は、末尾の[設定リファレンス](#configuration-reference)を参照してください。非公開設定を終えてから次へ進みます。

<a id="build-migrate-deploy-commands-and-start"></a>

## ビルド・移行・登録・起動する

<a id="build-and-migrate"></a>

### 1. イメージをビルドしてDBを移行する

順番に実行し、各コマンドの成功を確認してから次へ進んでください。

非公開設定の準備後、チェックアウトのルートで実行します。

```sh
docker compose build app
docker compose up -d postgres
docker compose run --rm app node dist/migrate.js
```

マイグレーションは、WEFTに必要なデータベース構造を更新する処理です。正常終了を確認してからアプリを起動し、
同じDBで複数のマイグレーションを並行実行しないでください。通常起動ではWEFTのテーブルを移行しません。
イメージには実行プログラムと対応するSQLが含まれるため、実行用コンテナへ移行用ツールを追加する必要はありません。

<a id="register-commands"></a>

### 2. Discordコマンドを登録する

チェックアウトのルートで、Node.js 24を使って先ほど作成した非公開の`.env`を読み込み、コマンドを登録します。

```sh
node --env-file=.env --import tsx src/deploy-commands.ts
```

既定では`DISCORD_GUILD_ID`で指定したサーバーへ登録します（Guild範囲）。全サーバー向けのGlobal範囲へ登録する場合は、同じコマンドに`--global`を付けます。

```sh
node --env-file=.env --import tsx src/deploy-commands.ts --global
```

選択した登録範囲を上書きし、Guild範囲とGlobal範囲は独立しています。アプリの再起動では登録されません。更新時は使用した各範囲で再登録してください。

これらはホスト上で実行します。Composeのコンテナ内の環境変数は渡されないため、`--env-file`でチェックアウトの非公開ファイルを明示的に読み込みます。既存のホスト環境変数はファイルより優先されます。Guild登録には`DISCORD_TOKEN`、`DISCORD_APPLICATION_ID`、`DISCORD_GUILD_ID`が必要です。Global登録ではサーバーIDは不要です。コマンド登録ではPostgreSQLへ接続しません。

必要なDiscord変数をホストの環境へ設定済みなら、代わりに`corepack pnpm commands:deploy`、Global範囲には`corepack pnpm run commands:deploy --global`を使用できます。同じ登録CLIを実行しますが、これらのpnpmコマンドは`.env`を**自動では読み込みません**。

<a id="start-application"></a>

### 3. WEFTを起動する

```sh
docker compose up -d app
docker compose ps
```

<a id="verify-the-first-run"></a>

## 初回の動作を確認する

コンテナ内で稼働準備状態を確認します。

```sh
docker compose exec -T app node -e "fetch('http://127.0.0.1:' + process.env.HEALTH_PORT + '/health/ready').then(r => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))"
```

終了コード0は、その確認時点でHTTP 200が返されたことを示します。[アプリのログ取得方法](Operations-ja#inspect-operation-logs)に従い、`application_ready`も確認してください。
非公開のIDや内容を含む生ログは公開しないでください。
管理者として[`/config audit-log show`](Commands-Config-ja#config-audit-log-show)、
[`/config show`](Commands-Config-ja#config-show)を実行します。監査通知先は初期状態では無効です。
ポリシーを有効にする前に[設定](Configuration-ja)へ進み、確認用に作成したスレッドや投稿で、実行者だけへの応答と権限を確認します。
readinessは確認時点の稼働状態を示します。将来のAPI操作の成功や、復旧後の整合性を保証するものではありません。
失敗時は[トラブルシューティング](Troubleshooting-ja)を参照してください。

| 確認項目                | 確認する結果                                                                      |
| ----------------------- | --------------------------------------------------------------------------------- |
| コンテナの稼働準備状態  | 確認コマンドが終了コード0を返します。その時点でHTTP 200が返されたことを示します。 |
| 起動ログ                | `application_ready`                                                               |
| Discordの登録・アクセス | 権限を持つ管理者が`/config show`を実行すると、本人だけに応答が表示されます。      |
| 初期の監査通知先        | 未設定なら`/config audit-log show`で無効と表示します。                            |

次は[サーバー設定](Configuration-ja)へ進み、[確認用スレッドのクローズ](Thread-Lifecycle-ja)または[管理メッセージの送信](Managed-Messages-ja)を試します。readinessだけでは、これらの操作の成功は確認できません。

<a id="configuration-reference"></a>

## ホスト・コンテナの設定リファレンス

Docker Composeはチェックアウトの`.env`を変数の展開に使い、`compose.yaml`に定義された変数を各コンテナへ渡します。
ホストのシェルですでにエクスポートされた変数がある場合は、その値が`.env`より優先されます。秘密情報を出力せず、設定の競合がないことを確認してください。
ホストのNode.js・pnpmコマンドは`.env`を**自動では読み込みません**。環境管理ツールを使うか、コマンド登録の手順に記載した、ファイルを明示的に読み込む方法を使います。
`TEST_DATABASE_*`の項目は導入時には使用しません。
ComposeとNode.jsで共用する設定には、値を直接記述してください。Node.jsはCompose形式の`${...}`を展開しません。
特殊文字を含む値は、[Composeのファイル構文](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/#env-file-syntax)と
[Node.jsのファイル構文](https://nodejs.org/download/release/v24.11.0/docs/api/cli.html#--env-filefile)に従って引用符で囲みます。

| 設定                                                                          | 設定する値・使用条件                                                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| DATABASE_HOST、DATABASE_PORT、DATABASE_NAME、DATABASE_USER、DATABASE_PASSWORD | 必須です。ホストからは、対象DBのアドレスと1～65535のポートを指定します。                          |
| DATABASE_SSL                                                                  | 任意です。既定値はfalseで、trueでは証明書検証付きTLSが必要です。                                  |
| DISCORD_TOKEN、DISCORD_APPLICATION_ID                                         | 実行時に必須です。後者にはBot User IDではなくApplication IDを指定します。                         |
| DISCORD_GUILD_ID                                                              | 既定のサーバー単位のコマンド登録で使います。WEFTの実行先を1サーバーへ制限する設定ではありません。 |
| LOG_LEVEL                                                                     | 任意です。既定値はinfoです。                                                                      |
| HEALTH_PORT                                                                   | 任意です。既定値は3000で、コンテナ内のヘルス監視用HTTPサーバーのポートを指定します。              |

Composeは`.env`内の値にかかわらず、アプリコンテナの`DATABASE_HOST`を`postgres`、`DATABASE_PORT`を`5432`に設定します。
ホストからDBへ接続するコマンドでは、`127.0.0.1`と`DATABASE_PORT`で指定したホスト側のポート（既定5432）を使います。
WEFT自体をホストで直接実行する場合は、表にある実行時の必須変数をすべて渡してください。Composeによる上書きは適用されません。
PostgreSQLのポートは127.0.0.1だけへ公開し、データは`postgres-data`の名前付きボリュームに保存します。
アプリのヘルスポートはホストへ公開しません。DBロールには、そのDB内でスケジューラの内部スキーマを作成できる権限も必要です。
