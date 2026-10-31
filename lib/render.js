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

export function layout(base, { title, body, status, view = '' }) {
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
<header class="top"><div class="top-inner">
  <a class="brand" href="${base}/">ブックマーク</a>
</div></header>
${statusBanner(status)}
<main>
${body}
</main>
<div class="pickbar" id="pickbar" hidden>
  <span><b id="pickcount">0</b> 件を選択中</span>
  <button type="button" id="pickcopy" class="primary">IDをコピー</button>
  ${
    view === 'archived'
      ? '<button type="button" id="pickarchive" class="restore" data-do="restore">アーカイブから戻す</button>'
      : '<button type="button" id="pickarchive" class="archive" data-do="archive">アーカイブ</button>'
  }
  <button type="button" id="pickclear">解除</button>
</div>
<form id="pickform" method="post" action="${base}/archive" hidden><input type="hidden" name="ids"><input type="hidden" name="do"><input type="hidden" name="back"></form>
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

const VIEWS = [
  ['', '一覧'],
  ['archived', 'アーカイブ'],
  ['all', 'すべて'],
];

export function listPage(base, { posts, total, q, noteOnly, view = '', hidden = 0, back, page, pages, lib, jev = false, jevReady = false, scores = null, notice = null }) {
  const params = (p, v = view) => {
    const sp = new URLSearchParams();
    if (q) sp.set('q', q);
    if (jev) sp.set('mode', 'jev');
    if (noteOnly) sp.set('note', '1');
    if (v) sp.set('view', v);
    if (p > 1) sp.set('page', String(p));
    const s = sp.toString();
    return `${base}/${s ? `?${s}` : ''}`;
  };
  const tabs = VIEWS.map(
    ([v, label]) =>
      `<a class="tab${v === view ? ' on' : ''}" href="${esc(params(1, v))}"${v === view ? ' aria-current="page"' : ''}>${label}</a>`,
  ).join('');
  const hiddenNote = hidden
    ? ` <a class="hidden-note" href="${esc(params(1, 'all'))}">アーカイブ済み ${hidden} 件を除いています</a>`
    : '';
  const nav =
    pages > 1
      ? `<nav class="pager">${page > 1 ? `<a href="${esc(params(page - 1))}">← 前へ</a>` : '<span></span>'}<span>${page} / ${pages}</span>${page < pages ? `<a href="${esc(params(page + 1))}">次へ →</a>` : '<span></span>'}</nav>`
      : '';
  const items = posts.map((p) => card(base, p, lib.notesFor(p.id).length, back, scores?.get(p.id))).join('\n');
  return `
<nav class="tabs">${tabs}</nav>
<form class="search" method="get" action="${base}/">
  ${view ? `<input type="hidden" name="view" value="${esc(view)}">` : ''}
  <input type="search" name="q" value="${esc(q)}" placeholder="${jevReady ? '言葉で検索／「〜について話している投稿」で Jev に探してもらう' : '本文・投稿者・メモを検索'}" aria-label="検索">
  <label class="check"><input type="checkbox" name="note" value="1"${noteOnly ? ' checked' : ''}> メモあり</label>
  <button type="submit">検索</button>
  ${jevReady ? '<button type="submit" name="mode" value="jev" class="jev" title="意味で探します（数秒かかり、少し費用がかかります）">Jev で探す</button>' : ''}
</form>
${notice ? `<p class="notice">${esc(notice)}</p>` : ''}
<p class="count">${jev ? '<span class="badge jev">Jev</span> 当てはまりそうな順に ' : ''}${q || noteOnly ? `${total} 件見つかりました` : `${total} 件`}${hiddenNote}${lastFetch(lib.status)}</p>
${total ? `<ul class="cards">${items}</ul>` : `<p class="empty">${emptyText(q, noteOnly, view)}</p>`}
${nav}`;
}

function emptyText(q, noteOnly, view) {
  if (q || noteOnly) return '見つかりませんでした。';
  if (view === 'archived') return 'アーカイブした投稿はまだありません。';
  if (view === '') return '未整理のブックマークはありません。';
  return 'まだブックマークがありません。';
}

// アーカイブする／戻すボタン。back は押したあとに戻るページ
function archiveForm(base, p, back) {
  const on = Boolean(p.archived_at);
  return `<form method="post" action="${base}/archive" class="inline"><input type="hidden" name="ids" value="${esc(p.id)}"><input type="hidden" name="do" value="${on ? 'restore' : 'archive'}"><input type="hidden" name="back" value="${esc(back)}"><button type="submit" class="${on ? 'restore' : 'archive'}">${on ? 'アーカイブから戻す' : 'アーカイブ'}</button></form>`;
}

// 投稿の印（新着・メモ・アーカイブ済み）
function badges(p, noteCount, now = Date.now()) {
  const out = [];
  const fetched = Date.parse(p.fetched_at ?? '');
  if (p.source === 'api' && fetched && now - fetched < 24 * 60 * 60 * 1000) out.push('<span class="badge new">新着</span>');
  if (noteCount) out.push(`<span class="badge note">メモ ${noteCount}</span>`);
  if (p.translation) out.push(`<span class="badge tr">翻訳${p.translation.lang ? `（${esc(langName(p.translation.lang))}）` : ''}</span>`);
  if (p.archived_at) out.push('<span class="badge arch">アーカイブ済み</span>');
  return out.join(' ');
}

const LANGS = { en: '英語', zh: '中国語', ko: '韓国語', es: 'スペイン語', fr: 'フランス語', de: 'ドイツ語', pt: 'ポルトガル語', ru: 'ロシア語', it: 'イタリア語', ar: 'アラビア語', hi: 'ヒンディー語', id: 'インドネシア語', th: 'タイ語', vi: 'ベトナム語' };
function langName(lang) {
  return LANGS[lang.split('-')[0]] ?? lang;
}

// 一覧で見せる本文（翻訳があれば翻訳）
function shownText(p) {
  return p.translation?.text ?? p.text ?? '';
}

// 詳細の本文。翻訳があれば翻訳を出し、翻訳だと分かる見出しと、開くと見える原文を添える
function textBlock(p) {
  if (!p.translation) return `<div class="fulltext">${linkifyText(p.text)}</div>`;
  const t = p.translation;
  const from = t.lang ? `${esc(langName(t.lang))}から` : '';
  return `<div class="translated">
  <div class="tr-label">${from}翻訳（Claude）${t.translated_at ? ` <time>${esc(formatDate(t.translated_at))}</time>` : ''}</div>
  <div class="fulltext">${linkifyText(t.text)}</div>
  <details class="original"><summary>原文を表示</summary><div class="fulltext">${linkifyText(p.text)}</div></details>
</div>`;
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

function card(base, p, noteCount, back, score) {
  const shown = (p.media ?? []).filter((m) => m.file).slice(0, 4);
  const thumbs = shown
    .map((m) => `<img src="${base}/m/${esc(m.file)}" alt="${esc(m.alt ?? '')}" loading="lazy">`)
    .join('');
  const cls = ['card', noteCount ? 'has-note' : '', p.archived_at ? 'archived' : ''].filter(Boolean).join(' ');
  return `<li class="${cls}">
  <label class="pick" title="選択"><input type="checkbox" class="pickbox" value="${esc(p.id)}" aria-label="選択"></label>
  <div class="card-body">
    <div class="meta">${author(p)} <time>${esc(formatDate(p.created_at))}</time> ${badges(p, noteCount)}${Number.isFinite(score) ? ` <span class="badge jev">一致 ${Math.round(score * 100)}%</span>` : ''}</div>
    <a class="text${p.translation ? ' is-tr' : ''}" href="${base}/p/${esc(p.id)}">${esc(shownText(p)) || '（本文なし）'}</a>
    ${p.quoted ? `<div class="quoted-mini">引用: ${p.quoted.unavailable ? 'X で見る' : `${author(p.quoted)} ${p.quoted.translation ? '<span class="badge tr">翻訳</span> ' : ''}${esc(shownText(p.quoted).slice(0, 80))}`}</div>` : ''}
    ${thumbs ? `<div class="thumbs n${shown.length}">${thumbs}</div>` : ''}
    ${!thumbs && p.card ? linkCard(base, p.card, true) : ''}
    <div class="actions"><button type="button" class="copyid" data-id="${esc(p.id)}">ID ${esc(p.id)} をコピー</button>${copyTextButton(p)}${archiveForm(base, p, back)}</div>
  </div>
</li>`;
}

export function postPage(base, p, lib, back = `${base}/p/${p.id}`, related = null) {
  const notes = lib.notesFor(p.id);
  return `
<p><a class="backlink" href="${base}/">← 一覧へ</a></p>
<article class="post${notes.length ? ' has-note' : ''}${p.archived_at ? ' archived' : ''}">
  <div class="meta">${author(p)} <time>${esc(formatDate(p.created_at))}</time> ${badges(p, notes.length)}</div>
  ${p.reply_to_id ? `<p class="reply">返信先: <a href="https://x.com/i/status/${esc(p.reply_to_id)}" target="_blank" rel="noopener noreferrer">X で見る</a></p>` : ''}
  ${textBlock(p)}
  ${mediaBlock(base, p.media)}
  ${p.card ? linkCard(base, p.card, false) : ''}
  ${p.quoted ? quotedBlock(base, p.quoted) : ''}
  <div class="actions">
    <button type="button" class="copyid primary" data-id="${esc(p.id)}">ID ${esc(p.id)} をコピー</button>
    ${copyTextButton(p)}
    ${archiveForm(base, p, back)}
    <label class="check"><input type="checkbox" class="pickbox" value="${esc(p.id)}"> 選択に加える</label>
    <a href="${esc(safeXUrl(p.url, p.id))}" target="_blank" rel="noopener noreferrer">X で開く</a>
  </div>
  <p class="saved"><span class="src ${p.source === 'api' ? 'api' : 'export'}">${p.source === 'api' ? '自動取り込み' : '過去分'}</span> ${esc(formatDate(p.fetched_at))} に保存${p.archived_at ? `・${esc(formatDate(p.archived_at))} にアーカイブ` : ''}</p>
</article>
${related ? `<section class="related-posts" id="related"${related.src ? ` data-src="${esc(related.src)}"` : ''}>${relatedList(base, related.items, related)}</section>` : ''}
<section class="notes">
  <h2>メモ${notes.length ? ` <span class="memo-count">${notes.length}</span>` : ''}</h2>
  ${notes.length ? notes.map((n) => noteBlock(base, n, p.id, lib)).join('\n') : '<p class="empty">まだメモはありません。</p>'}
</section>`;
}

// 本文をまるごとコピーするボタン。ほかの場所に貼っても分かるよう、投稿者・日時・URL・翻訳・引用元も添える
export function copyText(p) {
  const head = (x) => {
    const handle = x.author_handle ?? x.author?.handle;
    const name = x.author_name ?? x.author?.name;
    return [handle ? `@${handle}` : '', name ? `（${name}）` : '', x.created_at ? ` ${formatDate(x.created_at)}` : ''].join('');
  };
  const lines = [`[X の投稿 ${p.id}] ${head(p)}`.trim(), p.text ?? ''];
  if (p.translation) lines.push('', '[翻訳（Claude）]', p.translation.text);
  if (p.card?.title) lines.push('', `[リンク] ${p.card.title}${p.card.url ? ` ${p.card.url}` : ''}`);
  if (p.quoted) {
    lines.push('', p.quoted.unavailable ? `[引用元] ${p.quoted.url ?? ''}`.trim() : `[引用元 ${p.quoted.id}] ${head(p.quoted)}`.trim());
    if (!p.quoted.unavailable) {
      lines.push(p.quoted.text ?? '');
      if (p.quoted.translation) lines.push('[引用元の翻訳（Claude）]', p.quoted.translation.text);
    }
  }
  lines.push('', safeXUrl(p.url, p.id));
  return lines.join('\n');
}

function copyTextButton(p) {
  return `<button type="button" class="copytext" data-text="${esc(copyText(p))}">本文をコピー</button>`;
}

// 関連する投稿の欄の中身。items が null ならエラー。src があれば、画面のスクリプトが Jev の判定版に差し替える
export function relatedList(base, items, { jev = false, src = null, error = null } = {}) {
  const head = `<h2>関連する投稿 ${jev ? '<span class="badge jev">Jev で判定</span>' : src ? '<span class="rel-wait">Jev で判定中…</span>' : ''}</h2>`;
  if (error) return `${head}<p class="notice">Jev で判定できませんでした: ${esc(error)}</p>`;
  if (!items?.length) return `${head}<p class="empty">関連しそうな投稿は見つかりませんでした。</p>`;
  const li = items
    .map(({ post: r, p }) => `<li><a href="${base}/p/${esc(r.id)}"><span class="rel-meta">${author(r)}${Number.isFinite(p) ? ` <span class="badge jev">${Math.round(p * 100)}%</span>` : ''}</span><span class="rel-text">${esc((r.translation?.text ?? r.text ?? '').slice(0, 120)) || '（本文なし）'}</span></a></li>`)
    .join('');
  return `${head}<ul class="rel-list">${li}</ul>`;
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
  ${textBlock(q)}
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
  return `<article class="memo">
  <header class="memo-head"><h3>${n.title ? esc(n.title) : 'メモ'}</h3><time>${esc(formatDate(n.created_at))}</time></header>
  ${rel}
  <div class="md">${renderMarkdown(n.body)}</div>
</article>`;
}

// 保存した URL は信用せず、X のドメインのものだけリンクにする
function safeXUrl(url, id) {
  if (typeof url === 'string' && /^https:\/\/(x|twitter)\.com\/[\w/]+$/.test(url)) return url;
  return `https://x.com/i/status/${id}`;
}

export function messagePage(base, text) {
  return `<p>${esc(text)}</p><p><a href="${base}/">← 一覧へ</a></p>`;
}
