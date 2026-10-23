// 画面の HTML を組み立てる。値はすべて esc()／linkifyText()／renderMarkdown() を通してから埋め込む。

import { esc, linkifyText } from './html.js';
import { renderMarkdown } from './markdown.js';

const dateFmt = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : dateFmt.format(d);
}

export function layout(base, { title, body, status }) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${base}/s/app.css">
<script src="${base}/s/app.js" defer></script>
</head>
<body>
<header class="top">
  <a class="brand" href="${base}/">ブックマーク</a>
</header>
${statusBanner(status)}
<main>
${body}
</main>
<div class="pickbar" id="pickbar" hidden>
  <span><b id="pickcount">0</b> 件を選択中</span>
  <button type="button" id="pickcopy" class="primary">IDをコピー</button>
  <button type="button" id="pickclear">解除</button>
</div>
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
</body>
</html>`;
}

// 自動取り込みの状態。失敗している、または最後の成功から時間が空きすぎていれば赤い帯で知らせる
export function statusBanner(status, now = Date.now()) {
  if (!status) return '';
  if (status.broken) {
    return `<div class="banner bad">自動取り込みの状態ファイルが読めません。取り込みが止まっている可能性があります。</div>`;
  }
  const ok = Date.parse(status.last_success ?? '') || 0;
  const ng = Date.parse(status.last_error_at ?? '') || 0;
  if (ng > ok) {
    return `<div class="banner bad"><b>自動取り込みに失敗しています</b>（${esc(formatDate(status.last_error_at))}）<br>${esc(status.last_error ?? '')}</div>`;
  }
  if (ok && now - ok > 6 * 60 * 60 * 1000) {
    return `<div class="banner bad"><b>自動取り込みが止まっているかもしれません。</b>最後に成功したのは ${esc(formatDate(status.last_success))} です。</div>`;
  }
  if (status.last_warning) {
    return `<div class="banner bad"><b>自動取り込みの注意</b>（${esc(formatDate(status.last_success))}）<br>${esc(status.last_warning)}</div>`;
  }
  return '';
}

export function listPage(base, { posts, total, q, noteOnly, page, pages, lib }) {
  const params = (p) => {
    const sp = new URLSearchParams();
    if (q) sp.set('q', q);
    if (noteOnly) sp.set('note', '1');
    if (p > 1) sp.set('page', String(p));
    const s = sp.toString();
    return `${base}/${s ? `?${s}` : ''}`;
  };
  const nav =
    pages > 1
      ? `<nav class="pager">${page > 1 ? `<a href="${esc(params(page - 1))}">← 前へ</a>` : '<span></span>'}<span>${page} / ${pages}</span>${page < pages ? `<a href="${esc(params(page + 1))}">次へ →</a>` : '<span></span>'}</nav>`
      : '';
  const items = posts.map((p) => card(base, p, lib.notesFor(p.id).length)).join('\n');
  return `
<form class="search" method="get" action="${base}/">
  <input type="search" name="q" value="${esc(q)}" placeholder="本文・投稿者・メモを検索" aria-label="検索">
  <label class="check"><input type="checkbox" name="note" value="1"${noteOnly ? ' checked' : ''}> メモあり</label>
  <button type="submit">検索</button>
</form>
<p class="count">${q || noteOnly ? `${total} 件見つかりました` : `全 ${total} 件`}${lastFetch(lib.status)}</p>
${total ? `<ul class="cards">${items}</ul>` : `<p class="empty">${q || noteOnly ? '見つかりませんでした。' : 'まだブックマークがありません。'}</p>`}
${nav}`;
}

// 自動取り込みが最後に成功した時刻（段階3より前は何も出さない）
function lastFetch(status) {
  if (!status?.last_success) return '';
  return `<span class="fetched">自動取り込み ${esc(formatDate(status.last_success))}</span>`;
}

function author(p) {
  const name = p.author_name ?? p.author?.name;
  const handle = p.author_handle ?? p.author?.handle;
  return `<span class="author">${name ? `<b>${esc(name)}</b> ` : ''}${handle ? `<span class="handle">@${esc(handle)}</span>` : ''}</span>`;
}

function card(base, p, noteCount) {
  const shown = (p.media ?? []).filter((m) => m.file).slice(0, 4);
  const thumbs = shown
    .map((m) => `<img src="${base}/m/${esc(m.file)}" alt="${esc(m.alt ?? '')}" loading="lazy">`)
    .join('');
  return `<li class="card">
  <label class="pick" title="選択"><input type="checkbox" class="pickbox" value="${esc(p.id)}" aria-label="選択"></label>
  <div class="card-body">
    <div class="meta">${author(p)} <time>${esc(formatDate(p.created_at))}</time>${noteCount ? ` <span class="badge">メモ ${noteCount}</span>` : ''}</div>
    <a class="text" href="${base}/p/${esc(p.id)}">${esc(p.text) || '（本文なし）'}</a>
    ${p.quoted ? `<div class="quoted-mini">引用: ${p.quoted.unavailable ? 'X で見る' : `${author(p.quoted)} ${esc((p.quoted.text ?? '').slice(0, 80))}`}</div>` : ''}
    ${thumbs ? `<div class="thumbs n${shown.length}">${thumbs}</div>` : ''}
    ${!thumbs && p.card ? linkCard(base, p.card, true) : ''}
    <div class="actions"><button type="button" class="copyid" data-id="${esc(p.id)}">ID ${esc(p.id)} をコピー</button></div>
  </div>
</li>`;
}

export function postPage(base, p, lib) {
  const notes = lib.notesFor(p.id);
  return `
<p><a href="${base}/">← 一覧へ</a></p>
<article class="post">
  <div class="meta">${author(p)} <time>${esc(formatDate(p.created_at))}</time></div>
  ${p.reply_to_id ? `<p class="reply">返信先: <a href="https://x.com/i/status/${esc(p.reply_to_id)}" target="_blank" rel="noopener noreferrer">X で見る</a></p>` : ''}
  <div class="fulltext">${linkifyText(p.text)}</div>
  ${mediaBlock(base, p.media)}
  ${p.card ? linkCard(base, p.card, false) : ''}
  ${p.quoted ? quotedBlock(base, p.quoted) : ''}
  <div class="actions">
    <button type="button" class="copyid primary" data-id="${esc(p.id)}">ID ${esc(p.id)} をコピー</button>
    <label class="check"><input type="checkbox" class="pickbox" value="${esc(p.id)}"> 選択に加える</label>
    <a href="${esc(safeXUrl(p.url, p.id))}" target="_blank" rel="noopener noreferrer">X で開く</a>
  </div>
  <p class="saved">${p.source === 'api' ? '自動取り込み' : '過去分の書き出しから取り込み'}・${esc(formatDate(p.fetched_at))}</p>
</article>
<section class="notes">
  <h2>メモ</h2>
  ${notes.length ? notes.map((n) => noteBlock(base, n, p.id, lib)).join('\n') : '<p class="empty">まだメモはありません。</p>'}
</section>`;
}

function mediaBlock(base, media) {
  const items = (media ?? []).map((m) => {
    const label = m.type === 'photo' ? '' : `<span class="mtype">${m.type === 'video' ? '動画' : 'GIF'}（サムネイル）</span>`;
    if (m.file) {
      return `<figure><a href="${base}/m/${esc(m.file)}" target="_blank" rel="noopener"><img src="${base}/m/${esc(m.file)}" alt="${esc(m.alt ?? '')}" loading="lazy"></a>${label}${m.alt ? `<figcaption>${esc(m.alt)}</figcaption>` : ''}</figure>`;
    }
    return `<figure class="missing">画像は保存されていません${label}</figure>`;
  });
  return items.length ? `<div class="media n${items.length}">${items.join('')}</div>` : '';
}

// URL のリンクカード。compact は一覧用（画像を左に小さく）
function linkCard(base, c, compact) {
  const href = typeof c.url === 'string' && /^https?:\/\//.test(c.url) ? c.url : null;
  const img = c.image_file ? `<img src="${base}/m/${esc(c.image_file)}" alt="" loading="lazy">` : '';
  const inner = `${img ? `<div class="lc-img">${img}</div>` : ''}<div class="lc-body">${c.domain ? `<span class="lc-domain">${esc(c.domain)}</span>` : ''}<span class="lc-title">${esc(c.title)}</span>${!compact && c.description ? `<span class="lc-desc">${esc(c.description)}</span>` : ''}</div>`;
  const cls = `linkcard${compact ? ' compact' : ''}${img ? '' : ' noimg'}`;
  return href
    ? `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    : `<div class="${cls}">${inner}</div>`;
}

function quotedBlock(base, q) {
  if (q.unavailable) {
    return `<div class="quoted">引用元の投稿（本文は取り込まれていません）: <a href="${esc(safeXUrl(q.url, q.id))}" target="_blank" rel="noopener noreferrer">X で見る</a></div>`;
  }
  return `<div class="quoted">
  <div class="meta">引用元: ${author(q)} <time>${esc(formatDate(q.created_at))}</time></div>
  <div class="fulltext">${linkifyText(q.text)}</div>
  ${mediaBlock(base, q.media)}
  ${q.card ? linkCard(base, q.card, false) : ''}
  <a href="${esc(safeXUrl(q.url, q.id))}" target="_blank" rel="noopener noreferrer">X で開く</a>
</div>`;
}

function noteBlock(base, n, currentId, lib) {
  const others = n.posts.filter((id) => id !== currentId);
  const rel = others.length
    ? `<p class="related">一緒に扱った投稿: ${others
        .map((id) => (lib.get(id) ? `<a href="${base}/p/${esc(id)}">${esc(id)}</a>` : esc(id)))
        .join('、')}</p>`
    : '';
  return `<div class="note">
  <div class="note-head">${n.title ? `<b>${esc(n.title)}</b> ` : ''}<time>${esc(formatDate(n.created_at))}</time></div>
  ${rel}
  <div class="md">${renderMarkdown(n.body)}</div>
</div>`;
}

// 保存した URL は信用せず、X のドメインのものだけリンクにする
function safeXUrl(url, id) {
  if (typeof url === 'string' && /^https:\/\/(x|twitter)\.com\/[\w/]+$/.test(url)) return url;
  return `https://x.com/i/status/${id}`;
}

export function messagePage(base, text) {
  return `<p>${esc(text)}</p><p><a href="${base}/">← 一覧へ</a></p>`;
}
