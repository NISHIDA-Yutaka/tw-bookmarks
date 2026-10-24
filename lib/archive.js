// アーカイブ（分析が終わった投稿を一覧から外す）の状態。
// 元の投稿（posts/）は書き換えず、<ライブラリ>/state/archive.json に「投稿ID → アーカイブした日時」を持つ。
// 書くのは画面（ユーザー tw-bookmarks）だけ。書ける場所は systemd で state/ だけに絞っている。

import fs from 'node:fs';
import path from 'node:path';
import { isPostId } from './normalize-export.js';

export function archiveFile(dir) {
  return path.join(dir, 'state', 'archive.json');
}

// ファイルを読み、形の正しいものだけを Map にする（無ければ空）
export function readArchive(dir) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(archiveFile(dir), 'utf8'));
  } catch {
    return new Map();
  }
  const out = new Map();
  const items = data?.archived && typeof data.archived === 'object' ? data.archived : {};
  for (const [id, at] of Object.entries(items)) {
    if (isPostId(id) && typeof at === 'string') out.set(id, at);
  }
  return out;
}

// ids をアーカイブする（archived=false なら戻す）。変わった件数を返す
export function setArchived(dir, ids, archived, now = new Date()) {
  const map = readArchive(dir);
  let changed = 0;
  for (const id of ids) {
    if (!isPostId(id)) continue;
    if (archived && !map.has(id)) {
      map.set(id, now.toISOString());
      changed++;
    } else if (!archived && map.delete(id)) {
      changed++;
    }
  }
  if (!changed) return 0;
  const file = archiveFile(dir);
  const sorted = Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));
  const tmp = path.join(path.dirname(file), `.archive.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify({ archived: sorted }, null, 2)}\n`, { mode: 0o640 });
  fs.renameSync(tmp, file);
  return changed;
}

// 画面のボタンから送られたフォームを読む。おかしな値は捨てる
export function parseArchiveForm(body, base) {
  const f = new URLSearchParams(body);
  const ids = [...new Set((f.get('ids') ?? '').split(/[\s,]+/).filter(isPostId))].slice(0, 500);
  const action = f.get('do');
  const back = f.get('back') ?? '';
  // 戻り先は画面の中のパスだけ（ほかのサイトへ飛ばさない）
  const safeBack = back.startsWith(`${base}/`) && !back.startsWith('//') && !/[\s\\]/.test(back) ? back : `${base}/`;
  return { ids, archived: action === 'archive' ? true : action === 'restore' ? false : null, back: safeBack };
}

// ほかのサイトのページから勝手にボタンを押させる攻撃（CSRF）を防ぐ。
// 今のブラウザは送り元の種類を Sec-Fetch-Site に必ず付ける（ページの側からは変えられない）ので、それを優先して見る。
// 画面は Referrer-Policy: no-referrer なので、フォームの Origin は「null」になることがあり、頼れない。
// Sec-Fetch-Site を付けない古いブラウザだけ、Origin がこの画面自身のホストと同じかで判断する
export function isSameOrigin(headers) {
  const site = headers['sec-fetch-site'];
  if (site) return site === 'same-origin';
  const origin = headers.origin;
  const host = headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
