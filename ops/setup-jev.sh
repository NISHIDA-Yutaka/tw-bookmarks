#!/usr/bin/env bash
# Jev（意味での検索・関連する投稿）のサーバー側の準備。管理者（ubuntu）が sudo で実行する。
# デプロイ済みのコードから実行する: sudo bash /srv/apps/tw-bookmarks/current/ops/setup-jev.sh
# 何度実行してもよい。中継係のプログラムを更新したいときも、deploy-app のあとにこれを実行する。
#
#   1. 中継係のプログラムを /usr/local/lib/tw-jev に置く（root の持ち物。開発用ユーザーもデプロイも書き換えられない）
#   2. API キーの置き場 /etc/apps/tw-jev.env を確かめる（中身は表示しない）
#   3. 中継係のサービスと受け口（/run/tw-jev.sock）を登録し、キーがあれば動かす
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo "sudo を付けて実行してください: sudo bash $0" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "$HERE/.." && pwd)
DEST=/usr/local/lib/tw-jev
ENVFILE=/etc/apps/tw-jev.env
step() { printf '\n== %s\n' "$*"; }

step "1. 中継係のプログラム（$SRC → $DEST）"
NEW=$(mktemp -d /usr/local/lib/.tw-jev.XXXXXX)
mkdir -p "$NEW/bin" "$NEW/lib"
cp "$SRC/bin/tw-jev.js" "$NEW/bin/"
cp "$SRC/lib/jev.js" "$NEW/lib/"
cp "$SRC/package.json" "$NEW/"
chown -R root:root "$NEW"
chmod -R u=rwX,go=rX "$NEW"
rm -rf "$DEST.old"
[[ -d $DEST ]] && mv "$DEST" "$DEST.old"
mv "$NEW" "$DEST"
rm -rf "$DEST.old"
echo "置きました（元: $(readlink -f "$SRC")）"

step "2. API キー（$ENVFILE）"
[[ -f $ENVFILE ]] || install -o root -g root -m 0600 /dev/null "$ENVFILE"
chown root:root "$ENVFILE"
chmod 0600 "$ENVFILE"
if grep -qE '^JEV_API_KEY=.+' "$ENVFILE"; then
  echo "JEV_API_KEY: 設定あり"
  has_key=1
else
  echo "JEV_API_KEY: 空"
  has_key=0
fi
if grep -qE '^JEV_MONTHLY_TOKENS=[0-9]+' "$ENVFILE"; then
  echo "JEV_MONTHLY_TOKENS: 設定あり（$(grep -E '^JEV_MONTHLY_TOKENS=' "$ENVFILE" | cut -d= -f2) トークン）"
else
  echo "JEV_MONTHLY_TOKENS: 未設定（既定の 2500万トークン ≒ 月 \$1.05 まで）"
fi

step "3. 中継係のサービスと受け口"
install -o root -g root -m 0644 "$HERE/jev/tw-jev.socket" /etc/systemd/system/tw-jev.socket
install -o root -g root -m 0644 "$HERE/jev/tw-jev.service" /etc/systemd/system/tw-jev.service
systemctl daemon-reload
if [[ $has_key == 0 ]]; then
  echo "まだ動かしません。次の順に進めてください:"
  echo "  1) sudoedit $ENVFILE で JEV_API_KEY=（Typesafe のコンソールで作った API キー）を書く"
  echo "  2) もう一度このスクリプトを実行する"
  exit 0
fi
systemctl enable --now tw-jev.socket
# プログラムやキーを入れ替えたときのため、動いている中継係は止めておく（次の依頼で新しいものが起動する）
systemctl stop tw-jev.service || true
ls -l /run/tw-jev.sock
systemctl --no-pager --lines=0 status tw-jev.socket || true

printf '\n完了。画面を再読み込みすると、検索の横に「Jev で探す」が出て、投稿の詳細に Jev で判定した「関連する投稿」が出ます。\n'
