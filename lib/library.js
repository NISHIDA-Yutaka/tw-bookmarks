// ブックマークのファイル置き場（ライブラリ）を読み書きする。ファイルが正本。
//
//   <ライブラリ>/posts/<投稿ID>.md     元の投稿。取り込みの仕組みだけが書き、あとから書き換えない
//   <ライブラリ>/media/<投稿ID>/…       保存した画像（写真は原寸、動画はサムネイル）
//   <ライブラリ>/notes/*.md             噛み砕いたメモ。前付けの posts に関係する投稿IDを並べる
//   <ライブラリ>/status/fetch.json      自動取り込みの最新の結果（画面の警告に使う）
//   <ライブラリ>/state/archive.json     アーカイブした投稿の一覧（画面のボタンで書く）

import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from './frontmatter.js';
import { isPostId } from './normalize-export.js';
import { archiveFile, readArchive } from './archive.js';

const FILE_MODE = 0o640;
const DIR_MODE = 0o2750;

export function postPath(dir, id) {
  if (!isPostId(id)) throw new Error(`投稿IDの形が不正です: ${id}`);
  return path.join(dir, 'posts', `${id}.md`);
}

export function hasPost(dir, id) {
  return fs.existsSync(postPath(dir, id));
}

// これまでに付けた保存順の番号の最大値（新しくブックマークしたものほど大きい）
export function maxSavedSeq(dir) {
  let max = 0;
  for (const p of readPostFiles(dir)) {
    const seq = Number(p.saved_seq);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return max;
}

// 投稿を1件書く。すでにあれば書き換えずに false を返す（元データは書き換えない）
export function writePost(dir, post, extra) {
  const file = postPath(dir, post.id);
  if (fs.existsSync(file)) return false;
  const data = {
    id: post.id,
    url: post.url,
    author_handle: post.author?.handle ?? null,
    author_name: post.author?.name ?? null,
    author_id: post.author?.id ?? null,
    created_at: post.created_at ?? null,
    reply_to_id: post.reply_to_id ?? null,
    media: post.media ?? [],
    card: post.card ?? null,
    quoted: post.quoted ?? null,
    ...extra,
  };
  writeAtomic(file, stringify(data, post.text ?? ''), 'wx');
  return true;
}

// 前付けに card が無い（リンクカードを導入する前に取り込んだ）投稿か
export function lacksCard(dir, id) {
  const { data } = parse(fs.readFileSync(postPath(dir, id), 'utf8'));
  return !('card' in data);
}

// リンクカードを導入する前に取り込んだ投稿に、カードを書き足す。
// 本文や、前付けにすでにある値は変えない（足すのは card と、引用元の card だけ）
export function addCards(dir, id, card, quotedCard) {
  const file = postPath(dir, id);
  const { data, body } = parse(fs.readFileSync(file, 'utf8'));
  if ('card' in data) return false;
  const next = { ...data, card: card ?? null };
  if (data.quoted && typeof data.quoted === 'object' && !data.quoted.unavailable && !('card' in data.quoted)) {
    next.quoted = { ...data.quoted, card: quotedCard ?? null };
  }
  // 項目の並びを新しく取り込んだものとそろえる（media の次に card）
  const ordered = {};
  for (const [k, v] of Object.entries(next)) {
    if (k === 'card') continue;
    ordered[k] = v;
    if (k === 'media') ordered.card = next.card;
  }
  if (!('card' in ordered)) ordered.card = next.card;
  writeAtomic(file, stringify(ordered, body), 'w');
  return true;
}

// 画像を media/<投稿ID>/<名前>.<拡張子> に保存し、ライブラリからの相対パスを返す
export function saveMedia(dir, id, name, ext, bytes) {
  if (!isPostId(id) || !/^[\w-]+$/.test(name)) throw new Error('画像の保存名が不正です');
  const d = path.join(dir, 'media', id);
  ensureDir(d);
  const rel = `${id}/${name}.${ext}`;
  writeAtomic(path.join(dir, 'media', rel), bytes, 'w');
  return rel;
}

// すでにあるフォルダには mkdir を呼ばない。取り込みのサービスは書ける場所を絞った囲い（systemd）の中で動き、
// 書けない親フォルダの下では、すでにあるフォルダへの mkdir も EPERM で拒否されるため
function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: DIR_MODE });
}

function writeAtomic(file, content, flag) {
  ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, { mode: FILE_MODE });
  if (flag === 'wx' && fs.existsSync(file)) {
    fs.rmSync(tmp);
    return;
  }
  fs.renameSync(tmp, file);
}

function readPostFiles(dir) {
  const d = path.join(dir, 'posts');
  if (!fs.existsSync(d)) return [];
  const out = [];
  for (const name of fs.readdirSync(d)) {
    const m = name.match(/^(\d{1,25})\.md$/);
    if (!m) continue;
    out.push(readPost(path.join(d, name), m[1]));
  }
  return out.filter(Boolean);
}

function readPost(file, id) {
  try {
    const { data, body } = parse(fs.readFileSync(file, 'utf8'));
    return { ...data, id, text: body.replace(/\n$/, '') };
  } catch {
    return null;
  }
}

function readNote(file) {
  try {
    const { data, raw, body } = parse(fs.readFileSync(file, 'utf8'));
    // 投稿IDは桁が多く数値として読むと丸まるので、元の文字列から数字の並びを拾う
    const ids = [...new Set((raw.posts ?? '').match(/\d{5,25}/g) ?? [])];
    const stat = fs.statSync(file);
    return {
      file: path.basename(file),
      title: typeof data.title === 'string' ? data.title : null,
      created_at: typeof data.created_at === 'string' ? data.created_at : stat.mtime.toISOString(),
      posts: ids,
      body,
    };
  } catch {
    return null;
  }
}

// 画面用の読み込み。数秒ごとにファイルの更新を確かめ、変わったものだけ読み直す
export class Library {
  constructor(dir, { ttlMs = 3000 } = {}) {
    this.dir = dir;
    this.ttlMs = ttlMs;
    this.checkedAt = 0;
    this.cache = new Map(); // ファイルパス → { key, value }
    this.posts = [];
    this.notesByPost = new Map();
    this.status = null;
  }

  refresh() {
    const now = Date.now();
    if (now - this.checkedAt < this.ttlMs) return this;
    this.checkedAt = now;

    const seen = new Set();
    const load = (file, reader) => {
      seen.add(file);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        return null;
      }
      const key = `${st.mtimeMs}:${st.size}`;
      const hit = this.cache.get(file);
      if (hit && hit.key === key) return hit.value;
      const value = reader();
      this.cache.set(file, { key, value });
      return value;
    };

    const posts = [];
    for (const name of listDir(path.join(this.dir, 'posts'))) {
      const m = name.match(/^(\d{1,25})\.md$/);
      if (!m) continue;
      const file = path.join(this.dir, 'posts', name);
      const p = load(file, () => readPost(file, m[1]));
      if (p) posts.push(p);
    }

    const notesByPost = new Map();
    for (const name of listDir(path.join(this.dir, 'notes'))) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue;
      const file = path.join(this.dir, 'notes', name);
      const n = load(file, () => readNote(file));
      if (!n) continue;
      for (const id of n.posts) {
        if (!notesByPost.has(id)) notesByPost.set(id, []);
        notesByPost.get(id).push(n);
      }
    }
    for (const list of notesByPost.values()) list.sort((a, b) => a.created_at.localeCompare(b.created_at));

    const statusFile = path.join(this.dir, 'status', 'fetch.json');
    this.status = load(statusFile, () => {
      try {
        return JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      } catch {
        return { broken: true };
      }
    });

    const archived = load(archiveFile(this.dir), () => readArchive(this.dir)) ?? new Map();

    for (const file of this.cache.keys()) if (!seen.has(file)) this.cache.delete(file);

    posts.sort(
      (a, b) =>
        (Number(b.saved_seq) || 0) - (Number(a.saved_seq) || 0) ||
        String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')),
    );
    for (const p of posts) {
      p.archived_at = archived.get(p.id) ?? null;
      const notes = notesByPost.get(p.id) ?? [];
      p.haystack = [
        p.text,
        p.author_handle,
        p.author_name,
        p.id,
        p.quoted?.text,
        p.quoted?.author_handle ?? p.quoted?.author?.handle,
        p.quoted?.author?.name,
        p.card?.title,
        p.card?.description,
        p.card?.domain,
        ...(p.media ?? []).map((m) => m.alt),
        ...notes.map((n) => `${n.title ?? ''}\n${n.body}`),
      ]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
    }
    this.posts = posts;
    this.notesByPost = notesByPost;
    return this;
  }

  // 書き込んだあと、次の表示ですぐ読み直す
  invalidate() {
    this.checkedAt = 0;
  }

  get(id) {
    return this.posts.find((p) => p.id === id) ?? null;
  }

  notesFor(id) {
    return this.notesByPost.get(id) ?? [];
  }
}

function listDir(d) {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
}
