# tw-bookmarks

X のブックマークを自分の VPS にためて、振り返る・噛み砕くための道具。外部ライブラリは使わない（Node.js の標準機能だけ）。

仕様書: https://claude.ai/artifact/5UqrEHGw9JjGDAQVet45UN

## 段階

1. **見られる**（このコミット）: 過去分の書き出しを取り込み、Tailscale の中から一覧・検索・詳細を見る
2. 噛み砕ける: 専用ユーザー `tw-study` の Claude Code に ID を渡し、メモを残す
3. 自動で増える: X API でブックマークを1時間ごとに取り込む

## 構成

| 場所 | 中身 | 書けるのは |
| --- | --- | --- |
| `/var/lib/tw-bookmarks/posts/<投稿ID>.md` | 元の投稿（前付けに投稿者・日時・画像・引用元、本文がその下） | tw-fetch |
| `/var/lib/tw-bookmarks/media/<投稿ID>/` | 画像（写真は原寸、動画はサムネイル） | tw-fetch |
| `/var/lib/tw-bookmarks/notes/*.md` | 噛み砕いたメモ。前付けの `posts` に関係する投稿ID | tw-study（段階2） |
| `/var/lib/tw-bookmarks/status/fetch.json` | 自動取り込みの結果（段階3） | tw-fetch |

- 画面（`server.js`、ユーザー tw-bookmarks）は読むだけ。127.0.0.1:3050 で待ち受け、Caddy が Tailscale 側の `/tw/` を渡す
- `/var/lib/tw-bookmarks` は毎日のサーバー外バックアップに自動で含まれる
- 投稿の本文は他人が書いたデータ。画面ではすべてエスケープし、CSP で自分のサーバー以外のスクリプト・画像を読まない

## 過去分の取り込み

1. PC のブラウザに Tampermonkey か Violentmonkey を入れ、[twitter-web-exporter](https://github.com/prinsss/twitter-web-exporter) を入れる
2. x.com のブックマーク画面を一番下までスクロールし、exporter の画面から Bookmarks を書き出す
   - 形式は **JSON**、**「すべてのメタデータを含める」にチェック**（無いと引用元の本文や長文ポストの続きが取れない）
3. ファイルを VPS の ubuntu のホームに送り、取り込む

```sh
# まず件数だけ確かめる（書き込まない）
sudo -u tw-fetch node /srv/apps/tw-bookmarks/current/bin/tw-import.js --dry-run < ~/twitter-Bookmarks-XXXX.json
# 取り込む（すでにある投稿は飛ばすので、何度実行してもよい）
sudo -u tw-fetch node /srv/apps/tw-bookmarks/current/bin/tw-import.js < ~/twitter-Bookmarks-XXXX.json
```

## 開発

```sh
pnpm test                      # node --test
LIBRARY_DIR=./dev-library node bin/tw-import.js --no-media < test/fixtures/export-sample.json
PORT=3059 LIBRARY_DIR=./dev-library node server.js   # 手元からは ssh -L 3059:127.0.0.1:3059 で http://127.0.0.1:3059/tw/
```

サーバー側の初回準備は `ops/setup-stage1.sh`（管理者が実行）。
