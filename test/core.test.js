import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from '../lib/frontmatter.js';
import { normalizeExportRecord, baseImageUrl } from '../lib/normalize-export.js';
import { imageUrl } from '../lib/media.js';
import { renderMarkdown } from '../lib/markdown.js';
import { linkifyText } from '../lib/html.js';
import { Library, writePost, maxSavedSeq, addCards, lacksCard } from '../lib/library.js';
import { statusBanner, postPage } from '../lib/render.js';
import { normalizeApiPage } from '../lib/normalize-api.js';
import { setArchived, readArchive, parseArchiveForm, isSameOrigin } from '../lib/archive.js';
import { startAuthorization, parseCallback, describeError } from '../lib/twapi.js';

const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/export-sample.json', import.meta.url), 'utf8'));
const apiPage = JSON.parse(fs.readFileSync(new URL('./fixtures/api-bookmarks-page.json', import.meta.url), 'utf8'));

test('前付けは書いたものをそのまま読み戻せる', () => {
  const data = { id: '1850000000000000002', n: 3, media: [{ type: 'photo', file: null }], q: null };
  const { data: back, body } = parse(stringify(data, '本文\n---\n区切りっぽい行'));
  assert.deepEqual(back, data);
  assert.equal(body, '本文\n---\n区切りっぽい行\n');
});

test('人が普通の YAML で書いた前付けも読める', () => {
  const { data, raw } = parse('---\ntitle: 用語の整理\nposts: [1850000000000000002, 1850000000000000003]\n---\nメモ');
  assert.equal(data.title, '用語の整理');
  assert.match(raw.posts, /1850000000000000002/);
});

test('メタデータ付きの書き出しから、長文・引用元・画像を取り出す', () => {
  const p = normalizeExportRecord(sample[0]);
  assert.equal(p.id, '1850000000000000002');
  assert.equal(p.author.handle, 'example_a');
  assert.equal(p.created_at, '2024-10-01T12:34:56.000Z');
  assert.match(p.text, /^長文ポストの全文です。/);
  assert.match(p.text, /https:\/\/example\.com\/article/);
  assert.equal(p.media.length, 2);
  assert.equal(p.media[0].alt, '説明文');
  assert.equal(p.quoted.id, '1800000000000000001');
  assert.equal(p.quoted.text, '引用元の本文です & 記号 <b>');
});

test('引用元が消えている投稿は、引用元のIDだけ残す', () => {
  const p = normalizeExportRecord(sample[1]);
  assert.equal(p.id, '1850000000000000003');
  assert.deepEqual(p.quoted, { id: '1700000000000000009', url: 'https://x.com/i/status/1700000000000000009', unavailable: true });
});

test('メタデータが無い書き出しも、表の列から取り込める', () => {
  const p = normalizeExportRecord(sample[2]);
  assert.equal(p.text, 'メタデータなしの投稿 & https://t.co/zzz');
  assert.equal(p.media[0].remote, 'https://pbs.twimg.com/media/CCC.png');
  assert.equal(p.quoted.unavailable, true);
});

test('IDの形が不正なものは取り込まない', () => {
  assert.equal(normalizeExportRecord(sample[3]), null);
  assert.equal(normalizeExportRecord(sample[4]), null);
});

test('画像は pbs.twimg.com の https からだけ取る', () => {
  assert.equal(imageUrl('https://pbs.twimg.com/media/AAA.jpg', 'orig'), 'https://pbs.twimg.com/media/AAA?format=jpg&name=orig');
  assert.throws(() => imageUrl('https://evil.example/media/AAA.jpg', 'orig'));
  assert.throws(() => imageUrl('http://pbs.twimg.com/media/AAA.jpg', 'orig'));
  assert.equal(baseImageUrl('https://pbs.twimg.com/media/X?format=jpg&name=thumb'), 'https://pbs.twimg.com/media/X.jpg');
});

test('投稿の本文に書かれたタグはそのまま文字として出る', () => {
  const html = linkifyText('<script>alert(1)</script> https://example.com/a?b=1&c="x" 終わり');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=" /);
});

test('メモの Markdown は HTML を通さず、http(s) 以外のリンクを作らない', () => {
  const html = renderMarkdown('# 見出し\n\n<img src=x onerror=alert(1)>\n\n[押して](javascript:alert(1)) と [出典](https://example.com/x)\n\n- **太字** `<b>`\n- 二つ目');
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /<a href="https:\/\/example\.com\/x"/);
  assert.match(html, /<strong>太字<\/strong>/);
  assert.match(html, /<code>&lt;b&gt;<\/code>/);
  assert.match(html, /<h3>見出し<\/h3>/);
});

test('ライブラリに書いた投稿とメモを読み、メモを投稿に結びつける', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twlib-'));
  try {
    const a = normalizeExportRecord(sample[0]);
    const b = normalizeExportRecord(sample[1]);
    assert.equal(writePost(dir, b, { saved_seq: 1 }), true);
    assert.equal(writePost(dir, a, { saved_seq: 2 }), true);
    // 同じ投稿は書き換えない
    assert.equal(writePost(dir, { ...a, text: '書き換え' }, { saved_seq: 9 }), false);
    assert.equal(maxSavedSeq(dir), 2);

    fs.mkdirSync(path.join(dir, 'notes'));
    fs.writeFileSync(
      path.join(dir, 'notes', 'n1.md'),
      '---\ntitle: 比べてみた\nposts: [1850000000000000002, 1850000000000000003]\n---\n本文',
    );
    const lib = new Library(dir, { ttlMs: 0 }).refresh();
    assert.deepEqual(lib.posts.map((p) => p.id), ['1850000000000000002', '1850000000000000003']);
    assert.match(lib.get('1850000000000000002').text, /^長文ポスト/);
    assert.equal(lib.notesFor('1850000000000000003')[0].title, '比べてみた');
    assert.ok(lib.get('1850000000000000003').haystack.includes('比べてみた'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('自動取り込みの失敗や停止を帯で知らせる', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  assert.equal(statusBanner(null, now), '');
  assert.equal(statusBanner({ last_success: '2026-10-23T11:00:00Z' }, now), '');
  assert.match(statusBanner({ last_success: '2026-10-23T01:00:00Z' }, now), /止まっているかもしれません/);
  assert.match(
    statusBanner({ last_success: '2026-10-23T10:00:00Z', last_error_at: '2026-10-23T11:00:00Z', last_error: '<認証切れ>' }, now),
    /失敗しています.*&lt;認証切れ&gt;/s,
  );
});

test('リンクカードを取り出し、t.co を元の URL に戻す', () => {
  const p = normalizeExportRecord(sample[0]);
  assert.deepEqual(p.card, {
    title: '記事の<タイトル>',
    description: '記事の説明',
    domain: 'example.com',
    url: 'https://example.com/article',
    image_remote: 'https://pbs.twimg.com/card_img/1/x?format=jpg&name=orig',
  });
  assert.equal(imageUrl(p.card.image_remote, null), 'https://pbs.twimg.com/card_img/1/x?format=jpg&name=orig');
  assert.equal(normalizeExportRecord(sample[1]).card, null);
});

test('取り込み済みの投稿にリンクカードだけを書き足し、本文は変えない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twlib-'));
  try {
    const a = normalizeExportRecord(sample[0]);
    // リンクカード導入前に取り込んだ状態を作る
    const old = { ...a };
    delete old.card;
    old.quoted = { ...a.quoted };
    delete old.quoted.card;
    writePost(dir, old, { saved_seq: 1 });
    const file = path.join(dir, 'posts', `${a.id}.md`);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^card: null\n/m, ''));
    const before = parse(fs.readFileSync(file, 'utf8'));
    assert.equal(lacksCard(dir, a.id), true);

    assert.equal(addCards(dir, a.id, { ...a.card, image_file: `${a.id}/card.jpg` }, null), true);
    assert.equal(addCards(dir, a.id, null, null), false);
    const after = parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.body, before.body);
    assert.equal(after.data.card.title, '記事の<タイトル>');
    assert.equal(after.data.quoted.card, null);
    assert.equal(after.data.quoted.text, before.data.quoted.text);

    const lib = new Library(dir, { ttlMs: 0 }).refresh();
    const html = postPage('/tw', lib.get(a.id), lib);
    assert.match(html, /class="linkcard" href="https:\/\/example\.com\/article"/);
    assert.match(html, /記事の&lt;タイトル&gt;/);
    assert.ok(lib.get(a.id).haystack.includes('記事の説明'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('X API の応答から、長文・画像・リンクカード・引用元を取り出す', () => {
  const posts = normalizeApiPage(apiPage);
  assert.deepEqual(
    posts.map((p) => p.id),
    ['1860000000000000003', '1860000000000000002'],
  );
  const [a, b] = posts;
  assert.equal(a.author.handle, 'example_a');
  assert.equal(a.url, 'https://x.com/example_a/status/1860000000000000003');
  assert.equal(a.created_at, '2026-10-20T10:00:00.000Z');
  assert.equal(a.text, '長文ポストの全文です。記事はこちら https://example.com/article');
  assert.deepEqual(a.media, [
    { type: 'photo', remote: 'https://pbs.twimg.com/media/AAA.jpg', alt: '写真の説明' },
    { type: 'video', remote: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/BBB.jpg', alt: null },
  ]);
  assert.equal(a.card.title, '記事のタイトル');
  assert.equal(a.card.url, 'https://example.com/article?ref=1');
  assert.equal(a.card.domain, 'example.com');
  assert.equal(a.card.image_remote, 'https://pbs.twimg.com/news_img/big?format=jpg&name=orig');
  assert.equal(a.quoted.author.handle, 'example_q');
  assert.equal(a.quoted.text, '引用元の本文');
  assert.equal(a.quoted.media[0].remote, 'https://pbs.twimg.com/media/QQQ.png');

  assert.equal(b.text, 'A & B <script> の話 https://twitter.com/quoted_c/status/1810000000000000002');
  assert.equal(b.reply_to_id, '1850000000000000099');
  assert.equal(b.quoted.author.handle, 'quoted_c');
  assert.equal(b.quoted.url, 'https://x.com/quoted_c/status/1810000000000000002');
  assert.equal(b.quoted.text, '投稿者が返ってこない引用元');
  assert.equal(b.card, null);
});

test('X API の古い項目名（tweet）で返ってきても読める', () => {
  const old = JSON.parse(
    JSON.stringify(apiPage).replaceAll('"note_post"', '"note_tweet"').replaceAll('"referenced_posts"', '"referenced_tweets"'),
  );
  old.includes.tweets = old.includes.posts;
  delete old.includes.posts;
  const [a] = normalizeApiPage(old);
  assert.match(a.text, /^長文ポストの全文です。/);
  assert.equal(a.quoted.text, '引用元の本文');
});

test('X API の応答が想定外の形でも落ちない', () => {
  const gone = structuredClone(apiPage);
  gone.includes.posts = [];
  assert.deepEqual(normalizeApiPage(gone)[1].quoted, {
    id: '1810000000000000002',
    url: 'https://x.com/i/status/1810000000000000002',
    unavailable: true,
  });
  assert.deepEqual(normalizeApiPage(null), []);
  assert.deepEqual(normalizeApiPage({ data: 'x' }), []);
  assert.deepEqual(normalizeApiPage({ data: [{ id: '1', text: 5, attachments: { media_keys: 'x' } }] })[0].media, []);
});

test('X の許可の URL は PKCE（S256）で、戻り先の state が違えば受け付けない', () => {
  const { url, verifier, state } = startAuthorization('client-id-example');
  const u = new URL(url);
  assert.equal(u.origin, 'https://x.com');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1/callback');
  assert.equal(u.searchParams.get('scope'), 'tweet.read users.read bookmark.read offline.access');
  assert.notEqual(u.searchParams.get('code_challenge'), verifier);
  assert.equal(parseCallback(`http://127.0.0.1/callback?state=${state}&code=abc`, state), 'abc');
  assert.throws(() => parseCallback('http://127.0.0.1/callback?state=other&code=abc', state), /別の許可操作/);
  assert.throws(() => parseCallback('http://127.0.0.1/callback?error=access_denied', state), /許可されませんでした/);
});

test('X API のエラーは分かる言葉にして、認証切れは再許可の方法を示す', () => {
  assert.match(describeError(400, { error: 'invalid_request', error_description: 'Value passed for the token was invalid.' }), /tw-fetch-login/);
  assert.match(describeError(402, null), /クレジット/);
  assert.match(describeError(503, { title: 'Service Unavailable' }), /HTTP 503）: Service Unavailable/);
});

test('取り込みの注意と最後の成功時刻を画面に出す', () => {
  const now = Date.parse('2026-10-24T03:00:00Z');
  const html = statusBanner({ last_success: '2026-10-24T02:30:00Z', last_warning: '100 件以上<増えて>' }, now);
  assert.match(html, /100 件以上&lt;増えて&gt;/);
  assert.equal(statusBanner({ last_success: '2026-10-24T02:30:00Z', last_warning: null }, now), '');
});

test('アーカイブは元の投稿を書き換えず、別のファイルで持つ', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-arch-'));
  fs.mkdirSync(path.join(dir, 'state'));
  const post = normalizeExportRecord(sample[0]);
  writePost(dir, post, { saved_seq: 1, source: 'browser-export' });
  const before = fs.readFileSync(path.join(dir, 'posts', `${post.id}.md`), 'utf8');

  assert.equal(setArchived(dir, [post.id, '../etc', post.id], true, new Date('2026-10-24T00:00:00Z')), 1);
  assert.equal(setArchived(dir, [post.id], true), 0);
  assert.deepEqual([...readArchive(dir)], [[post.id, '2026-10-24T00:00:00.000Z']]);
  assert.equal(fs.readFileSync(path.join(dir, 'posts', `${post.id}.md`), 'utf8'), before);
  const lib = new Library(dir, { ttlMs: 0 }).refresh();
  assert.equal(lib.get(post.id).archived_at, '2026-10-24T00:00:00.000Z');

  assert.equal(setArchived(dir, [post.id], false), 1);
  assert.equal(lib.refresh().get(post.id).archived_at, null);
  fs.rmSync(dir, { recursive: true });
});

test('アーカイブのフォームは、おかしな ID や外への戻り先を捨てる', () => {
  const f = parseArchiveForm('ids=1850000000000000002+abc+1850000000000000003&do=archive&back=%2Ftw%2F%3Fview%3Dall', '/tw');
  assert.deepEqual(f.ids, ['1850000000000000002', '1850000000000000003']);
  assert.equal(f.archived, true);
  assert.equal(f.back, '/tw/?view=all');
  assert.equal(parseArchiveForm('ids=1&do=restore', '/tw').archived, false);
  assert.equal(parseArchiveForm('ids=1&do=delete', '/tw').archived, null);
  for (const back of ['https://evil.example/', '//evil.example/tw/', '/tw/\\evil', '/other']) {
    assert.equal(parseArchiveForm(`ids=1&do=archive&back=${encodeURIComponent(back)}`, '/tw').back, '/tw/');
  }
});

test('ほかのサイトから送られたアーカイブの操作は受け付けない', () => {
  const host = 'kagoya.taild08d78.ts.net';
  assert.equal(isSameOrigin({ host, origin: `https://${host}`, 'sec-fetch-site': 'same-origin' }), true);
  assert.equal(isSameOrigin({ host, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }), false);
  assert.equal(isSameOrigin({ host, origin: 'https://evil.example' }), false);
  assert.equal(isSameOrigin({ host, origin: `https://${host}`, 'sec-fetch-site': 'same-site' }), false);
  assert.equal(isSameOrigin({ host }), false);
  assert.equal(isSameOrigin({ host, origin: 'null' }), false);
  // Referrer-Policy: no-referrer の画面からのフォームは Origin が null になる
  assert.equal(isSameOrigin({ host, origin: 'null', 'sec-fetch-site': 'same-origin' }), true);
  assert.equal(isSameOrigin({ host, origin: 'null', 'sec-fetch-site': 'cross-site' }), false);
});

test('翻訳があれば本文の代わりに翻訳を出し、翻訳だと分かる印と原文を添える', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twb-'));
  try {
    const a = normalizeExportRecord(sample[0]);
    writePost(dir, a, { saved_seq: 1 });
    const trDir = path.join(dir, 'notes', 'translations');
    fs.mkdirSync(trDir, { recursive: true });
    fs.writeFileSync(path.join(trDir, `${a.id}.md`), '---\nlang: "en"\ntranslated_at: "2026-10-24T21:30:00+09:00"\n---\n訳文<script>alert(1)</script>\n');
    fs.writeFileSync(path.join(trDir, 'bad name.md'), '---\n---\n無視される\n');

    const lib = new Library(dir, { ttlMs: 0 }).refresh();
    const p = lib.get(a.id);
    assert.equal(p.translation.lang, 'en');
    assert.ok(p.haystack.includes('訳文'));
    const html = postPage('/tw', p, lib);
    assert.match(html, /英語から翻訳（Claude）/);
    assert.match(html, /badge tr">翻訳（英語）/);
    assert.match(html, /訳文&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /<details class="original"><summary>原文を表示/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Jev への依頼は形を確かめ、投稿ごとの質問にまとめ、確率を受け取る', async () => {
  const { checkRequest, buildBody, judge, describeError } = await import('../lib/jev.js');
  assert.throws(() => checkRequest({ question: '', items: [] }));
  assert.throws(() => checkRequest({ question: 'q', items: [{ id: '../x', text: 'a' }] }));
  const req = checkRequest({ question: 'AI の話？', context: 'base', items: Array.from({ length: 12 }, (_, i) => ({ id: String(100 + i), text: `t${i}` })) });
  const body = buildBody(req, req.items.slice(0, 2));
  assert.equal(body.state.base, 'base');
  assert.equal(body.state.p2, 't1');
  assert.equal(body.questions.p1.type, 'noul');
  assert.match(body.questions.p1.instructions, /"p1".*AI の話？/);

  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    calls.push({ url, auth: opts.headers.Authorization });
    const answers = Object.fromEntries(Object.keys(b.questions).map((k) => [k, { type: 'noul', noul: b.state[k] === 't3' ? 0.9 : 0.1 }]));
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 50 } }), { status: 200 });
  };
  try {
    const out = await judge('KEY', req);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(calls[0].auth, 'Bearer KEY');
    assert.equal(out.scores['103'], 0.9);
    assert.equal(out.scores['100'], 0.1);
    assert.equal(out.tokens, 100);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(describeError(401, ''), /API キーが無効/);
  assert.doesNotMatch(describeError(500, '{"detail":"x"}'), /KEY/);
});

test('関連する投稿の候補は、言葉の重なりと同じメモで選ぶ', async () => {
  const { localRelated } = await import('../lib/related.js');
  const { jevText } = await import('../lib/jev-client.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twrel-'));
  try {
    const mk = (id, text, seq) => writePost(dir, { id, url: `https://x.com/i/status/${id}`, author: { handle: `u${id.slice(-1)}` }, text, media: [], card: null, quoted: null }, { saved_seq: seq });
    mk('1000000000000000001', '機械学習モデルの評価指標について', 1);
    mk('1000000000000000002', '評価指標の選び方：機械学習モデル編', 2);
    mk('1000000000000000003', '今日の晩ごはんはカレー', 3);
    mk('1000000000000000004', '猫がかわいい', 4);
    fs.mkdirSync(path.join(dir, 'notes'));
    fs.writeFileSync(path.join(dir, 'notes', 'a.md'), '---\ntitle: "まとめ"\nposts: ["1000000000000000001", "1000000000000000004"]\n---\nメモ\n');
    const lib = new Library(dir, { ttlMs: 0 }).refresh();
    const ids = localRelated(lib, lib.get('1000000000000000001')).map((x) => x.id);
    assert.deepEqual(ids.slice(0, 2).sort(), ['1000000000000000002', '1000000000000000004']);
    assert.ok(!ids.includes('1000000000000000003'));
    assert.match(jevText(lib.get('1000000000000000001'), lib.notesFor('1000000000000000001')), /@u1:\n機械学習.*\n\[メモ\] まとめ/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
