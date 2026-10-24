#!/usr/bin/env bash
# 噛み砕き役（tw-study）の CLAUDE.md と権限の設定だけを更新する。管理者（ubuntu）が sudo で実行する（何度実行してもよい）。
# デプロイ済みのコードから実行する: sudo bash /srv/apps/tw-bookmarks/current/ops/setup-study.sh
#
#   1. 翻訳の置き場 /var/lib/tw-bookmarks/notes/translations を作る（tw-study だけが書け、画面は読める）
#   2. /srv/tw-study/CLAUDE.md と /srv/tw-study/.claude/settings.json をリポジトリの版にする
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo "sudo を付けて実行してください: sudo bash $0" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=/var/lib/tw-bookmarks
step() { printf '\n== %s\n' "$*"; }

step "1. 翻訳の置き場 $LIB/notes/translations"
install -d -o tw-study -g tw-library -m 2750 "$LIB/notes/translations"
ls -ld "$LIB/notes/translations"

step "2. 噛み砕き役の設定"
install -o root -g root -m 0644 "$HERE/study/CLAUDE.md" /srv/tw-study/CLAUDE.md
install -o root -g root -m 0644 "$HERE/study/settings.json" /srv/tw-study/.claude/settings.json
echo "更新しました"

printf '\n完了。次に「tw」で噛み砕き役を起動したときから、日本語以外の投稿は翻訳も保存されます。\n'
