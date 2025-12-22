# Streaming-Screen (OBS BrowserSource overlay)

`main.html` は OBS の BrowserSource として使える、シンプルな配信レイアウト用 HTML です。

- 左：ゲーム映像のための **1600×900 の透明エリア**（ここは“何も描画しない”のが仕様）
- 右：チャット用サイドバー（320px）
- 下：情報バー（180px）… 左から「ロゴ / お知らせ / X（旧Twitter）ID」

## ローカルで「何も表示されない」場合
このページは OBS 合成前提で **背景が完全に透明** です。
そのため、ブラウザで開くと「何もない」ように見えることがあります。

### プレビュー表示（おすすめ）
URL に `?preview=1` を付けると、背景とガイド枠が出て見えるようになります。

例：
- `main.html?preview=1`

## OBS の BrowserSource 設定目安
このレイアウト全体サイズ（HD固定）：

- 幅: 1600 + 320 = **1920**
- 高さ: 900 + 180 = **1080**

BrowserSource の幅/高さを **1920×1080** に設定してください。

## Railway でホストする（おすすめ）
このリポジトリは Railway でそのままデプロイできるように、Node(Express) で静的配信する設定を入れています。

1. Railway で New Project → GitHub Repo を選択
2. Deploy を実行（`package.json` を検知して自動ビルドされます）
3. デプロイ後の URL を OBS の BrowserSource に貼り付けます

### OBS で使うURL例
- 通常（透明合成向け）: `https://<your-app>.railway.app/`
- ローカルプレビュー相当: `https://<your-app>.railway.app/?preview=1`

※ Railway 側の PORT はプラットフォームが自動で渡すため、特別な環境変数設定は不要です。

## 管理ページ（Control）

`/control`（または `/control.html`）にアクセスすると、管理ページを開けます。

できること：

- **YouTubeコメント取得の ON/OFF**（OFF中は API を叩かないのでクォータ消費を防げます）
- 現在の状態表示（認可/チャンネル/配信中ライブ/クォータバックオフなど）
- 配信画面URLの生成（announce/xid/logo/chat など）

> 注意：管理ページは配信中の制御（ON/OFF）や設定保存ができるため、第三者に見せないでください。
> **推奨は Basic認証（`CONTROL_USER`/`CONTROL_PASS`）** で保護する運用です。

### 配信者に渡すもの（コピペ用チェックリスト）

- [ ] 管理ページURL：`https://<your-app>.railway.app/control`
- [ ] 管理ページのID：`CONTROL_USER` の値
- [ ] 管理ページのPW：`CONTROL_PASS` の値
- [ ] OBSに貼るURL（配信画面）：`https://<your-app>.railway.app/`
- [ ] （任意）チャットをiframeにしたい時のURL例：`https://<your-app>.railway.app/?chat=<URLエンコードしたポップアウトチャットURL>`
- [ ] （任意）初回確認用URL：`https://<your-app>.railway.app/?preview=1`

### 配信者がすること（コピペ用チェックリスト）

- [ ] `/control` を開いて、ログインダイアログに ID/PW を入力
- [ ] 「YouTubeにログイン（認可）」を押して **自分のYouTubeアカウント** で許可（初回だけ）
- [ ] 配信開始前後だけ「コメント取得をON」にする（配信してない時はOFF推奨＝クォータ節約）
- [ ] 画面下部のフォームで表示を整える（お知らせ / X ID / ロゴ / チャットURLなど）
- [ ] 「この内容を保存」を押す
- [ ] OBS の BrowserSource には配信画面URL（`/`）を貼る

補足：

- `?chat=...` を付けると iframe 表示が優先されます。**YouTube API を使わない**運用（クォータを使わない）にしたい時に便利です。
- コメント取得をONにするのは「配信中」だけがおすすめです（配信してない時にONだと無駄にAPIを叩きがちです）。

### 配信者に渡す手順（おすすめ運用）

1. 配信者は `https://<your-app>.railway.app/control` を開く
2. Basic認証のダイアログが出たら、管理者から渡された **ID/PW（CONTROL_USER/CONTROL_PASS）** を入力
3. 管理ページの「YouTubeにログイン（認可）」を押して、自分のYouTubeアカウントで許可
4. 配信開始前後だけ「コメント取得をON」にする（配信してない時はOFFでクォータ保護）
5. 画面下部のフォームで見た目（announce/xid/logo/chat等）を調整して「この内容を保存」
6. OBS の BrowserSource には `https://<your-app>.railway.app/` を貼り付け（保存した設定が反映されます）

※ `?chat=...` を設定すると iframe 表示が優先され、コメント最優先（クォータを使わない運用）もできます。

### 管理ページの保護（推奨：より簡単）

配信者に渡す前提の場合は、URLにトークンを付けるより **HTTP Basic認証（ID/PW）** の方が運用が簡単で漏れにくいです。
Railway Variables に以下を設定すると、管理ページが Basic 認証で保護されます。

- `CONTROL_USER` : 管理ページのユーザー名
- `CONTROL_PASS` : 管理ページのパスワード

#### どこで設定する？

- **Railwayで運用する場合**：Railway のプロジェクト画面 → **Variables** に `CONTROL_USER` と `CONTROL_PASS` を追加します。
- **ローカルで動かす場合（PowerShell）**：起動前に環境変数を設定してから `node server.js` を実行します。

配信者は `/control` を開くとブラウザのログインダイアログが出るので、ID/PW を入力するだけで使えます。

## YouTubeのスーパーチャット/メンバー通知（API連携・自作）

このプロジェクトは **YouTube Data API v3** を使ってライブチャットを定期取得し、
スーパーチャット/メンバー関連を検知したらオーバーレイに「特別通知（Toast）」を出せます。

仕組み（概要）：

1. サーバが OAuth 認可（Google）
2. サーバが `liveBroadcasts.list` → `liveChatId` を取得
3. サーバが `liveChatMessages.list` をポーリングしてイベントを抽出
4. サーバが SSE (`/api/events`) でブラウザへ配信
5. `main.html` が EventSource で受け取り、Toast 表示

### できること / できないこと

- ✅ スーパーチャット（`superChatDetails`）
- ✅ メンバーになりました（`newSponsorDetails`）
- ⚠️ メンバーシップギフトは、YouTube側の仕様上 **この取得方法では確実に検知できない/取りづらい** ケースがあります
	- 本プロジェクトでは今後「チャット内のシステムメッセージから推定」して通知する方式を追加できます（=保証なし）
	- 「ギフトだけは確実に欲しい」場合、StreamElements/Streamlabs等のアラート連携が安定です

### Google Cloud 側の準備

1) Google Cloud Console でプロジェクト作成
2) **YouTube Data API v3** を有効化
3) OAuth 同意画面を作成
4) OAuth クライアント（Webアプリ）を作成

### Railway 側で設定する環境変数

#### 必須（YouTube API連携を使う場合）

- `YT_CLIENT_ID` : OAuth Client ID
- `YT_CLIENT_SECRET` : OAuth Client Secret
- `YT_REDIRECT_URL` : OAuth コールバックURL（例： `https://<your-app>.railway.app/api/auth/callback`）
- `SESSION_SECRET` : ランダムな長い文字列（Cookie暗号化）

#### 任意（運用チューニング）

- `YT_ENABLED` : YouTubeコメント取得の初期スイッチ（`1`=ON, `0`=OFF。デフォルトはOFF）
- （任意）`YT_POLL_MS` : ポーリング間隔ms（デフォルト 10000）
- （任意）`YT_CHANNEL_TTL_MS` : `channels.list(mine=true)` の再取得間隔ms（デフォルト 6時間）
- （任意）`YT_BACKOFF_MAX_MS` : クォータ超過時の最大バックオフms（デフォルト 30分）

#### Railwayでよく使う（任意）

- `NODE_ENV=production` : 本番運用向け（Cookie secure を有効化したい場合）

#### 「任意の環境変数」はRailwayに追加しないと動きませんか？

追加しなくても大丈夫です。

- 上の「任意」な環境変数は、Railway Variables に設定しない場合でも **コード内のデフォルト値で動作**します
- つまり **必須4つ（YouTube連携を使うなら）だけ設定すれば起動自体は可能**です

注意点：

- 管理ページで切り替える **YouTubeコメント取得 ON/OFF（ytEnabled）** は、現状はメモリ上の状態です
	- Railway の再起動/再デプロイが入ると初期値（`YT_ENABLED` の値）に戻ります
	- 次の段階で「設定の保存（永続化）」を追加できます

#### クォータ超過（quotaExceeded）について（重要）

`poll error: The request cannot be completed because you have exceeded your quota.` が出る場合は、
**YouTube Data API の日次クォータを使い切っています**。

- 同じ Google Cloud プロジェクト（同じ `YT_CLIENT_ID` 側）で Data API を使う限り、基本的に **日次リセットまで回復しません**
- 本プロジェクトはクォータ超過を検知すると **自動でポーリングを一時停止（バックオフ）** します
- 明日以降も枯れにくくするには `YT_POLL_MS` を 10000〜15000 程度に上げるのがおすすめです

プレビューのステータスパネル（`?preview=1`）では以下が確認できます：

- `backoffUntil`：クォータ超過で停止している場合の「再開予定時刻」
- `effective`：実際に採用されたポーリング間隔（YouTube推奨の間隔が優先されます）

#### 重要：トークン（認可）は「配信者が自分で」行います

- `YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REDIRECT_URL` は **このシステムの管理者（あなた）** が Railway に設定します
	- これは「YouTube API を使うためのアプリ情報」で、配信者に配らないのが安全です
- 実際に YouTube の通知を出すための OAuth 認可（トークン）は、
	**配信する人（第三者）が自分のGoogle/YouTubeアカウントでログインして許可** します
	- 認可で得たトークンは **その配信者のブラウザ（Cookieセッション）に保存** されます
	- つまり「このURLを使って配信したい人」は、最初に一度だけ認可を済ませればOKです

> 注意：本実装は“各ブラウザごと”に認可状態を持ちます。
> 1つのRailway環境を複数人が使う場合、各配信者は自分のPC/OBSから認可してください。

#### HTTPS運用の注意

Railway の本番URLは HTTPS なので、Cookieの `secure` を true にしたい場合があります。
（現状は汎用性のため false にしています。必要ならこちらで自動判定に修正できます）

### 使い方（認可）

1) `main.html` を `?preview=1` 付きで開くと、右上付近に認可リンクが出ます
2) `YouTubeにログイン（認可）` をクリックして認可
3) ライブ配信が「配信中」になっている状態でスパチャ/メンバーが発生すると、左上に特別通知が出ます

### プレビューのステータス表示（おすすめ）

`?preview=1` を付けて開くと、左上に「デバッグ / ステータス」パネルが表示されます。

ここで確認できること：

- **OAuth設定 env OK / env NG**：`YT_CLIENT_ID` / `YT_CLIENT_SECRET` / `YT_REDIRECT_URL` がサーバに入っているか
- **authed / not authed**：このブラウザで認可（ログイン）済みか
- **live OK / no live**：配信中ライブ（active）が見つかって `liveChatId` を取れているか
- **status**：直近の取得状況やエラー（例："配信中のライブが見つかりません"）

トラブルが起きたらまずここを見れば、
「環境変数の問題 / 認可がまだ / 配信がまだ開始してない」の切り分けができます。

#### 配信者（第三者）に渡す説明（超短縮）

- OBS の BrowserSource にこのURLを設定
- まず一度 `?preview=1` を付けて開き、表示される「YouTubeにログイン（認可）」を押して自分のアカウントで許可
- あとは本番URLでOK（認可は基本的に維持されます）

### 動作テスト（API無しでも確認できる）

通知の見た目だけ確認したい場合：

- `/?notify=Thanks%21&notifyType=superchat`

（`notifyType` は `superchat` / `membership` / `gift` を想定しています）

## カスタマイズ（URLパラメータ）
ブラウザソースの URL に付けて変更できます。

- `announce` : お知らせ
- `xid` : X ID（`@...`）
- `channel` : チャンネル名（ロゴ未指定時のプレースホルダー文字に使用）
- `logo` : ロゴ画像 URL（URL エンコード推奨）
- `chat` : チャット iframe の URL（URL エンコード推奨）
- `logoZoom` : ロゴを枠内で拡大（例: `1.25`。範囲は 1.0〜1.6）

例：
- `main.html?preview=1&announce=Welcome%21&xid=%40my_x_id`

### 注意（YouTubeチャットのiframe）
YouTube 側の設定により iframe 埋め込みがブロックされることがあります。
その場合は、YouTube のポップアウトチャットを別 BrowserSource として追加する運用が確実です（このページの右側は見た目の枠として使えます）。

### 右のチャット欄（コメント表示）について

- YouTube API の認可が完了している場合、右のチャット欄には **YouTubeのコメントがリアルタイムに流れます**（SSEで配信）。
- `?chat=...` を指定した場合は **iframe表示が優先**されます（従来方式）。

#### フォールバック（コメント表示が最優先のとき）

クォータ超過中などで API 経由のコメント取得が止まった場合でも、
**コメント表示を優先したい**なら `?chat=...` の iframe に切り替えるのが最も確実です（Data APIを使いません）。

利用例（動画IDを `VIDEO_ID` に置き換え）：

- `/?chat=https%3A%2F%2Fwww.youtube.com%2Flive_chat%3Fv%3DVIDEO_ID%26embed_domain%3D<your-domain>`

※ `embed_domain` は Railway のホスト名（例：`xxxx.railway.app`）に合わせてください。
