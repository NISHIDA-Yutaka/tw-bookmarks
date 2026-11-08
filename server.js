// 振り返りの画面。ライブラリのファイルを読んで HTML を返す。
// 書き込むのはアーカイブの状態と関連する投稿の覚え書き（state/）だけ。systemd で書ける場所を state/ に絞っている。
// 127.0.0.1 だけで待ち受け、Caddy が Tailscale の中からの /tw/ をここへ渡す。
// 外へはつながない。Jev（意味での検索・関連する投稿）は、サーバーの中のソケットで中継係（bin/tw-jev.js）に頼む。
//
//   PORT          待ち受けるポート（既定 3050）
//   LIBRARY_DIR   ライブラリの場所（既定 /var/lib/tw-bookmarks）
//   BASE_PATH     画面の URL の頭（既定 /tw）

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Library, collapseThreads } from './lib/library.js';
import { setArchived, parseArchiveForm, isSameOrigin } from './lib/archive.js';
import { layout, listPage, cardList, postPage, messagePage, relatedList } from './lib/render.js';
import { judge, jevText, jevAvailable } from './lib/jev-client.js';
import { localRelated, cachedRelated, saveRelated } from './lib/related.js';
import { diskStatus, diskAlert } from './lib/disk.js';
import { applyFolderForm, assignPosts, parseAssignForm } from './lib/folders.js';
import { runAutoSort, pendingPosts } from './lib/autosort.js';
import { foldersPage } from './lib/render.js';

const PORT = Number(process.env.PORT ?? 3050);
const LIBRARY_DIR = process.env.LIBRARY_DIR ?? '/var/lib/tw-bookmarks';
const BASE = (process.env.BASE_PATH ?? '/tw').replace(/\/$/, '');
const PAGE_SIZE = 50;

const here = path.dirname(fileURLToPath(import.meta.url));
const STATIC = {
  'app.css': { file: path.join(here, 'public', 'app.css'), type: 'text/css; charset=utf-8' },
  'app.js': { file: path.join(here, 'public', 'app.js'), type: 'text/javascript; charset=utf-8' },
};
const IMAGE_TYPES = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

const SECURITY_HEADERS = {
  // 自分のサーバーの CSS・JS・画像だけを許す。投稿に何が書かれていてもスクリプトとして動かない
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

const lib = new Library(LIBRARY_DIR);

function send(res, status, body, type = 'text/html; charset=utf-8', extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...extra });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

// 空き容量の注意（1分ごとに確かめ直す）
let disk = { at: 0, alert: null };
function diskNotice() {
  if (Date.now() - disk.at > 60_000) {
    let alert = null;
    try {
      alert = diskAlert(diskStatus(LIBRARY_DIR));
    } catch {
      alert = null;
    }
    disk = { at: Date.now(), alert };
  }
  return disk.alert;
}

function page(res, status, title, body, view = '') {
  send(res, status, layout(BASE, { title, body, status: lib.status, view, disk: diskNotice(), folders: lib.folders.folders }));
}

// 動画。ブラウザが途中から読めるよう（シークや Safari の再生に必要）Range に応える
function sendVideo(req, res, file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return send(res, 404, 'Not Found', 'text/plain');
  }
  const headers = { ...SECURITY_HEADERS, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=31536000, immutable' };
  const m = (req.headers.range ?? '').match(/^bytes=(\d*)-(\d*)$/);
  let start = 0;
  let end = st.size - 1;
  let status = 200;
  if (m && (m[1] || m[2])) {
    if (m[1]) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), st.size - 1);
    } else start = Math.max(0, st.size - Number(m[2]));
    if (start > end || start >= st.size) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = String(end - start + 1);
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}

const MAX_FORM_BYTES = 16 * 1024;

// 画面のフォーム（POST）を読む。ほかのサイトからの送信・形のおかしいもの・大きすぎるものは断る
function readForm(req, res, done) {
  if (!isSameOrigin(req.headers)) return send(res, 403, 'この画面の外からの操作は受け付けません', 'text/plain; charset=utf-8');
  if (!/^application\/x-www-form-urlencoded\b/.test(req.headers['content-type'] ?? '')) {
    return send(res, 415, 'Unsupported Media Type', 'text/plain');
  }
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_FORM_BYTES) {
      send(res, 413, 'Payload Too Large', 'text/plain');
      req.destroy();
    } else chunks.push(c);
  });
  req.on('end', () => {
    if (res.headersSent) return;
    try {
      done(Buffer.concat(chunks).toString('utf8'));
    } catch (err) {
      console.error(err);
      page(res, 500, '保存できませんでした', messagePage(BASE, `保存できませんでした（${err.message}）。管理者が ops/setup-archive.sh を実行済みか確かめてください。`));
    }
  });
}

// アーカイブする／戻すボタン（フォームの POST）。終わったら元のページへ戻す
function handleArchive(req, res) {
  readForm(req, res, (body) => {
    const form = parseArchiveForm(body, BASE);
    lib.refresh();
    const ids = form.ids.filter((id) => lib.get(id));
    if (form.archived === null || !ids.length) return send(res, 303, '', 'text/plain', { Location: form.back });
    setArchived(LIBRARY_DIR, ids, form.archived);
    lib.invalidate();
    send(res, 303, '', 'text/plain', { Location: form.back });
  });
}

// 投稿をフォルダに入れる・外す
function handleAssign(req, res) {
  readForm(req, res, (body) => {
    const form = parseAssignForm(body, BASE);
    lib.refresh();
    const ids = form.ids.filter((id) => lib.get(id));
    if (ids.length) assignPosts(LIBRARY_DIR, ids, form.folder);
    lib.invalidate();
    send(res, 303, '', 'text/plain', { Location: form.back });
  });
}

// フォルダの管理（作る・変える・消す・保存済みの投稿にも振り分けをかける）
function handleFolders(req, res) {
  readForm(req, res, (body) => {
    let message;
    try {
      message = applyFolderForm(LIBRARY_DIR, body);
    } catch (err) {
      message = `できませんでした: ${err.message}`;
    }
    lib.invalidate();
    if (message.includes('振り分けをかけます')) setTimeout(autoSort, 1000);
    send(res, 303, '', 'text/plain', { Location: `${BASE}/folders?msg=${encodeURIComponent(message)}` });
  });
}

// 自動の振り分け（数分ごと。新しい投稿が無ければ何もしない）
function autoSort() {
  runAutoSort(lib, LIBRARY_DIR).catch((err) => console.error(err));
}
setTimeout(autoSort, 30_000).unref();
setInterval(autoSort, 5 * 60_000).unref();

// Jev は使うたびに費用がかかるので、この画面の中からの操作（とアドレス欄に直接入れたもの）でだけ動かす
function mayUseJev(headers) {
  const site = headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
}

const sameThread = (post, id) => Boolean(post.thread?.items.some((i) => i.id === id));

const RELATED_SHOWN = 5;
const RELATED_MIN = 0.5;
const SEARCH_MIN = 0.5;

// 関連する投稿（Jev で判定し直したもの）。詳細ページを開いたあと、画面のスクリプトが取りに来る
async function handleRelated(req, res, id) {
  if (req.headers['sec-fetch-site'] !== 'same-origin') return send(res, 403, '', 'text/plain');
  const post = lib.get(id);
  if (!post) return send(res, 404, '', 'text/plain');
  const n = lib.posts.length;
  let list = cachedRelated(LIBRARY_DIR, id, n);
  if (!list) {
    const cands = localRelated(lib, post, 20);
    if (!cands.length) return send(res, 200, relatedList(BASE, [], { jev: true }));
    try {
      const scores = await judge(
        'Is this post about the same specific topic as the item "base", or closely related to it?',
        cands.map((c) => ({ id: c.id, text: jevText(lib.get(c.id), lib.notesFor(c.id), lib) })),
        jevText(post, lib.notesFor(id), lib),
      );
      list = cands.filter((c) => scores.has(c.id)).map((c) => ({ id: c.id, p: Math.round(scores.get(c.id) * 1000) / 1000 }));
      list.sort((a, b) => b.p - a.p);
      try {
        saveRelated(LIBRARY_DIR, id, n, list);
      } catch (err) {
        console.error(`関連する投稿を保存できませんでした: ${err.message}`);
      }
    } catch (err) {
      return send(res, 502, relatedList(BASE, null, { error: err.message }));
    }
  }
  const items = list.filter((x) => x.p >= RELATED_MIN && lib.get(x.id) && !sameThread(post, x.id)).slice(0, RELATED_SHOWN).map((x) => ({ post: lib.get(x.id), p: x.p }));
  return send(res, 200, relatedList(BASE, items, { jev: true }));
}

// Jev で探した結果は、ページを移っても同じものを使う（1時間・20件まで）
const jevSearches = new Map();
async function jevSearch(q, candidates) {
  const key = `${q}\n${candidates.length}\n${candidates[0]?.id ?? ''}`;
  const hit = jevSearches.get(key);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.scores;
  const scores = await judge(
    `Does this post match the following request? The request may be in Japanese. Request: ${q}`,
    candidates.map((p) => ({ id: p.id, text: jevText(p, lib.notesFor(p.id), lib) })),
  );
  jevSearches.set(key, { at: Date.now(), scores });
  if (jevSearches.size > 20) jevSearches.delete(jevSearches.keys().next().value);
  return scores;
}

function postRelated(post) {
  const cached = cachedRelated(LIBRARY_DIR, post.id, lib.posts.length);
  if (cached) {
    const items = cached.filter((x) => x.p >= RELATED_MIN && lib.get(x.id) && !sameThread(post, x.id)).slice(0, RELATED_SHOWN).map((x) => ({ post: lib.get(x.id), p: x.p }));
    return { items, jev: true };
  }
  const items = localRelated(lib, post, RELATED_SHOWN).map((c) => ({ post: lib.get(c.id) }));
  return { items, jev: false, src: jevAvailable() ? `${BASE}/related/${post.id}` : null };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (req.method === 'POST' && p === `${BASE}/archive`) return handleArchive(req, res);
  if (req.method === 'POST' && p === `${BASE}/folders/assign`) return handleAssign(req, res);
  if (req.method === 'POST' && p === `${BASE}/folders`) return handleFolders(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed', 'text/plain');

  if (p === '/healthz') return send(res, 200, 'ok', 'text/plain');
  if (p === BASE) return send(res, 301, '', 'text/plain', { Location: `${BASE}/` });
  if (!p.startsWith(`${BASE}/`)) return send(res, 404, 'Not Found', 'text/plain');
  const rest = p.slice(BASE.length + 1);

  if (rest.startsWith('s/')) {
    const s = STATIC[rest.slice(2)];
    if (!s) return send(res, 404, 'Not Found', 'text/plain');
    return send(res, 200, fs.readFileSync(s.file), s.type);
  }

  const video = rest.match(/^m\/(\d{1,25})\/([\w-]+)\.mp4$/);
  if (video) return sendVideo(req, res, path.join(LIBRARY_DIR, 'media', video[1], `${video[2]}.mp4`));

  const media = rest.match(/^m\/(\d{1,25})\/([\w-]+)\.(jpg|png|gif|webp)$/);
  if (media) {
    const file = path.join(LIBRARY_DIR, 'media', media[1], `${media[2]}.${media[3]}`);
    let bytes;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      return send(res, 404, 'Not Found', 'text/plain');
    }
    // 画像は変わらないので、ブラウザに長く覚えてもらう
    return send(res, 200, bytes, IMAGE_TYPES[media[3]], { 'Cache-Control': 'private, max-age=31536000, immutable' });
  }

  lib.refresh();

  if (rest === 'folders') {
    const msg = (url.searchParams.get('msg') ?? '').slice(0, 200);
    return page(res, 200, 'フォルダ', foldersPage(BASE, lib, { message: msg, pending: pendingPosts(lib).length, jevReady: jevAvailable() }), 'folders');
  }

  const rel = rest.match(/^related\/(\d{1,25})$/);
  if (rel) return handleRelated(req, res, rel[1]);

  const post = rest.match(/^p\/(\d{1,25})$/);
  if (post) {
    const item = lib.get(post[1]);
    if (!item) return page(res, 404, '見つかりません', messagePage(BASE, `ID ${post[1]} の投稿は見つかりません。`));
    const title = `${item.author_name ?? item.author_handle ?? ''}: ${(item.text ?? '').slice(0, 40)}`;
    return page(res, 200, title, postPage(BASE, item, lib, `${p}${url.search}`, postRelated(item)));
  }

  if (rest === '') {
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
    const noteOnly = url.searchParams.get('note') === '1';
    const folderId = url.searchParams.get('folder') ?? '';
    const folder = lib.folders.folders.find((f) => f.id === folderId) ?? null;
    const view = folder ? '' : ['archived', 'all'].includes(url.searchParams.get('view')) ? url.searchParams.get('view') : '';
    const words = q.toLowerCase().split(/[\s　]+/).filter(Boolean);
    let jevMode = url.searchParams.get('mode') === 'jev' && Boolean(q);
    let notice = null;
    let warning = null;
    let scores = null;
    let list = folder ? lib.posts.filter((x) => x.folder?.id === folder.id) : lib.posts;
    if (noteOnly) list = list.filter((x) => lib.notesFor(x.id).length);
    if (jevMode && !mayUseJev(req.headers)) {
      jevMode = false;
      notice = '「Jev で探す」は、この画面のボタンから押したときだけ動きます。下はふつうの検索の結果です。';
    }
    if (jevMode) {
      const pool = folder ? list : view === '' ? list.filter((x) => !x.archived_at && !lib.hiddenByFolder(x)) : view === 'archived' ? list.filter((x) => x.archived_at) : list;
      try {
        scores = pool.length ? await jevSearch(q, pool) : new Map();
        list = list.filter((x) => (scores.get(x.id) ?? 0) >= SEARCH_MIN).sort((a, b) => scores.get(b.id) - scores.get(a.id));
        if (scores.skipped) warning = `${scores.skipped} 件は Jev が判定できず、結果に入っていません: ${scores.reason}`;
      } catch (err) {
        jevMode = false;
        scores = null;
        notice = `Jev で探せませんでした: ${err.message}。下はふつうの検索の結果です。`;
      }
    }
    if (!jevMode && words.length) list = list.filter((x) => words.every((w) => x.haystack.includes(w)));
    // 既定ではアーカイブした投稿を外す。外した件数は画面に出す
    // 一覧ではアーカイブした投稿と「一覧に出さない」フォルダの投稿を外す。外した件数は画面に出す
    const outOfList = (x) => x.archived_at || lib.hiddenByFolder(x);
    const hidden = !folder && view === '' ? collapseThreads(list.filter(outOfList)).length : 0;
    if (!folder && view === '') list = list.filter((x) => !outOfList(x));
    if (view === 'archived') list = list.filter((x) => x.archived_at);
    // スレッドは1枚にまとめる。Jev で探したときは、いちばん当てはまった投稿を代表にする
    list = collapseThreads(list, { first: jevMode });
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    const asked = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
    const n = Math.min(asked, pages);
    const sp = new URLSearchParams(url.search);
    sp.delete('part');
    const back = `${p}${sp.size ? `?${sp}` : ''}`;
    // part=1 はスクロールで足すカードだけを返す。ふつうの表示は page までの全部を出す（戻ったときに同じ位置まで見えるように）
    if (url.searchParams.get('part') === '1') {
      if (notice) return send(res, 502, '', 'text/plain');
      if (asked > pages) return send(res, 200, '');
      return send(res, 200, cardList(BASE, list.slice((n - 1) * PAGE_SIZE, n * PAGE_SIZE), lib, back, scores));
    }
    const body = listPage(BASE, {
      posts: list.slice(0, n * PAGE_SIZE),
      total: list.length,
      q,
      noteOnly,
      view,
      hidden,
      back,
      page: n,
      pages,
      lib,
      folder,
      jev: jevMode,
      jevReady: jevAvailable(),
      scores,
      notice: notice ?? warning,
    });
    return page(res, 200, q ? `「${q}」の検索結果` : folder ? folder.name : 'ブックマーク', body, folder ? `folder:${folder.id}` : view);
  }

  return page(res, 404, '見つかりません', messagePage(BASE, 'ページが見つかりません。'));
}

function fail(res, err) {
  console.error(err);
  if (!res.headersSent) send(res, 500, 'Internal Server Error', 'text/plain');
  else res.end();
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => fail(res, err));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`listening on http://127.0.0.1:${PORT}${BASE}/ (library: ${LIBRARY_DIR})`);
});
