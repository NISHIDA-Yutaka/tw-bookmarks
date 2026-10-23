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

const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/export-sample.json', import.meta.url), 'utf8'));

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
