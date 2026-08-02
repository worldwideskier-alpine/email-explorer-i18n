# IMAP Migration Tool

`beautifulsnow.co.jp` のように、既存のIMAPメールサーバー（例: ロリポップ！レンタルサーバー）から
[email-explorer-ja](../../README.md) へ過去メールを取り込むための、ローカル実行用の移行スクリプトです。

## 想定している移行手順

1. **email-explorer-ja を先にデプロイ**し、移行先の管理者アカウントを作成しておく。
2. **このスクリプトで既存メールをコピー**する（ロリポップ側のMXはまだ変更しない。既存メール受信には影響なし）。
3. コピーが完了・確認できたら、**Cloudflareダッシュボードで `beautifulsnow.co.jp` のEmail Routingを有効化**し、MXをCloudflare側へ切替（この時点から新着メールは email-explorer-ja に届く）。
4. 切替直前にロリポップへ届いた分の取りこぼしがないよう、`LOLIPOP_IMAP_SINCE` を使って**差分同期を1回追加実行**する。

## 使い方

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
