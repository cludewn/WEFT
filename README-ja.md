# WEFT

<p align="center">
  <a href="./README.md">English</a> | <strong>日本語</strong>
</p>

WEFTは、スレッド管理、Botメッセージの共同編集、予約・定期投稿を行うセルフホスト型Discord Botです。

## 主な機能

### スレッド管理

スレッドを手動でクローズするほか、一定期間投稿のないスレッドを自動的にクローズする設定ができます。指定時間後のクローズ予約や、スレッド名・作成者などで候補を絞り込み、選択したスレッドをまとめてクローズする操作も行えます。

### Botメッセージの共同編集

Bot名義で投稿したメッセージを、権限を持つ複数の管理者が共同で編集できます。

### メッセージの予約・定期投稿

指定した日時や一定時間後にメッセージを投稿するよう予約できます。毎日・毎週の定期投稿も設定でき、投稿内容や予定の変更、予約の取り消しができます。

### メッセージリンクのプレビュー

同じサーバー内のメッセージリンクから、リンク先の内容をプレビューします。公開可能と確認された内容は自動表示し、それ以外は閲覧権限を確認したユーザーにのみ表示します。

### 権限確認と監査ログ

管理操作では実行者とBotの権限を確認し、操作結果や設定変更の履歴を記録します。監査イベントは、指定したDiscordチャンネルへの通知も設定できます。

## ドキュメント

機能の使い方、コマンド、設定、更新、バックアップ・復旧については、[公式Wiki](https://github.com/cludewn/WEFT/wiki/Home-ja)を参照してください。

## 導入

WEFTのソースコードを取得し、Docker Composeを使って導入します。対応構成は、同時に稼働するWEFTアプリ1台とPostgreSQL 18です。

必要なものは次のとおりです。

- Git、Docker、Docker Compose。
- ホスト側のNode.js 24とCorepack。pnpmは`package.json`に固定された版を使用します。
- Discordアプリを管理し、対象サーバーへ導入できる権限。

以下は初回導入の手順です。コマンドを順に実行し、各コマンドの成功を確認してから次へ進んでください。設定や運用の詳細は、[Wikiの各ガイド](#ドキュメント)を参照してください。

### 1. Discordアプリを準備する

1. [Discord Developer Portal](https://discord.com/developers/applications)でアプリを作成します。Application IDを控え、Bot設定からトークンを取得します。
2. Guild Installを設定します。Discord Provided Linkを使用し、Default Install Settingsで`bot`と`applications.commands`のスコープを選びます。
3. 「チャンネルを見る」「スレッドの管理」「メッセージを送信」「スレッドでメッセージを送信」「メッセージ履歴を読む」「埋め込みリンク」を付与します。Administratorは付与しないでください。
4. Bot → Privileged Gateway IntentsのMessage Content Intentを有効にし、対象サーバーへアプリを導入します。

### 2. ソースを取得し、環境変数を設定する

リポジトリを取得し、ホスト側の依存関係をインストールします。

```sh
git clone https://github.com/cludewn/WEFT.git
cd WEFT
corepack pnpm install --frozen-lockfile
```

以降のコマンドはチェックアウトのルートで実行します。[`.env.example`](.env.example)から非公開設定を作成してください。

```sh
umask 077
cp -n .env.example .env
chmod 600 .env
```

`cp -n`は既存の`.env`を上書きしません。ファイルを編集し、`DATABASE_NAME`、`DATABASE_USER`、十分に強い`DATABASE_PASSWORD`、`DISCORD_TOKEN`、`DISCORD_APPLICATION_ID`を設定します。サーバー単位でコマンドを登録する場合は、`DISCORD_GUILD_ID`に対象サーバーIDを指定します。ファイルは非公開で保管し、コミットしないでください。

任意設定や環境変数の詳細は、[設定リファレンス](https://github.com/cludewn/WEFT/wiki/Installation-and-Setup-ja#configuration-reference)を参照してください。

### 3. イメージをビルドし、DBマイグレーションを実行する

```sh
docker compose build app
docker compose up -d postgres
docker compose run --rm app node dist/migrate.js
```

**マイグレーションの正常終了を確認してから次へ進んでください。** 失敗した場合はアプリを起動せず、原因を調べてください。

### 4. Discordコマンドを登録する

ホスト上で次を実行し、`DISCORD_GUILD_ID`で指定したサーバーへ登録します（Guild範囲）。ホスト側のコマンドは`.env`を自動で読み込まないため、明示的に読み込みます。

```sh
node --env-file=.env --import tsx src/deploy-commands.ts
```

代わりにGlobal範囲へ登録する場合は、次を使用します。`DISCORD_GUILD_ID`は不要です。

```sh
node --env-file=.env --import tsx src/deploy-commands.ts --global
```

アプリ起動ではコマンドが登録されないため、この手順を終えてからWEFTを起動してください。

### 5. WEFTを起動し、動作を確認する

```sh
docker compose up -d app
docker compose ps
```

ヘルスポートはホストへ公開しません。アプリコンテナ内でreadiness（稼働準備状態）を確認します。

```sh
docker compose exec -T app node -e "
  fetch('http://127.0.0.1:' + (process.env.HEALTH_PORT ?? '3000') + '/health/ready')
    .then(r => process.exit(r.status === 200 ? 0 : 1))
    .catch(() => process.exit(1))
"
```

終了コード0を確認し、Discordで「サーバーの管理」権限を持つメンバーが`/config show`を実行して、Botの応答を確認してください。

## セキュリティ

脆弱性は[SECURITY.md](SECURITY.md)に従って非公開で報告してください。公開Issueには脆弱性の詳細を投稿しないでください。

## ライセンス

WEFTは[MIT License](LICENSE)で配布しています。[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)は、配布物に含まれる依存パッケージのライセンス資料を補足します。
