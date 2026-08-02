# IMAP Migration Tool

`beautifulsnow.co.jp` のように、既存のIMAPメールサーバー（例: ロリポップ！レンタルサーバー）から
[email-explorer-ja](../../README.md) へ過去メールを取り込むための移行スクリプトです。

## 想定している移行手順

1. **email-explorer-ja を先にデプロイ**し、移行先の管理者アカウントを作成しておく。
2. **このスクリプトで既存メールをコピー**する（ロリポップ側のMXはまだ変更しない。既存メール受信には影響なし）。
3. コピーが完了・確認できたら、**Cloudflareダッシュボードで `beautifulsnow.co.jp` のEmail Routingを有効化**し、MXをCloudflare側へ切替（この時点から新着メールは email-explorer-ja に届く）。
4. 切替直前にロリポップへ届いた分の取りこぼしがないよう、`LOLIPOP_IMAP_SINCE` を使って**差分同期を1回追加実行**する。

## 使い方 ① GitHub Actionsで実行（推奨・ローカルインストール不要）

ローカルにNode.jsを入れたくない場合は、GitHub Actions上で実行できます。認証情報はGitHubの
Secretsに保存されるため、チャットやローカルファイルに書き出す必要もありません。

**事前準備（初回のみ）:** リポジトリの Settings → Secrets and variables → Actions で、以下の
Secretsを登録してください。

| Secret名 | 値 |
|---|---|
| `LOLIPOP_PASSWORD_INFO` | `info@beautifulsnow.co.jp` のIMAPパスワード |
| `LOLIPOP_PASSWORD_UOTA` | `uota@beautifulsnow.co.jp` のIMAPパスワード |
| `TARGET_ADMIN_EMAIL` | email-explorer-ja側の管理者アカウントのメールアドレス |
| `TARGET_ADMIN_PASSWORD` | 同、パスワード |

IMAPホスト名がロリポップの標準（`imap.lolipop.jp:993`）と異なる場合は、Secretsの隣にある
「Variables」タブで `LOLIPOP_IMAP_HOST` / `LOLIPOP_IMAP_PORT` を追加で設定してください。

**実行方法:**

1. GitHubのリポジトリページ →「Actions」タブ
2. 左側の一覧から「IMAP Migration (Lolipop -> email-explorer-ja)」を選択
3. 右側の「Run workflow」ボタンをクリック
4. `mailbox_address` で対象のメールアドレスを選択、`dry_run` は最初は `true` のまま「Run workflow」
5. 実行後に表示されるログで、取得件数・件名を確認
6. 問題なければ、もう一度「Run workflow」を実行し、今度は `dry_run` を `false` にして実データを投入

**カスタムフォルダの確認:** デフォルトでは `INBOX` フォルダのみを移行します。ロリポップ側に
「送信済み」以外の独自フォルダがある場合は、先に「IMAP List Folders (Lolipop)」ワークフローを
実行してフォルダ名の一覧を確認し、`imap_folders` にカンマ区切りで指定してから移行を実行してください
（例: `INBOX,Sent,案件A`）。

## 使い方 ② ローカル環境で実行

```bash
cd tools/imap-migration
cp .env.example .env
# .env を実際の値で編集（IMAPパスワードなどの認証情報は絶対にコミットしないこと）
npm install
npm run migrate
```

デフォルトは `DRY_RUN=true` です。件数や対象メールのログだけを確認し、問題なければ `.env` の
`DRY_RUN=false` に変更して再実行してください。

## 注意事項

- `.env` はコミットしないでください（`.gitignore` で除外済みです）。
- このスクリプトは email-explorer-ja 側の管理者セッションを使い、`POST /api/v1/admin/mailboxes/:mailboxId/import`
  （送信は行わず、指定フォルダにそのままメールを保存する管理者専用API）を呼び出します。
- 何度でも再実行可能ですが、**重複インポート防止機能はありません**。再実行する場合は
  `LOLIPOP_IMAP_SINCE` で未取り込み分だけに絞り込んでください。
- 添付ファイルを含む大きなメールボックスでは時間がかかる場合があります。まずは `DRY_RUN=true` のまま
  1フォルダ・少数のメールで動作確認することを推奨します。
