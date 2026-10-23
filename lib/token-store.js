// X の更新用トークンの置き場。tw-fetch だけが読み書きできるフォルダ（systemd の StateDirectory、0700）に置く。
// アクセストークンは2時間で切れるので保存せず、毎回の取り込みで更新用トークンから作り直す。

import fs from 'node:fs';
import path from 'node:path';

export const TOKEN_DIR = process.env.STATE_DIRECTORY ?? '/var/lib/tw-fetch';
const FILE = () => path.join(TOKEN_DIR, 'token.json');

export function loadToken() {
  let raw;
  try {
    raw = fs.readFileSync(FILE(), 'utf8');
  } catch {
    return null;
  }
  let t;
  try {
    t = JSON.parse(raw);
  } catch {
    // JSON.parse のエラー文には中身の一部が入るので、そのまま外に出さない
    throw new Error('保存してある X の許可情報が壊れています。管理者が 「sudo tw-fetch-login」 でもう一度許可してください');
  }
  if (typeof t?.refresh_token !== 'string' || typeof t?.user_id !== 'string') return null;
  return t;
}

// 書きかけで壊れないよう、別名で書いてから置き換える。権限は持ち主だけ（0600）
export function saveToken(t) {
  const tmp = `${FILE()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
  fs.renameSync(tmp, FILE());
}
