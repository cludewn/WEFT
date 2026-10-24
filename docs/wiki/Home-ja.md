# WEFTユーザーガイド

[ホーム](Home-ja) · [コマンド一覧](Command-Reference-ja) · [トラブルシューティング](Troubleshooting-ja) · [English](Home)

WEFTは、終了した議論のクローズと、指定した日時の投稿を支援するセルフホスト型Discordボットです。サーバー管理者がDiscordのスラッシュコマンドとフォームで操作します。

解決済みのサポートスレッドをアーカイブする、一定期間投稿のないスレッドを自動クローズする、複数の候補を確認して一括クローズする、単発のリマインダーや毎日・毎週のお知らせを投稿するといった用途に使えます。WEFTが送信して記録したメッセージは、コマンドで編集できます。

<a id="start-here"></a>

## 目的に合ったページから始める

| 目的                                       | 最初に読むページ                                                                            | 次に読むページ                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 初めてWEFTを導入する                       | [インストールと初期設定](Installation-and-Setup-ja)                                         | [サーバー設定](Configuration-ja)                                             |
| 導入済みのWEFTでスレッドを管理する         | [クローズとアーカイブの基本](Thread-Lifecycle-ja)                                           | [スレッドコマンドの詳細](Commands-Thread-ja)                                 |
| 無投稿期間に応じた自動クローズを有効にする | [自動クローズの設定手順](Automatic-Close-ja#enable-a-parent-then-exempt-individual-threads) | [クローズされない場合の確認](Troubleshooting-ja#automatic-close-not-running) |
| 投稿を予約する                             | [予約投稿の作成](Scheduled-Messages-ja)                                                     | [タイムゾーンと日時指定](Timezones-and-Scheduling-ja)                        |
| 保存済みのサーバー設定を確認する           | [`/config show`の使い方](Commands-Config-ja#config-show)                                    | [各設定の説明](Configuration-ja)                                             |
| コマンドを調べる                           | [コマンドの種類を選ぶ](Command-Reference-ja#choose-a-command-family)                        | [個別コマンドを索引から探す](Command-Reference-ja#all-commands)              |
| 問題や結果未確認の操作を調べる             | [トラブルシューティング](Troubleshooting-ja)                                                | 該当する症状の確認・再試行手順                                               |

セルフホストとは、WEFTとPostgreSQLを動かす環境を自分で用意し、保守する方式です。対応構成は、同時に稼働するWEFTアプリ1台とPostgreSQL 18で、Docker Composeを使用します。必要なツール、Discordアプリ、権限は[導入手順](Installation-and-Setup-ja)で説明します。

<a id="choose-a-task"></a>

## 機能・運用の目的から探す

| 目的                                           | ガイド                                       |
| ---------------------------------------------- | -------------------------------------------- |
| 指定時間後にクローズする                       | [予約クローズ](Scheduled-Thread-Close-ja)    |
| 複数のスレッドを選んでクローズする             | [一括クローズ](Bulk-Thread-Close-ja)         |
| ボットのお知らせを作成・編集する               | [管理メッセージ](Managed-Messages-ja)        |
| メッセージリンクのプレビュー表示方法を設定する | [リンクプレビュー](Link-Previews-ja)         |
| 保存情報と監査通知を確認する                   | [監査とプライバシー](Audit-and-Privacy-ja)   |
| 稼働確認・停止・更新を行う                     | [更新と運用](Operations-ja)                  |
| PostgreSQLのデータをバックアップ・復元する     | [バックアップと復旧](Backup-and-Recovery-ja) |

<a id="find-a-command"></a>

## ガイドとリファレンスを使い分ける

機能ガイドは、一連の操作と実行後の確認を説明します。[コマンド一覧](Command-Reference-ja)は、全32操作の入力・権限・結果を調べるための資料です。[設定](Commands-Config-ja)、[スレッド](Commands-Thread-ja)、[メッセージと予約](Commands-Message-ja)に分かれています。

<a id="before-you-rely-on-an-outcome"></a>

## 操作を繰り返す前に結果を確認する

各ガイドで、成功時の結果と、確認が必要な場合を説明します。結果が不確定なら、再実行する前に[トラブルシューティング](Troubleshooting-ja#result-states)を確認してください。監査通知がないだけでは失敗とは判断できません。

<a id="guide-version"></a>

このWikiは、WEFTの初期MVPで実装されている機能とコマンドを対象としています。正本のMarkdownファイルは[リポジトリの`main`ブランチにある`docs/wiki/`](https://github.com/cludewn/WEFT/tree/main/docs/wiki)で管理し、そこからGitHub Wikiへ公開します。

操作前に、使用するコマンドや設定が導入済みのWEFTの版で利用できることを確認してください。
