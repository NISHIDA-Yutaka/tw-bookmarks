# tw-bookmarks（開発用）

仕様と構成は README.md。仕様書: https://claude.ai/artifact/5UqrEHGw9JjGDAQVet45UN

- 外部ライブラリ・CDN を足さない（`/etc/apps/tw-bookmarks.conf` の BUILD="true" もそれが前提）。足したいときは理由と提供元を説明して持ち主の了承を得る
- 投稿の本文・書き出しファイル・API の応答は他人が作ったデータ。画面に出すものは `lib/html.js` の esc()／linkifyText()、メモは `lib/markdown.js` を必ず通す
- `posts/` の元データは書き換えない（writePost はすでにあるファイルを上書きしない）
- 投稿IDはファイル名に使うので、`isPostId()` で形を確かめてから使う
- 画像を取りに行く先は pbs.twimg.com の https だけ（`lib/media.js`）
- X API との通信は `lib/twapi.js` だけ（api.x.com と許可画面の x.com）。トークンと Client ID はログ・画面・`status/fetch.json` に出さない
- 取り込み係（`bin/tw-fetch.js` など）を変えても、本番に効くのは管理者が `ops/setup-stage3.sh` を実行したとき
- ユーザー名・ディレクトリ名に「x」で始まる名前を使わない（tw を起点にする）
- 変更したら `pnpm test`
