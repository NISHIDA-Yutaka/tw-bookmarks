// アーカイブ（分析が終わった投稿を一覧から外す）と削除（どの画面にも出さない）の状態。
// 元の投稿（posts/）は書き換えず、<ライブラリ>/state/archive.json・deleted.json に「投稿ID → その日時」を持つ。
// 書くのは画面（ユーザー tw-bookmarks）だけ。書ける場所は systemd で state/ だけに絞っている。

import fs from 'node:fs';
import path from 'node:path';
import { isPostId } from './normalize-export.js';

// 印の種類ごとのファイルと、中の項目名
const KINDS = { archive: ['archive.json', 'archived'], deleted: ['deleted.json', 'deleted'] };

function markFile(dir, kind) {
  return path.join(dir, 'state', KINDS[kind][0]);
}

// ファイルを読み、形の正しいものだけを Map にする（無ければ空）
function readMarks(dir, kind) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(markFile(dir, kind), 'utf8'));
  } catch {
    return new Map();
  }
  const out = new Map();
  const key = KINDS[kind][1];
  const items = data?.[key] && typeof data[key] === 'object' ? data[key] : {};
  for (const [id, at] of Object.entries(items)) {
    if (isPostId(id) && typeof at === 'string') out.set(id, at);
  }
  return out;
}

// ids に印を付ける（on=false なら外す）。変わった件数を返す
function setMarks(dir, kind, ids, on, now) {
  const map = readMarks(dir, kind);
  let changed = 0;
  for (const id of ids) {
    if (!isPostId(id)) continue;
    if (on && !map.has(id)) {
      map.set(id, now.toISOString());
      changed++;
    } else if (!on && map.delete(id)) {
      changed++;
    }
  }
  if (!changed) return 0;
  const file = markFile(dir, kind);
  const sorted = Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));
  const tmp = path.join(path.dirname(file), `.${KINDS[kind][0]}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify({ [KINDS[kind][1]]: sorted }, null, 2)}\n`, { mode: 0o640 });
  fs.renameSync(tmp, file);
  return changed;
}

export const archiveFile = (dir) => markFile(dir, 'archive');
export const readArchive = (dir) => readMarks(dir, 'archive');
// ids をアーカイブする（archived=false なら戻す）。変わった件数を返す
export const setArchived = (dir, ids, archived, now = new Date()) => setMarks(dir, 'archive', ids, archived, now);

export const deletedFile = (dir) => markFile(dir, 'deleted');
export const readDeleted = (dir) => readMarks(dir, 'deleted');
// ids を削除する（deleted=false なら戻す）。変わった件数を返す
export const setDeleted = (dir, ids, deleted, now = new Date()) => setMarks(dir, 'deleted', ids, deleted, now);

// 画面のボタンから送られたフォームを読む。おかしな値は捨てる
export function parseArchiveForm(body, base) {
  const f = new URLSearchParams(body);
  const ids = [...new Set((f.get('ids') ?? '').split(/[\s,]+/).filter(isPostId))].slice(0, 500);
  const action = f.get('do');
  const back = f.get('back') ?? '';
  // 戻り先は画面の中のパスだけ（ほかのサイトへ飛ばさない）
  const safeBack = back.startsWith(`${base}/`) && !back.startsWith('//') && !/[\s\\]/.test(back) ? back : `${base}/`;
  return { ids, archived: action === 'archive' ? true : action === 'restore' ? false : null, deleted: action === 'delete' ? true : action === 'undelete' ? false : null, back: safeBack };
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
