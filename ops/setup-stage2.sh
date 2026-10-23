#!/usr/bin/env bash
# 段階2（噛み砕ける）のサーバー側の準備。管理者（ubuntu）が sudo で1回だけ実行する。
# 何度実行しても同じ状態になる。
#
#   1. 噛み砕き専用のユーザー tw-study を作る
#        sudo なし・パスワードなし（ログイン不可）・GitHub の鍵なし。ライブラリは読めるが、書けるのはメモ（notes）だけ
#   2. メモの置き場 /var/lib/tw-bookmarks/notes を作る
#   3. 作業場所 /srv/tw-study に CLAUDE.md と権限の設定を置く（root の持ち物にして、tw-study からは書き換えられないようにする）
#   4. tw-study に Claude Code を入れる（Anthropic の公式インストーラ。tw-study の権限で動き、tw-study のホームにだけ入る）
#   5. ubuntu から `tw` で起動できるようにする
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo "sudo を付けて実行してください: sudo bash $0" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=/var/lib/tw-bookmarks
step() { printf '\n== %s\n' "$*"; }

step "1. ユーザー tw-study"
if ! id tw-study >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --user-group tw-study
fi
usermod -aG tw-library tw-study
passwd -l tw-study >/dev/null
id tw-study

step "2. メモの置き場 $LIB/notes"
install -d -o tw-study -g tw-library -m 2750 "$LIB/notes"
ls -ld "$LIB/notes"

step "3. 作業場所 /srv/tw-study"
install -d -o root -g root -m 0755 /srv/tw-study /srv/tw-study/.claude
install -o root -g root -m 0644 "$HERE/study/CLAUDE.md" /srv/tw-study/CLAUDE.md
install -o root -g root -m 0644 "$HERE/study/settings.json" /srv/tw-study/.claude/settings.json
ls -la /srv/tw-study /srv/tw-study/.claude

step "4. tw-study に Claude Code を入れる"
if sudo -u tw-study -H test -x /home/tw-study/.local/bin/claude; then
  echo "入っています: $(sudo -u tw-study -H /home/tw-study/.local/bin/claude --version)"
else
  sudo -u tw-study -H bash -c 'cd ~ && curl -fsSL https://claude.ai/install.sh | bash'
fi

step "5. tw コマンド"
install -d -o root -g root -m 0755 /usr/local/lib/tw-study
install -o root -g root -m 0755 "$HERE/study/start" /usr/local/lib/tw-study/start
install -o root -g root -m 0755 "$HERE/study/tw" /usr/local/bin/tw

printf '\n完了。ubuntu で `tw` と打つと、噛み砕き役の Claude が起動します（初回はログインと、作業場所を信頼するかの確認があります）。\n'
