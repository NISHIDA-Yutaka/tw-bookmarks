// 振り返りの画面。ライブラリのファイルを読んで HTML を返すだけ（書き込みはしない）。
// 127.0.0.1 だけで待ち受け、Caddy が Tailscale の中からの /tw/ をここへ渡す。
//
//   PORT          待ち受けるポート（既定 3050）
//   LIBRARY_DIR   ライブラリの場所（既定 /var/lib/tw-bookmarks）
//   BASE_PATH     画面の URL の頭（既定 /tw）

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Library } from './lib/library.js';
import { layout, listPage, postPage, messagePage } from './lib/render.js';

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
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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

function page(res, status, title, body) {
  send(res, status, layout(BASE, { title, body, status: lib.status }));
}

function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed', 'text/plain');
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/healthz') return send(res, 200, 'ok', 'text/plain');
  if (p === BASE) return send(res, 301, '', 'text/plain', { Location: `${BASE}/` });
  if (!p.startsWith(`${BASE}/`)) return send(res, 404, 'Not Found', 'text/plain');
  const rest = p.slice(BASE.length + 1);

  if (rest.startsWith('s/')) {
    const s = STATIC[rest.slice(2)];
    if (!s) return send(res, 404, 'Not Found', 'text/plain');
    return send(res, 200, fs.readFileSync(s.file), s.type);
  }

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

  const post = rest.match(/^p\/(\d{1,25})$/);
  if (post) {
    const item = lib.get(post[1]);
    if (!item) return page(res, 404, '見つかりません', messagePage(BASE, `ID ${post[1]} の投稿は見つかりません。`));
    const title = `${item.author_name ?? item.author_handle ?? ''}: ${(item.text ?? '').slice(0, 40)}`;
    return page(res, 200, title, postPage(BASE, item, lib));
  }

  if (rest === '') {
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
    const noteOnly = url.searchParams.get('note') === '1';
    const words = q.toLowerCase().split(/[\s　]+/).filter(Boolean);
    let list = lib.posts;
    if (noteOnly) list = list.filter((x) => lib.notesFor(x.id).length);
    if (words.length) list = list.filter((x) => words.every((w) => x.haystack.includes(w)));
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    const n = Math.min(Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1), pages);
    const body = listPage(BASE, {
      posts: list.slice((n - 1) * PAGE_SIZE, n * PAGE_SIZE),
      total: list.length,
      q,
      noteOnly,
      page: n,
      pages,
      lib,
    });
    return page(res, 200, q ? `「${q}」の検索結果` : 'ブックマーク', body);
  }

  return page(res, 404, '見つかりません', messagePage(BASE, 'ページが見つかりません。'));
}

const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, 'Internal Server Error', 'text/plain');
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`listening on http://127.0.0.1:${PORT}${BASE}/ (library: ${LIBRARY_DIR})`);
});
