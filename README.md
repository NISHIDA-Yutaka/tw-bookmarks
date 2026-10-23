# tw-bookmarks

X のブックマークを自分の VPS にためて、振り返る・噛み砕くための道具。外部ライブラリは使わない（Node.js の標準機能だけ）。

仕様書: https://claude.ai/artifact/5UqrEHGw9JjGDAQVet45UN

## 段階

1. **見られる**: 過去分の書き出しを取り込み、Tailscale の中から一覧・検索・詳細を見る
2. **噛み砕ける**: 専用ユーザー `tw-study` の Claude Code に ID を渡し、メモを残す
3. **自動で増える**: X API でブックマークを1時間ごとに取り込む（取り込み係 tw-fetch）

## 構成

| 場所 | 中身 | 書けるのは |
| --- | --- | --- |
| `/var/lib/tw-bookmarks/posts/<投稿ID>.md` | 元の投稿（前付けに投稿者・日時・画像・引用元、本文がその下） | tw-fetch |
| `/var/lib/tw-bookmarks/media/<投稿ID>/` | 画像（写真は原寸、動画はサムネイル、リンクカードの画像） | tw-fetch |
| `/var/lib/tw-bookmarks/notes/*.md` | 噛み砕いたメモ。前付けの `posts` に関係する投稿ID | tw-study（段階2） |
| `/var/lib/tw-bookmarks/status/fetch.json` | 自動取り込みの結果（段階3） | tw-fetch |
| `/var/lib/tw-fetch/token.json` | X の更新用トークン（0700 のフォルダ。tw-fetch 以外は読めない、バックアップにも入らない） | tw-fetch |
| `/usr/local/lib/tw-fetch/` | 取り込み係のプログラム（`setup-stage3.sh` がデプロイ済みのコードから写す） | root |
| `/etc/apps/tw-bookmarks.env` | X の Client ID（`TW_CLIENT_ID=`、root だけが読める 0600） | root（sudoedit） |

- 画面（`server.js`、ユーザー tw-bookmarks）は読むだけ。127.0.0.1:3050 で待ち受け、Caddy が Tailscale 側の `/tw/` を渡す
- `/var/lib/tw-bookmarks` は毎日のサーバー外バックアップに自動で含まれる
- 投稿の本文は他人が書いたデータ。画面ではすべてエスケープし、CSP で自分のサーバー以外のスクリプト・画像を読まない

## 過去分の取り込み

拡張機能は入れない。`tools/export-bookmarks.js`（このリポジトリのコード）を PC のブラウザのコンソールに貼って書き出す。
X の画面が受け取るブックマークのデータを横で記録してファイルに保存するだけで、どこにも送信しない。

1. PC のブラウザ（Chrome など）で https://x.com/home を開く（ブックマーク画面ではなくホーム）
2. F12 で開発者ツールを開き、「Console（コンソール）」タブを選ぶ
3. `tools/export-bookmarks.js` の中身をすべてコピーして貼り、Enter
   - Chrome で初回に貼り付けが止められたら、案内どおり `allow pasting` と打って Enter してから貼り直す
4. 右上に「ブックマーク書き出し」のパネルが出たら、左のメニューから「ブックマーク」を開く
5. パネルの「自動スクロール」を押す。件数が増えなくなると自動で止まる
6. 「保存」を押すと `tw-bookmarks-export-YYYYMMDD.json` がダウンロードされる。終わったらタブを再読み込みする
7. ファイルを VPS に送り、取り込む

```sh
# 手元の PC で: ファイルを VPS の ubuntu のホームへ送る
scp ~/Downloads/tw-bookmarks-export-YYYYMMDD.json ubuntu@kagoya:~/
# VPS（ubuntu）で: 件数だけ確かめる（書き込まない）
sudo -u tw-fetch node /usr/local/lib/tw-fetch/bin/tw-import.js --dry-run < ~/tw-bookmarks-export-YYYYMMDD.json
# 取り込む（すでにある投稿は飛ばすので、何度実行してもよい）
sudo -u tw-fetch node /usr/local/lib/tw-fetch/bin/tw-import.js < ~/tw-bookmarks-export-YYYYMMDD.json
```

twitter-web-exporter の JSON（「すべてのメタデータを含める」付き）も同じ手順で取り込める。

## 噛み砕き（段階2）

ubuntu で `tw` と打つと、専用ユーザー tw-study として Claude Code が `/srv/tw-study` で起動する（`tw -c` で前回の続き）。

- 作業場所の CLAUDE.md と権限の設定は `ops/study/`。サーバーには root の持ち物として置くので、tw-study からは書き換えられない
- 守り方（投稿に紛れた指示への備え）
  - OS: tw-study は sudo なし・GitHub の鍵なし。ライブラリは読めるが、書けるのは `notes/` だけ。X API の認証情報（段階3）やデプロイされたコードは読めない
  - Claude Code の設定: シェル（Bash）は使えない。読めるのはライブラリ、書けるのは `notes/` だけ。自分のログイン情報は読めない。claude.ai のコネクタ（Zen-do など）は読み込まない
  - Web ページを開くときは毎回確認が出る。投稿と関係のない URL を開こうとしたら「いいえ」を選ぶ

## 自動取り込み（段階3）

`tw-fetch.timer` が1時間ごとに `tw-fetch.service`（ユーザー tw-fetch）を動かす。

- X API の `GET /2/users/:id/bookmarks` を10件ずつ読み、取り込み済みの投稿が出てきたページで止める（1回で最大10ページ）
- 認証は OAuth 2.0 PKCE の公開クライアント（Native App。Client Secret なし）。戻り先は `http://127.0.0.1/callback`
- 更新用トークンは毎回使うと新しいものに替わる。アクセストークンは保存しない
- 結果は `status/fetch.json`。失敗・6時間以上の停止・取りこぼしの恐れは画面の赤い帯で出る
- 費用: 自分のブックマークの読み取りは1件 $0.001。同じ投稿は UTC の1日に何度読んでも1回分なので、月 $0.3〜0.5 程度。Developer Console の利用上限は月 $5

```sh
sudo tw-fetch-login                         # X に許可する（最初と、認証が切れたとき）
sudo tw-fetch-check                         # 試しに10件受け取り、取れた項目を表示（ライブラリには書かない）
sudo systemctl start tw-fetch.service       # 今すぐ取り込む
journalctl -u tw-fetch -n 20 --no-pager     # 取り込みの記録
systemctl list-timers tw-fetch.timer        # 次の取り込み予定
```

守り方:

- 取り込み係のプログラムは root の持ち物（`/usr/local/lib/tw-fetch`）。GitHub に push しても、管理者が `setup-stage3.sh` を実行するまで本番の取り込み係は変わらない。tw-fetch はデプロイされたコードを読めない
- tw-study（噛み砕き役）・tw-bookmarks（画面）・開発用ユーザーは、トークンも Client ID も読めない
- 取り込みのサービスが書けるのは posts・media・status とトークンの置き場だけ（systemd の ProtectSystem=strict）

## 開発

```sh
pnpm test                      # node --test
LIBRARY_DIR=./dev-library node bin/tw-import.js --no-media < test/fixtures/export-sample.json
PORT=3059 LIBRARY_DIR=./dev-library node server.js   # 手元からは ssh -L 3059:127.0.0.1:3059 で http://127.0.0.1:3059/tw/
```

サーバー側の準備は `ops/setup-stage1.sh`・`setup-stage2.sh`・`setup-stage3.sh`（管理者が実行）。
