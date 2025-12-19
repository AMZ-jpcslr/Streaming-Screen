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
