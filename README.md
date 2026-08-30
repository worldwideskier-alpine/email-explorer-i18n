<div align="center">
  <a href="#">
    <h1 style="font-size: 4rem;">📧</h1>
    <h1>Email Explorer (多言語対応フォーク)</h1>
  </a>
</div>

<p align="center">
    <em>A modern, full-stack email client running entirely on Cloudflare Workers</em>
</p>

> **このリポジトリについて**
> 本リポジトリは [G4brym/email-explorer](https://github.com/G4brym/email-explorer)（MIT License）を元にした多言語対応（i18n）フォークです。
> オリジナルの著作権表示・ライセンス条項は `LICENSE` ファイルにそのまま保持しています。多言語化は本フォークで追加した変更です。

## 多言語対応について

画面は **72言語** で使えます。ログイン画面を含むどの画面からでも右上のセレクタで切り替えられ、選んだ言語はブラウザの localStorage に残ります。

**まだ何も選んでいない初回だけ**、ブラウザの言語設定（`navigator.languages`）を見て、対応するものがあればその言語で開きます。無ければ日本語です。**保存された選択が常に優先**されます — 言語を選ぶのは意思表示であり、端末の設定がそれを覆してはならないためです（`resolveBrowserLocale` と `initialLocale.test.ts`）。ブラウザは国を送ってくる（`zh-TW`）のにこちらは字体で持っている（`zh-Hant`）ので、その対応付けだけは表で持っています。

対象は、東アジア6言語、ヨーロッパ42言語、西アジア・中東3言語、南アジア13言語、東南アジア8言語です。「どの言語が重要か」という判断ではなく、地域ごとに線を引いて機械的に決めています。後から見て検証できる基準のほうが、好みで選んだ一覧より維持しやすいためです。

**西アジア・中東**は、その地域の国家公用語のうち**ヨーロッパに既に入っているもの**（欧州評議会加盟国であるアルメニア・アゼルバイジャン・ジョージア・トルコ・キプロス）を除いた残りです。残るのはアラビア語・ヘブライ語・ペルシア語の3つ。ペルシア語をここに置いたのは、国連の統計上の区分では南アジアに入るものの、それ以外のどの読み方でもこの地域に属し、本フォークの「南アジア」はインド亜半島を指しているためです。クルド語はイラクの公用語なのでこの線の内側に入りますが、今回の合意に含まれていなかったので見送っています（原則が排除しているわけではありません）。

ヨーロッパの線引きは**主権国家の公用語・国語**で、地図には欧州評議会の加盟国を使っています。Հայերեն・Azərbaycan dili・ქართული・Türkçe が入っているのはそのためです。バスク語・ウェールズ語・フェロー語のような州や地域の公用語はこの線の外側です。Rumantsch はスイスの国語なので内側に入ります。ノルウェー語を Norsk bokmål と Norsk nynorsk の2つで持つのは、中国語を字体で2つに分けたのと同じ理屈で、どちらもノルウェーの公式な書記標準だからです。

| 地域 | 言語 |
|---|---|
| 東アジア | 日本語, 한국어, Монгол, 廣東話, 简体中文, 繁體中文 |
| ヨーロッパ | Azərbaycan dili, Беларуская, Български, Bosanski, Català, Crnogorski, Čeština, Dansk, Deutsch, Ελληνικά, English, Español, Eesti, Suomi, Français, Gaeilge, Hrvatski, Magyar, Հայերեն, Íslenska, Italiano, ქართული, Lëtzebuergesch, Lietuvių, Latviešu, Македонски, Malti, Norsk bokmål, Nederlands, Norsk nynorsk, Polski, Português, Rumantsch, Română, Русский, Slovenčina, Slovenščina, Shqip, Српски, Svenska, Türkçe, Українська |
| 西アジア・中東 | العربية, فارسی, עברית |
| 南アジア | বাংলা, ગુજરાતી, हिन्दी, ಕನ್ನಡ, മലയാളം, मराठी, नेपाली, ଓଡ଼ିଆ, ਪੰਜਾਬੀ, සිංහල, தமிழ், తెలుగు, اردو |
| 東南アジア | Filipino, Bahasa Indonesia, ខ្មែរ, ລາວ, Bahasa Melayu, မြန်မာ, ไทย, Tiếng Việt |

中国語は `zh` ひとつではなく **`zh-Hans` 简体中文 と `zh-Hant` 繁體中文 の2つ**で持っています。読み手が選ぶ必要があるのは国ではなく字体だからです。**`yue` 廣東話 はさらに別立て**にしました。香港・マカオの公用語であり、書き言葉としても繁体字の書き換えでは済まず、語彙と文法が違うためです。

各言語の短い概要を [`docs/readme/`](docs/readme/README.md) に1言語1ファイルで置いています。README全文の翻訳ではありません。全文を72言語ぶん維持するのは現実的ではなく、古びた訳文が並ぶくらいなら短くても正しいほうがよいと判断しました。

### 実装上の約束ごと

- ダッシュボード（`packages/dashboard`）は [vue-i18n](https://vue-i18n.intlify.dev/) を使用しています。翻訳文字列は `packages/dashboard/src/locales/<code>.json` に1言語1ファイルで置き、キー構成は `en.json` と完全に一致させます（1言語あたり342キー）。
- **選択肢に出す言語は `locales/registry.ts` が唯一の情報源**です。カタログが無い言語を登録することも、登録されていないカタログを置くこともできません。`locales/messages.test.ts` が両方向を検査して落とします。英語へ素通しで落ちる言語を選択肢に出すくらいなら、出さないほうがましだからです。
- **カタログの値に `@` と `|` を書いてはいけません。** vue-i18n は `@` をリンクキー、`|` を複数形の区切りとして解釈するため、素で入れるとそのメッセージは描画時にコンパイルエラーになります。厄介なのは、ビルドも型検査も他のテストも緑のまま画面だけが落ちることです（実際に `recipient@example.com` をプレースホルダに入れて作成画面を丸ごと壊しました）。`messages.test.ts` は全カタログの全メッセージを実際にコンパイルして、これを検出します。
- カタログは `import.meta.glob` で**必要になった言語だけ**取得します。初回ロードでは既定言語と英語のフォールバックだけを読み、言語を選んだ時点でそのチャンクを1つ取りに行きます。72言語を最初から読むと初回の転送量が跳ね上がるためです。
- 右横書きは**アラビア語・ペルシア語・ヘブライ語・ウルドゥー語の4言語**です。`registry.ts` の `dir: "rtl"` が `<html dir>` に反映され、**レイアウトは左右反転します**。方向を持つ余白・位置・枠線は論理プロパティ（`ms-`/`me-`/`ps-`/`pe-`/`start-`/`end-`/`border-e`）で書いてあり、行き先を指す矢印は `rtl:-scale-x-100` で向きを返します。中央寄せの `left-1/2` と `-translate-x-1/2` は左右対称なので物理のままです。
  
  RTL が1言語だった間はここを後回しにしていました。69分の1では実害が測れなかったためです。アラビア語を足した時点でその理由が消えたので、同じコミットで直しています。
- `apiErrors` のキーだけはサーバが返す英語文字列そのままです（対応表として使うため）。値のみ翻訳しています。

### Worker が送信するメールについて

- **Worker が送信するメール**（`packages/worker/src/mail-templates.ts`：パスワード再設定・メールアドレス変更の確認）も**72言語すべてに対応しています**。2通で文面が同じ2文（リンクのコピー案内と有効期限）は `EMAIL_CHANGE` 側で書かず `PASSWORD_RESET` から取っているので、この半分は原理的にズレません。

  `MAIL_LOCALES` は**UIの72言語と同じ集合でなければなりません**。ダッシュボードは表示中のロケールをそのまま送り、Worker 側は `z.enum(MAIL_LOCALES)` で検証するため、リストから漏れたコードは日本語にフォールバックするのではなく **400 で弾かれ、メールが1通も送られません**。しかも画面には「アカウントがあればリンクを送りました」と出るので気づけません（実際に、UIを72言語に増やしたときこのリストが3言語のままで、66言語でパスワード再設定が死んでいました）。`packages/dashboard/src/locales/mailLocales.test.ts` が両者の集合一致を検査します。

## Cloudflareへのデプロイについて

このリポジトリのコードはデプロイ可能な状態ですが、実際に Cloudflare 上へ `wrangler deploy` を実行するには、ご自身の Cloudflare アカウントと API トークンが必要です。認証情報を安全に管理するため、デプロイはご自身の環境から実行してください。手順はオリジナルプロジェクトの [Getting Started](#getting-started) を参照してください。

> **Cloudflare側のリソース名について**
> Worker名・R2バケット名・公開URL（`email-explorer-ja.<subdomain>.workers.dev`）は、リポジトリ名とは別に `email-explorer-ja` のままです。
> Worker名を変更すると別のWorkerとして作成され、Durable Objectに保存されている全メールが引き継がれないため、意図的に据え置いています。
> 公開URLを変えたい場合は、Worker名の変更ではなくカスタムドメインの割り当てを使用してください。

### CI／デプロイの実行タイミング

GitHub Actions の消費分数を抑えるため、`main` への push で走るワークフローは **Deploy to Cloudflare の1つだけ**です。

| ワークフロー | 実行タイミング | 内容 |
|---|---|---|
| **Deploy to Cloudflare** | `main` への push（`docs/**`・`README.md`・`LICENSE`・`.editorconfig` のみの変更を除く）、Pull Request、手動 | lint → build → テスト → デプロイ |
| **Cloudflare Email Routing status** | 手動のみ | Email Routing の設定を読み出すだけ（変更は行わない） |

Pull Request では Deploy to Cloudflare の `build-and-check` ジョブだけが走り、デプロイは `main` への push のときだけ行われます。以前あった Build ワークフローは、この `build-and-check` と同じ lint → build → テストを二重に回していたので削除しました。

上流のnpmリリース自動化（Release / Changeset Check）は削除しました。本フォークはCloudflareへのデプロイで配布しており、`email-explorer` のnpmパッケージ名は上流のものだからです。

`main` へ push すれば、そのままCloudflareへデプロイされます。ドキュメントだけの変更ではデプロイは走りません（デプロイしたい場合は Actions から Deploy to Cloudflare を手動実行してください）。

## バックアップと復元

**バックアップ**は設定画面の「mbox形式で書き出す」です。メールボックス全体を mbox 形式で書き出します。受信したメールは保存してある生データそのまま、ここで作成したメールは添付ファイルを含めて再構成して書き出します。

**復元**は同じ設定画面の「バックアップからの復元」です（**管理者にのみ表示**されます）。書き出した mbox を読み込み、**元のフォルダ・既読・スター・日時のまま**メールを戻します。アーカイブにあってメールボックスに無いフォルダは作成します。

- **2回実行しても安全です。** 各メールは書き出し時のIDを持ち歩き、Worker は既にあるIDを `duplicate` として返して何も書きません。途中で失敗した復元は、そのままもう一度実行すれば続きから埋まります。
- 分割はブラウザ側で行い、**1通ずつ** `POST /api/v1/admin/mailboxes/:mailboxId/import` に投げます。mbox はメールボックスと同じ大きさになり得るので、1リクエストには載りません。1通ずつなら進捗も出せます。
- 別のメールボックスに復元した場合、IDは再利用されません（R2 のキーはメールボックス別ではないため、元のメールの生データを上書きしてしまいます）。この場合は新しいIDが振られ、重複排除も効きません。

書き出し側は、メール本体には無い情報を独自ヘッダで持ち回ります。他のクライアントは知らないヘッダを無視するので、Thunderbird などでもそのまま読めます。

| ヘッダ | 内容 |
|---|---|
| `X-Email-Explorer-Id` | 保存時のID。復元の冪等性はこれで担保されます |
| `X-Email-Explorer-Folder` | フォルダ**名**（IDではありません。日本語名のフォルダのIDはランダムなuuidで、他のメールボックスでは意味を持たないため） |
| `X-Email-Explorer-Read` / `-Starred` | 既読・スター |
| `X-Email-Explorer-Date` | メールボックスが記録した日時 |

### 添付ファイルの送信

作成画面からファイルを添付できます。合計 **20 MB** まで。Resend の上限は40MBですが、base64 で 4/3 に膨らむこと、そして25MB あたりで弾く受信サーバーが多いことから、ここで断る方が先で届かないよりましだという判断です。上限超過は送信前に拒否します（符号化済みの本文を無駄に送らないため）。

**一時保存に添付は含まれません。** 下書きAPIが添付を受け取らないためで、その旨を添付一覧の下に出しています。

添付のバイト列は `base64ToBytes`（`packages/worker/src/base64.ts`）で復号します。`atob()` が返すのは文字列で、それを R2 に `put` すると UTF-8 で符号化され、**0x80 以上のバイトが2バイトに膨らんで壊れます**。Resend には base64 のまま渡るので送信自体は正常に届き、壊れるのは自分側の控えだけ ── ダウンロード、mbox エクスポート、バックアップからの復元です。送信者は気づく理由がなく、気づいた頃には原本がありません。

この破損は作成画面に添付UIが無かったため一度も発火していませんでしたが、UIを付けた瞬間に効き始めるものでした。既存の添付テストが全て `test.txt` だったのが見落とした理由です ── ASCII は、壊れた実装と正しい実装の結果が一致する唯一の入力です。`attachment-bytes.test.ts` は 0x89 から 0xFF までを含むバイト列で往復を確認します。

### 自動バックアップ

設定画面で有効にすると、**毎日 / 毎週 / 毎月**の間隔でメールボックス全体を mbox として R2 の `backups/<メールボックス>/` に書き出します。保存数を超えたぶんは古いものから消えます。cron は1日1回（18:00 UTC＝03:00 JST）発火し、メールボックスごとの頻度設定で「今回書き出すか」を判断します。

書き出しは R2 の**マルチパートアップロード**で行います。R2 は長さの分からないストリームを受け付けないため、また全体をメモリに載せるとメールボックスの大きさに上限ができてしまうためです（バックアップが最も要る大きなメールボックスほど失敗する）。

#### この機能が守るもの、守らないもの

**アプリ側でバックアップを消す手段はありません。** 削除エンドポイントもボタンも無く、消えるのは保存数を超えたぶんの回転だけです。したがって**このアプリの管理者パスワードが漏れた場合**、攻撃者はメールを破壊できてもその写しは壊せず、メールは戻せます。これがこの設計が想定している脅威です。

**Cloudflare アカウントの喪失や乗っ取りは守れません。** それを持つ者はこのアプリを一切通らず R2 に直接届きます。バックアップは元のメールと同じバケットにあります。

回転から2つの帰結があります。

- **メールを空にして待てば、良い写しは回転で流れていきます。** 件数だけで回していた頃、かかる時間は「頻度 × 保存数」でした（毎日×30なら猶予は30日）。30日は気づける保証としては短いので、件数とは別に**直近12か月それぞれの最新1個を残す**世代を足しました。猶予はおよそ1年になります。
- したがって**保存数を下げることは、1周期遅れの削除ボタン**になります。そのため**保存数は増やせるだけで、減らせません**（`mergeMailboxSettings` が拒否します）。下げるには Cloudflare 側の権限が要ります。代償は、大きくしすぎた保存数の保管コストを下げられないことです。**月次の世代は設定にせず定数**（`MONTHLY_TIERS`）にしてあります。下げられるつまみは、それ自体が1周期遅れの削除経路だからです。

#### なぜ「急に小さくなったら回転を止める」ではないのか

同じ穴を塞ぐ案として、新しいアーカイブが直前より極端に小さければ回転を止める、という方法がまず思いつきます。採りませんでした。

|  | 縮小検知 | 月次の世代 |
|---|---|---|
| ゆっくり削除（1日10%ずつ）に効くか | 効かない | 効く |
| 誤検知 | 迷惑メールの一括削除・ゴミ箱を空にする等で発生 | 起きない |
| 閾値の調整 | 必要。正しく当てるのが難しい | 不要 |
| 猶予 | 頻度 × 保存数 | 約1年 |
| 費用 | — | 最大12個ぶんの保管料 |

判断を持たない仕組みは、判断を間違えません。世代化は縮小検知が守る範囲を完全に含みつつ、日常の片付けを障害に変えません。

なお、**アプリ側の細工より確実な手段は Cloudflare 側にあります**（R2 のバケットロック等でオブジェクト自体を一定期間削除不能にする）。この環境から検証できていないため未採用ですが、使えるならそちらが本筋です。

**最終実行の結果（成功／失敗・件数・時刻）を設定画面に出します。** 黙って止まったバックアップは、無いバックアップより悪いためです。「3月から動いていない」がログを見に行かずに分かります。

### 既存メールサーバーからの移行（IMAPインポート）

過去メールの取り込みにも同じ `POST /api/v1/admin/mailboxes/:mailboxId/import`（管理者専用・送信は行わずメールを保存するAPI）が使えます。`folder` はフォルダIDでも表示名でも解決し、無ければ作成します。

かつて `tools/imap-migration/` に置いていたIMAP移行スクリプトと、それを実行するGitHub Actionsワークフローは削除しました。
移行が完了して不要になったこと、そして移行元ホスト・移行先URL・対象メールアドレスといった運用先固有の情報を
公開リポジトリに残す理由がないためです。必要になった場合はコミット `44dbb99` 時点の履歴から取り出せます。

<p align="center">
    <a href="https://github.com/G4brym/email-explorer/commits/main" target="_blank">
      <img src="https://img.shields.io/github/commit-activity/m/G4brym/email-explorer?label=Commits&style=social" alt="Email Explorer Commits">
    </a>
    <a href="https://github.com/G4brym/email-explorer/issues" target="_blank">
      <img src="https://img.shields.io/github/issues/G4brym/email-explorer?style=social" alt="Issues">
    </a>
    <a href="https://github.com/G4brym/email-explorer/blob/main/LICENSE" target="_blank">
      <img src="https://img.shields.io/badge/license-MIT-brightgreen.svg?style=social" alt="Software License">
    </a>
</p>

# Email Explorer

Email Explorer is a full-stack, serverless email client that runs entirely on your own Cloudflare account. It provides a modern, fast, and secure way to manage your emails using Cloudflare's powerful infrastructure, including Workers, R2, Durable Objects, Email Routing, and Email Sending.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/G4brym/email-explorer/tree/main/template)

## Table of Contents

- [Overview](#overview)
- [Why Email Explorer?](#why-email-explorer)
- [Key Features](#key-features)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [Documentation](#documentation)
- [Architecture](#architecture)
- [Production Ready Features](#production-ready-features)
- [Testing](#testing)
- [Roadmap & Future Enhancements](#roadmap--future-enhancements)
- [Known Limitations](#known-limitations)
- [Security](#security)
- [Contributing](#contributing)
- [Support](#support)
- [License](#license)

## Quick Links

- 📖 **[User Guides](docs/features/index.md)** - Complete documentation for all features
- 🚀 **[Getting Started](#getting-started)** - Deploy in minutes
- 🔐 **[Authentication](docs/features/authentication.md)** - Setup your first account
- 🔑 **[Account Recovery](docs/features/account-recovery.md)** - Password reset via email
- 👥 **[Admin Panel](docs/features/admin-panel.md)** - Manage users and permissions
- ⚙️ **[Configuration](#configuration)** - Customize your deployment

## Overview

Email Explorer gives you a private, self-hosted email solution with a user-friendly web interface. By leveraging the Cloudflare ecosystem, it offers a cost-effective and scalable alternative to traditional email hosting. All your data is stored securely in your own R2 buckets and Durable Objects, giving you full control over your information.

### Screenshots

<div align="center">
  <img src="docs/home.png" alt="Email Explorer Home" width="600" />
  <p><em>Mailbox management and email list view</em></p>
</div>

<div align="center">
  <img src="docs/new-email.png" alt="Email Composer" width="600" />
  <p><em>Rich text email composer with formatting options</em></p>
</div>

## Why Email Explorer?

**🔒 Privacy First**
- All data stays in YOUR Cloudflare account
- No third-party tracking or analytics
- You control your data completely

**💰 Cost-Effective**
- Runs on Cloudflare's generous free tier
- Pay only for what you use beyond free limits
- No monthly subscription fees

**⚡ Performance**
- Built on Cloudflare's global edge network
- Fast loading times worldwide
- Serverless architecture scales automatically

**🎨 Modern Experience**
- Clean, intuitive interface
- Rich text email composition
- Mobile-responsive design

**🛠️ Easy Setup**
- Deploy with one click
- Automatic mailbox creation
- Smart authentication setup

> **Note:** To send emails, you need to have [Cloudflare Email Sending](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/) enabled on your account. Receiving emails works through [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/).

> **Note:** When you first load your worker, there will be no mailboxes. They are automatically created when you start receiving emails.

## Key Features

- **🔒 Secure & Private**: Self-hosted on your Cloudflare account. No third-party tracking or data scanning.
- **🔐 Smart Authentication**: Automatic first-user admin setup with role-based access control and secure session management.
- **👥 Multi-User Support**: Admin panel for managing users and mailbox permissions with granular roles (Owner, Admin, Write, Read).
- **✍️ Rich Text Editor**: Full-featured WYSIWYG editor with formatting, colors, links, lists, and more - just like Gmail or Outlook.
- **↩️ Reply & Forward**: Reply to sender, reply all, or forward emails with automatic quoting and threading support.
- **✉️ Email Management**: Send, receive, and organize emails with a clean and intuitive interface.
- **📁 Folder Organization**: Create custom folders to organize your emails.
- **📎 Attachment Support**: View and download attachments directly in the browser.
- **🔍 Search**: Find emails quickly with full-text search across all your mailboxes.
- **📧 Contacts**: Manage your contacts with an integrated address book.
- **⚡ Serverless Architecture**: Each mailbox is its own Durable Object for optimal performance and isolation.

## Prerequisites

Before deploying Email Explorer, make sure you have:

- **Cloudflare Account** - [Sign up for free](https://dash.cloudflare.com/sign-up)
- **Domain Name** - Added to your Cloudflare account
- **Email Routing** - [Enable Email Routing](https://developers.cloudflare.com/email-routing/) for receiving emails
- **Email Sending** - [Enable Email Sending](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/) for sending emails (optional but recommended)
- **Node.js 18+** - For local development (not required for deployment)

**Cloudflare Services Used:**
- Workers (Compute)
- Durable Objects (State management)
- R2 (Object storage)
- D1 (SQL database via Durable Objects)
- Email Routing (Receive emails)
- Email Sending (Send emails)

Most of these services have generous free tiers that are sufficient for personal use.

## Getting Started

To deploy Email Explorer, you can use the "Deploy to Cloudflare" button above or run this command:

```bash
npm create cloudflare@latest -- --template=https://github.com/G4brym/email-explorer/tree/main/template
```

**Or deploy manually:**

```bash
# Clone the repository
git clone https://github.com/G4brym/email-explorer.git
cd email-explorer

# Install dependencies
pnpm install

# Deploy to Cloudflare
pnpm --filter email-explorer deploy
```

### Configuration

Email Explorer uses a factory function pattern for configuration. Edit `src/index.ts`:

```typescript
// Recommended: Smart Mode (Default)
export default EmailExplorer({
  auth: {
    enabled: true
    // registerEnabled not specified = smart mode
  },
  accountRecovery: {
    fromEmail: 'noreply@yourdomain.com'  // Optional: enable password reset via email
  }
})
```

**Smart Mode (Recommended):**
- First user to register automatically becomes admin
- Registration closes after first user
- Admins can create additional users via admin panel
- Perfect for production deployments

**Other Modes:**
```typescript
// Open Registration (Development/Testing)
export default EmailExplorer({
  auth: {
    enabled: true,
    registerEnabled: true  // Anyone can register
  }
})

// No Authentication (Single User)
export default EmailExplorer({
  auth: {
    enabled: false
  }
})

// With Account Recovery
export default EmailExplorer({
  auth: {
    enabled: true
  },
  accountRecovery: {
    fromEmail: 'noreply@yourdomain.com'  // Email address to send password reset links from
  }
})
```

**Configuration Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `auth.enabled` | boolean | `true` | Enable/disable authentication |
| `auth.registerEnabled` | boolean | `undefined` (smart mode) | Control user registration |
| `accountRecovery.fromEmail` | string | `undefined` (disabled) | Enable password recovery via email |

**Account Recovery:**
- When configured, users can reset forgotten passwords via email
- The `fromEmail` address must be a valid email on your Cloudflare account
- Requires [Cloudflare Email Sending](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/) to be enabled
- See [Account Recovery Guide](docs/features/account-recovery.md) for more details

### First-Time Setup

1. **Deploy your worker** with smart mode enabled (default)
2. **Visit your worker URL** in a browser
3. **Register the first user** - this becomes your admin account
4. **Log in** with your admin credentials
5. **Manage additional users** through the admin panel

### Admin Operations

As an admin, you can:
- Create new users
- Grant/revoke mailbox access
- Assign roles: `owner`, `admin`, `write`, or `read`
- Promote users to admin status

## Documentation

Comprehensive user guides are available for all features:

- **[Feature Documentation](docs/features/index.md)** - Complete user guides
  - [Authentication Guide](docs/features/authentication.md) - Account creation, login, and security
  - [Account Recovery Guide](docs/features/account-recovery.md) - Password reset via email
  - [Admin Panel Guide](docs/features/admin-panel.md) - User management and permissions
  - [Rich Text Editor Guide](docs/features/rich-text-editor.md) - Email formatting and composition
  - [Reply & Forward Guide](docs/features/reply-forward.md) - Email responses and threading

For developers:
- **[AGENTS.md](AGENTS.md)** - Architecture, layout and development guide

## Architecture

Email Explorer is built with modern web technologies:

**Backend (Worker):**
- **Hono** - Fast, lightweight web framework
- **Cloudflare Durable Objects** - Distributed state management
- **Cloudflare R2** - Object storage for attachments
- **Cloudflare D1** - SQL database (via Durable Objects)
- **Cloudflare Email Routing** - Email sending and receiving

**Frontend (Dashboard):**
- **Vue.js 3** - Progressive JavaScript framework
- **TypeScript** - Type-safe development
- **Tailwind CSS** - Utility-first styling
- **TipTap** - Rich text editor
- **Pinia** - State management
- **Vite** - Fast build tooling

## Production Ready Features

✅ **Authentication & Security**
- Smart mode with automatic admin setup
- Session-based authentication (30-day expiry)
- Password hashing with Web Crypto API
- HttpOnly, Secure, SameSite cookies
- Role-based access control (RBAC)

✅ **Email Capabilities**
- Send and receive emails
- Reply and reply-all functionality
- Forward emails to others
- Rich text HTML composition
- Email threading and conversation tracking
- Attachment handling

✅ **User Management**
- Admin panel for user creation
- Granular mailbox permissions (Owner, Admin, Write, Read)
- Multi-user support with isolation
- Access grant and revoke capabilities

✅ **Organization**
- Custom folder creation
- Contact management
- Full-text email search
- Email filtering and organization

## Testing

Two suites, both run by CI before a deploy:

- **Worker** — Vitest on `@cloudflare/vitest-pool-workers`, so tests run in
  the same runtime as production, against real Durable Object and R2 bindings.
- **Dashboard** — Vitest on jsdom, for logic that needs a DOM but no server
  (e.g. the HTML-to-plain-text conversion behind the composer's plain-text
  mode and the `text/plain` part of every outgoing message).

```bash
# Both suites -- what CI runs
pnpm test

# One suite at a time
pnpm test-worker
pnpm test-dashboard

# A single worker test file, or watch mode while developing
pnpm --filter email-explorer test auth
pnpm --filter email-explorer test --watch
```

**Test Coverage:**
- ✅ Authentication flows (registration, login, sessions)
- ✅ Password hashing, sign-in rate limiting, account-enumeration defences
- ✅ Admin operations (user management, access control)
- ✅ Email operations (send, receive, folders)
- ✅ Search and filtering
- ✅ Contacts and attachments
- ✅ Security validations
- ✅ HTML-to-plain-text conversion (quoting, stylesheet stripping, tables)

## Roadmap & Future Enhancements

Not implemented yet, roughly in the order they would be useful:

- [ ] Attaching files when composing — the send API accepts attachments, but
      the composer has no way to pick one
- [ ] Drafts saved automatically rather than only on "save draft"
- [ ] A threaded conversation view — messages already carry their threading
      headers, the list just doesn't group by them
- [ ] Email templates for quick responses
- [ ] Two-factor authentication (2FA)
- [ ] Keyboard shortcuts
- [ ] Emoji picker and tables in the rich-text editor
- [ ] Uploading an image into a message body (inserting one by URL works)


## Known Limitations

**Current Limitations:**
- No email draft auto-save (manual save only)
- Image uploads not yet supported (URLs work)
- Single mailbox per user account (multiple access supported)

**Optional Features:**
- Password reset via email requires `accountRecovery.fromEmail` configuration

**Browser Compatibility:**
- Modern browsers required (Chrome 90+, Firefox 88+, Safari 14+)
- JavaScript must be enabled
- Cookies must be enabled for authentication

Please report any issues on our [GitHub Issues](https://github.com/G4brym/email-explorer/issues) page.

## Security

Email Explorer takes security seriously:

**🔐 Authentication Security**
- Passwords hashed with PBKDF2-SHA256, 100,000 iterations, per-user salt.
  Accounts created before this used an unsalted single-round SHA-256; those
  hashes are still accepted and are rewritten in place on the owner's next
  successful sign-in, so nobody has to reset a password.
- Sign-in is rate limited per address and per IP. The counters live in the
  auth Durable Object, so they hold across colos rather than resetting with
  every isolate.
- Password reset is rate limited the same way and answers identically whether
  or not the address has an account, so it can't be used to find out which
  addresses are worth attacking.
- The OpenAPI schema and docs (`/openapi.json`, `/docs`) require a session
- HttpOnly, Secure, SameSite cookies prevent XSS/CSRF
- 30-day session expiry for automatic logout
- Session tokens use cryptographic randomness

**🛡️ Data Protection**
- All data stored in YOUR Cloudflare account
- Email content rendered in sandboxed iframes
- No third-party data sharing
- Role-based access control (RBAC)

**🔒 Best Practices**
- Always use HTTPS (automatic with Cloudflare)
- Keep dependencies updated
- Regular security audits via GitHub Dependabot
- Comprehensive test coverage

**⚠️ Security Recommendations**
- Use strong, unique passwords (8+ characters)
- Enable Cloudflare's security features
- Regularly review user access permissions
- Log out from shared devices

**Report Security Issues:**
For security vulnerabilities, please email security issues privately rather than opening public issues.

## Contributing

We welcome contributions from the community! Here's how you can help:

**🐛 Bug Reports**
- Use the [GitHub Issues](https://github.com/G4brym/email-explorer/issues) page
- Include reproduction steps
- Specify your environment (browser, Cloudflare setup)

**✨ Feature Requests**
- Check existing issues first
- Explain the use case and benefit
- Consider submitting a PR if you can implement it

**💻 Code Contributions**
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes with tests
4. Commit your changes (`git commit -m 'Add amazing feature'`)
5. Push to the branch (`git push origin feature/amazing-feature`)
6. Open a Pull Request

**📖 Documentation**
- Help improve user guides
- Fix typos or clarify instructions
- Add examples and use cases

**Development Setup:**
```bash
# Clone the repository
git clone https://github.com/G4brym/email-explorer.git
cd email-explorer

# Install dependencies
pnpm install

# Run tests
pnpm --filter email-explorer test

# Start development
pnpm --filter email-explorer dev
pnpm --filter dashboard dev
```

## Support

- **📖 Documentation**: Check [docs/features/](docs/features/) for user guides
- **💬 Discussions**: Use GitHub Discussions for questions
- **🐛 Issues**: Report bugs via GitHub Issues
- **📧 Email**: For security issues only

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

**Made with ❤️ for the self-hosted community**

If you find Email Explorer useful, please consider giving it a ⭐ on GitHub!
