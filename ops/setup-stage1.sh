#!/usr/bin/env bash
# 段階1（見られる）のサーバー側の準備。管理者（ubuntu）が sudo で1回だけ実行する。
# 何度実行しても同じ状態になる（すでにあるものは作り直さない）。
#
#   1. ユーザーとグループを作る
#        tw-library … ライブラリを「読める」人のグループ（画面・取り込み・噛み砕き役）
#        tw-fetch   … 取り込み専用のユーザー。投稿と画像を書けるのはこのユーザーだけ
#   2. ライブラリの置き場 /var/lib/tw-bookmarks を作る（毎日のサーバー外バックアップに自動で入る場所）
#   3. 画面のサービス app-tw-bookmarks を登録する
#   4. Caddy で、Tailscale 側の https://kagoya.taild08d78.ts.net/tw/ を画面に渡す（それ以外は今まで通り zen-do）
#   5. deploy-app で画面を出す
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo "sudo を付けて実行してください: sudo bash $0" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=/var/lib/tw-bookmarks
step() { printf '\n== %s\n' "$*"; }

step "1. ユーザーとグループ"
getent group tw-library >/dev/null || groupadd --system tw-library
if ! id tw-fetch >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin tw-fetch
fi
usermod -aG tw-library tw-fetch
usermod -aG tw-library tw-bookmarks
# 段階3からは、tw-fetch は root が /usr/local/lib/tw-fetch に置いたプログラムだけを動かす（setup-stage3.sh）。
# それまでの過去分の取り込みは、デプロイされたコード（グループ tw-bookmarks だけが読める）から行う
[[ -d /usr/local/lib/tw-fetch ]] || usermod -aG tw-bookmarks tw-fetch
id tw-fetch

step "2. ライブラリの置き場 $LIB"
install -d -o root -g tw-library -m 2750 "$LIB"
for d in posts media status; do
  install -d -o tw-fetch -g tw-library -m 2750 "$LIB/$d"
done
ls -la "$LIB"

step "3. 画面のサービス"
install -m 0644 "$HERE/app-tw-bookmarks.service" /etc/systemd/system/app-tw-bookmarks.service
systemctl daemon-reload
systemctl enable app-tw-bookmarks.service
if ! sudo -l -U deploy 2>/dev/null | grep -qE 'systemctl restart (app-\*|app-tw-bookmarks)'; then
  echo "注意: deploy ユーザーが app-tw-bookmarks を再起動できる sudo の設定が見つかりません。" >&2
  echo "      ほかのアプリと同じ設定（/etc/sudoers.d/）に app-tw-bookmarks.service を足してから、もう一度実行してください。" >&2
  exit 1
fi

step "4. Caddy（Tailscale 側の /tw/ を 127.0.0.1:3050 へ）"
CADDY=/etc/caddy/sites/zen-do.caddy
if grep -q '127.0.0.1:3050' "$CADDY"; then
  echo "設定済みです"
else
  cp -a "$CADDY" "$CADDY.bak.$(date +%Y%m%d%H%M%S)"
  python3 - "$CADDY" <<'PY'
import sys
path = sys.argv[1]
s = open(path).read()
old = "\thandle @tailnet {\n\t\tencode zstd gzip\n\t\treverse_proxy 127.0.0.1:3010\n\t}\n"
new = (
    "\thandle @tailnet {\n"
    "\t\tencode zstd gzip\n"
    "\t\t# tw-bookmarks の振り返り画面。それ以外のパスは今まで通り zen-do\n"
    "\t\tredir /tw /tw/\n"
    "\t\thandle /tw/* {\n"
    "\t\t\treverse_proxy 127.0.0.1:3050\n"
    "\t\t}\n"
    "\t\thandle {\n"
    "\t\t\treverse_proxy 127.0.0.1:3010\n"
    "\t\t}\n"
    "\t}\n"
)
if s.count(old) != 1:
    sys.exit("zen-do.caddy の Tailscale 側の設定が想定と違うため、自動では書き換えません。手で直してください。")
open(path, "w").write(s.replace(old, new))
PY
  if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    echo "Caddy の設定チェックに失敗したので元に戻します" >&2
    cp -a "$(ls -1t "$CADDY".bak.* | head -1)" "$CADDY"
    exit 1
  fi
  systemctl reload caddy
  echo "Caddy を読み直しました"
fi

step "5. デプロイ"
sudo -u deploy deploy-app tw-bookmarks
systemctl --no-pager --lines=0 status app-tw-bookmarks.service

printf '\n完了。Tailscale につないだ端末で https://kagoya.taild08d78.ts.net/tw/ を開いてください（まだ0件の表示です）。\n'
