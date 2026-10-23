#!/usr/bin/env bash
# 段階3（自動で増える）のサーバー側の準備。管理者（ubuntu）が sudo で実行する。
# デプロイ済みのコードから実行する: sudo bash /srv/apps/tw-bookmarks/current/ops/setup-stage3.sh
# 何度実行してもよい。取り込み係のプログラムを更新したいときも、deploy-app のあとにこれを実行する。
#
#   1. 取り込み係のプログラムを /usr/local/lib/tw-fetch に置く（root の持ち物。tw-fetch・開発用ユーザーは書き換えられない）
#   2. tw-fetch をデプロイされたコードのグループから外す（root が置いたプログラムだけを動かすため）
#   3. Client ID の置き場 /etc/apps/tw-bookmarks.env を確かめる（中身は表示しない）
#   4. 取り込みのサービスとタイマー、許可用のコマンド（tw-fetch-login / tw-fetch-check）を登録する
#   5. 許可が済んでいれば、1時間ごとの取り込みを始める
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo "sudo を付けて実行してください: sudo bash $0" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "$HERE/.." && pwd)
DEST=/usr/local/lib/tw-fetch
ENVFILE=/etc/apps/tw-bookmarks.env
step() { printf '\n== %s\n' "$*"; }

step "1. 取り込み係のプログラム（$SRC → $DEST）"
NEW=$(mktemp -d /usr/local/lib/.tw-fetch.XXXXXX)
cp -r "$SRC/bin" "$SRC/lib" "$SRC/package.json" "$NEW/"
chown -R root:root "$NEW"
chmod -R u=rwX,go=rX "$NEW"
rm -rf "$DEST.old"
[[ -d $DEST ]] && mv "$DEST" "$DEST.old"
mv "$NEW" "$DEST"
rm -rf "$DEST.old"
echo "置きました（元: $(readlink -f "$SRC")）"

step "2. tw-fetch のグループ"
if id -nG tw-fetch | tr ' ' '\n' | grep -qx tw-bookmarks; then
  gpasswd -d tw-fetch tw-bookmarks >/dev/null
fi
id tw-fetch

step "3. Client ID（$ENVFILE）"
[[ -f $ENVFILE ]] || install -o root -g root -m 0600 /dev/null "$ENVFILE"
chown root:root "$ENVFILE"
chmod 0600 "$ENVFILE"
if grep -qE '^TW_CLIENT_ID=.+' "$ENVFILE"; then
  echo "TW_CLIENT_ID: 設定あり"
  has_id=1
else
  echo "TW_CLIENT_ID: 空"
  has_id=0
fi

step "4. サービスとタイマー、許可用のコマンド"
install -o root -g root -m 0644 "$HERE/fetch/tw-fetch.service" /etc/systemd/system/tw-fetch.service
install -o root -g root -m 0644 "$HERE/fetch/tw-fetch.timer" /etc/systemd/system/tw-fetch.timer
install -o root -g root -m 0755 "$HERE/fetch/tw-fetch-login" /usr/local/sbin/tw-fetch-login
ln -sf tw-fetch-login /usr/local/sbin/tw-fetch-check
systemctl daemon-reload
echo "登録しました"

step "5. 1時間ごとの取り込み"
if [[ $has_id == 0 ]]; then
  echo "まだ始めません。次の順に進めてください:"
  echo "  1) sudoedit $ENVFILE で TW_CLIENT_ID=（Developer Console の Client ID）を書く"
  echo "  2) sudo tw-fetch-login で X に許可する"
  echo "  3) もう一度このスクリプトを実行する"
elif [[ ! -s /var/lib/tw-fetch/token.json ]]; then
  echo "まだ始めません。sudo tw-fetch-login で X に許可してから、もう一度このスクリプトを実行してください。"
else
  systemctl enable --now tw-fetch.timer
  systemctl list-timers --no-pager tw-fetch.timer
  echo
  echo "始めました。すぐ試すには: sudo systemctl start tw-fetch.service && journalctl -u tw-fetch -n 20 --no-pager"
fi
