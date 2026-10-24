#!/usr/bin/env bash
# アーカイブ機能のサーバー側の準備。管理者（ubuntu）が sudo で1回だけ実行する（何度実行してもよい）。
# デプロイ済みのコードから実行する: sudo bash /srv/apps/tw-bookmarks/current/ops/setup-archive.sh
#
#   1. アーカイブの状態の置き場 /var/lib/tw-bookmarks/state を作る（画面のユーザー tw-bookmarks だけが書ける）
#   2. 画面のサービスに「state/ だけは書いてよい」を足して、再起動する
#   3. 噛み砕き役の CLAUDE.md と権限の設定を更新する（アーカイブの状態を読めることを伝える。書き換えは禁止）
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo "sudo を付けて実行してください: sudo bash $0" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=/var/lib/tw-bookmarks
step() { printf '\n== %s\n' "$*"; }

step "1. アーカイブの状態の置き場 $LIB/state"
install -d -o tw-bookmarks -g tw-library -m 2750 "$LIB/state"
ls -ld "$LIB/state"

step "2. 画面のサービス"
install -o root -g root -m 0644 "$HERE/app-tw-bookmarks.service" /etc/systemd/system/app-tw-bookmarks.service
systemctl daemon-reload
systemctl restart app-tw-bookmarks.service
systemctl --no-pager --lines=0 status app-tw-bookmarks.service

step "3. 噛み砕き役の設定"
install -o root -g root -m 0644 "$HERE/study/CLAUDE.md" /srv/tw-study/CLAUDE.md
install -o root -g root -m 0644 "$HERE/study/settings.json" /srv/tw-study/.claude/settings.json
echo "更新しました"

printf '\n完了。画面を再読み込みすると、投稿に「アーカイブ」ボタンが出ます。\n'
