# Streaming-Screen (OBS BrowserSource overlay)

`main.html` は OBS の BrowserSource として使える、シンプルな配信レイアウト用 HTML です。

- 左：ゲーム映像のための **1600×900 の透明エリア**（ここは“何も描画しない”のが仕様）
- 右：チャット用サイドバー（360px）
- 下：情報バー（100px）… 左から「ロゴ / お知らせ / X（旧Twitter）ID」

## ローカルで「何も表示されない」場合
このページは OBS 合成前提で **背景が完全に透明** です。
そのため、ブラウザで開くと「何もない」ように見えることがあります。

### プレビュー表示（おすすめ）
URL に `?preview=1` を付けると、背景とガイド枠が出て見えるようになります。

例：
- `main.html?preview=1`

## OBS の BrowserSource 設定目安
このレイアウト全体サイズ：
- 幅: 1600 + 360 = **1960**
- 高さ: 900 + 100 = **1000**

BrowserSource の幅/高さを **1960×1000** に設定してください。

## カスタマイズ（URLパラメータ）
ブラウザソースの URL に付けて変更できます。

- `announce` : お知らせ
- `xid` : X ID（`@...`）
- `channel` : チャンネル名（ロゴ未指定時のプレースホルダー文字に使用）
- `logo` : ロゴ画像 URL（URL エンコード推奨）
- `chat` : チャット iframe の URL（URL エンコード推奨）

例：
- `main.html?preview=1&announce=Welcome%21&xid=%40my_x_id`

### 注意（YouTubeチャットのiframe）
YouTube 側の設定により iframe 埋め込みがブロックされることがあります。
その場合は、YouTube のポップアウトチャットを別 BrowserSource として追加する運用が確実です（このページの右側は見た目の枠として使えます）。
