// フォルダ（振り分け）。元の投稿（posts/）は書き換えず、<ライブラリ>/state/folders.json に持つ。書くのは画面だけ。
//
//   folders  [{ id, name, hide, rule, maxVideoSec }]  hide: 一覧に出さない。rule: Jev に自動で振り分けさせるときの「入れる投稿」の説明
//            maxVideoSec: 「この秒数より短い動画がある投稿だけ」（こちらで確かめてから Jev に渡す）
//   assign   { 投稿ID: { folder, by: 'manual' | 'jev', at, p? } }  1つの投稿は1つのフォルダにだけ入る
//   judged   { 投稿ID: 日時 }  Jev が自動の振り分けで一度見た投稿（同じ投稿を何度も判定しない。条件を変えたら消して判定し直す）
//   near     { 投稿ID: { folder, p } }  基準には届かなかったが近かった投稿（管理画面に「惜しかった投稿」として出す）
//   autoSince  この日時より後に取り込んだ投稿を自動で振り分ける（最初に rule を書いたとき）。backfill: 保存済みの分もやる

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isPostId } from './normalize-export.js';

export const MAX_FOLDERS = 30;
export const MAX_NAME = 40;
export const MAX_RULE = 400;
export const MAX_VIDEO_SEC = 600;

export function foldersFile(dir) {
  return path.join(dir, 'state', 'folders.json');
}

const empty = () => ({ folders: [], assign: {}, judged: {}, near: {}, autoSince: null, backfill: false, last: null });
const seconds = (v) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 1 && n <= MAX_VIDEO_SEC ? n : null;
};
export const autoFolder = (f) => Boolean(f.rule || f.maxVideoSec);

// ファイルを読み、形の正しいものだけを残す（無ければ空）
export function readFolders(dir) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(foldersFile(dir), 'utf8'));
  } catch {
    return empty();
  }
  const out = empty();
  const ids = new Set();
  for (const f of Array.isArray(data?.folders) ? data.folders : []) {
    if (typeof f?.id !== 'string' || !/^f[0-9a-f]{8}$/.test(f.id) || ids.has(f.id) || typeof f.name !== 'string') continue;
    ids.add(f.id);
    out.folders.push({
      id: f.id,
      name: f.name.slice(0, MAX_NAME),
      hide: Boolean(f.hide),
      rule: typeof f.rule === 'string' && f.rule.trim() ? f.rule.slice(0, MAX_RULE) : null,
      maxVideoSec: seconds(f.maxVideoSec),
    });
  }
  for (const [id, a] of Object.entries(data?.assign ?? {})) {
    if (isPostId(id) && ids.has(a?.folder)) {
      out.assign[id] = { folder: a.folder, by: a.by === 'jev' ? 'jev' : 'manual', at: typeof a.at === 'string' ? a.at : null, ...(Number.isFinite(a.p) ? { p: a.p } : {}) };
    }
  }
  for (const [id, at] of Object.entries(data?.judged ?? {})) if (isPostId(id) && typeof at === 'string') out.judged[id] = at;
  for (const [id, n] of Object.entries(data?.near ?? {})) {
    if (isPostId(id) && ids.has(n?.folder) && Number.isFinite(n.p) && !out.assign[id]) out.near[id] = { folder: n.folder, p: n.p };
  }
  out.autoSince = typeof data?.autoSince === 'string' ? data.autoSince : null;
  out.backfill = Boolean(data?.backfill);
  out.last = data?.last && typeof data.last === 'object' ? data.last : null;
  return out;
}

export function writeFolders(dir, data) {
  const file = foldersFile(dir);
  const tmp = path.join(path.dirname(file), `.folders.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`, { mode: 0o640 });
  fs.renameSync(tmp, file);
}

// 読んで、変えて、書く。change が false を返したら書かない
export function updateFolders(dir, change, now = new Date()) {
  const data = readFolders(dir);
  if (change(data, now.toISOString()) === false) return data;
  // 自動の振り分けは、最初に rule を書いたときから後に取り込んだ投稿にかける
  if (!data.autoSince && data.folders.some(autoFolder)) data.autoSince = now.toISOString();
  writeFolders(dir, data);
  return data;
}

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

// フォルダの管理画面から送られたフォームを読み、変える。返り値は画面に出す文（失敗なら Error を投げる）
export function applyFolderForm(dir, body, now = new Date()) {
  const f = new URLSearchParams(body);
  const action = f.get('do');
  const id = f.get('id') ?? '';
  const name = clean(f.get('name'), MAX_NAME);
  const rule = clean(f.get('rule'), MAX_RULE) || null;
  const hide = f.get('hide') === '1';
  const maxVideoSec = seconds(f.get('maxsec'));
  let message = '';
  // 自動で入れる条件が変わったら、まだどのフォルダにも入っていない投稿を判定し直す
  const rejudge = (data) => {
    for (const pid of Object.keys(data.judged)) if (!data.assign[pid]) delete data.judged[pid];
    data.near = {};
    data.backfill = true;
  };
  updateFolders(
    dir,
    (data) => {
      const folder = data.folders.find((x) => x.id === id);
      if (action === 'create') {
        if (!name) throw new Error('フォルダの名前を入れてください');
        if (data.folders.length >= MAX_FOLDERS) throw new Error(`フォルダは ${MAX_FOLDERS} 個までです`);
        if (data.folders.some((x) => x.name === name)) throw new Error('同じ名前のフォルダがあります');
        data.folders.push({ id: `f${crypto.randomBytes(4).toString('hex')}`, name, hide, rule, maxVideoSec });
        message = `フォルダ「${name}」を作りました`;
        if (rule || maxVideoSec) {
          rejudge(data);
          message += '。保存済みの投稿も、数分で自動の振り分けにかけます';
        }
      } else if (action === 'update' && folder) {
        if (!name) throw new Error('フォルダの名前を入れてください');
        if (data.folders.some((x) => x.id !== id && x.name === name)) throw new Error('同じ名前のフォルダがあります');
        const changed = folder.rule !== rule || folder.maxVideoSec !== maxVideoSec;
        Object.assign(folder, { name, hide, rule, maxVideoSec });
        message = `フォルダ「${name}」を保存しました`;
        if (changed && (rule || maxVideoSec)) {
          rejudge(data);
          message += '。条件が変わったので、まだフォルダに入っていない投稿を数分で判定し直します';
        }
      } else if (action === 'delete' && folder) {
        data.folders = data.folders.filter((x) => x.id !== id);
        for (const [pid, a] of Object.entries(data.assign)) if (a.folder === id) delete data.assign[pid];
        for (const [pid, n] of Object.entries(data.near)) if (n.folder === id) delete data.near[pid];
        message = `フォルダ「${folder.name}」を消しました（中の投稿はフォルダなしに戻りました）`;
      } else if (action === 'backfill') {
        data.backfill = true;
        message = '保存済みの投稿にも自動の振り分けをかけます。数分で終わります';
      } else {
        throw new Error('操作が分かりませんでした');
      }
    },
    now,
  );
  return message;
}

// カードやまとめての操作で、投稿をフォルダに入れる（folder が空なら外す）。返り値は変わった件数
export function assignPosts(dir, ids, folder, now = new Date()) {
  let changed = 0;
  updateFolders(
    dir,
    (data, at) => {
      if (folder && !data.folders.some((x) => x.id === folder)) throw new Error('そのフォルダはありません');
      for (const id of ids) {
        if (!isPostId(id)) continue;
        if (folder) data.assign[id] = { folder, by: 'manual', at };
        else delete data.assign[id];
        // 手で決めたものは自動の振り分けで動かさない
        data.judged[id] = at;
        delete data.near[id];
        changed++;
      }
      return changed > 0;
    },
    now,
  );
  return changed;
}

export function parseAssignForm(body, base) {
  const f = new URLSearchParams(body);
  const ids = [...new Set((f.get('ids') ?? '').split(/[\s,]+/).filter(isPostId))].slice(0, 500);
  const folder = f.get('folder') ?? '';
  const back = f.get('back') ?? '';
  const safeBack = back.startsWith(`${base}/`) && !back.startsWith('//') && !/[\s\\]/.test(back) ? back : `${base}/`;
  return { ids, folder: /^f[0-9a-f]{8}$/.test(folder) ? folder : '', back: safeBack };
}
