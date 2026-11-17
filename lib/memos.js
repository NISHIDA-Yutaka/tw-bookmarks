// 持ち主が画面で手書きするメモ。<ライブラリ>/state/memos.json に持つ（notes/ は噛み砕き役が書く場所なので混ぜない）。
// 書くのは画面（ユーザー tw-bookmarks）だけ。表示は噛み砕き役のメモと同じく lib/markdown.js を通す。
//
//   { memos: { メモID: { post, title, body, created_at, updated_at } } }

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isPostId } from './normalize-export.js';

export const MAX_TITLE = 80;
export const MAX_BODY = 5000;
const MAX_PER_POST = 50;

export function memosFile(dir) {
  return path.join(dir, 'state', 'memos.json');
}

const isMemoId = (id) => typeof id === 'string' && /^m[0-9a-f]{8}$/.test(id);
const str = (v) => (typeof v === 'string' ? v : null);

// ファイルを読み、形の正しいものだけを返す（無ければ空）
export function readMemos(dir) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(memosFile(dir), 'utf8'));
  } catch {
    return {};
  }
  const out = {};
  for (const [id, m] of Object.entries(data?.memos ?? {})) {
    if (!isMemoId(id) || !isPostId(m?.post) || typeof m.body !== 'string' || !str(m.created_at)) continue;
    out[id] = { post: m.post, title: str(m.title), body: m.body.slice(0, MAX_BODY), created_at: m.created_at, updated_at: str(m.updated_at) };
  }
  return out;
}

function writeMemos(dir, memos) {
  const file = memosFile(dir);
  const tmp = path.join(path.dirname(file), `.memos.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify({ memos }, null, 1)}\n`, { mode: 0o640 });
  fs.renameSync(tmp, file);
}

// 1行の見出しは制御文字を消し、本文は改行とタブだけ残す
const cleanTitle = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TITLE);
const cleanBody = (s) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, MAX_BODY);

// 画面のフォーム（書く・直す・消す）を読み、変える。返り値は { post, memo }（どの投稿の、どのメモか）。おかしなものは Error
export function applyMemoForm(dir, body, exists, now = new Date()) {
  const f = new URLSearchParams(body);
  const action = f.get('do');
  const memos = readMemos(dir);
  const at = now.toISOString();
  if (action === 'add') {
    const post = f.get('post') ?? '';
    if (!isPostId(post) || !exists(post)) throw new Error('その投稿はありません');
    const text = cleanBody(f.get('body'));
    if (!text) throw new Error('メモが空です');
    if (Object.values(memos).filter((m) => m.post === post).length >= MAX_PER_POST) throw new Error(`1つの投稿に書けるメモは ${MAX_PER_POST} 件までです`);
    let id;
    do id = `m${crypto.randomBytes(4).toString('hex')}`;
    while (memos[id]);
    memos[id] = { post, title: cleanTitle(f.get('title')) || null, body: text, created_at: at, updated_at: null };
    writeMemos(dir, memos);
    return { post, memo: id };
  }
  const id = f.get('id') ?? '';
  const m = isMemoId(id) ? memos[id] : null;
  if (!m) throw new Error('そのメモはありません');
  if (action === 'edit') {
    const text = cleanBody(f.get('body'));
    if (!text) throw new Error('メモが空です（消すときは「このメモを消す」を押してください）');
    memos[id] = { ...m, title: cleanTitle(f.get('title')) || null, body: text, updated_at: at };
  } else if (action === 'delete') {
    delete memos[id];
  } else {
    throw new Error('操作が分かりません');
  }
  writeMemos(dir, memos);
  return { post: m.post, memo: action === 'edit' ? id : null };
}
