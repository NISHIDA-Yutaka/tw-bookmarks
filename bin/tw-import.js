#!/usr/bin/env node
// ブラウザで書き出した JSON（ブックマーク）をライブラリに取り込む。
// tools/export-bookmarks.js の書き出しと、twitter-web-exporter の JSON（「すべてのメタデータを含める」付きを推奨）の両方を読める。
// 書き出しファイルは標準入力から渡す。すでにある投稿は書き換えずに飛ばすので、何度実行してもよい。
// リンクカードを扱う前に取り込んだ投稿には、カードだけを書き足す（本文などは変えない）。
//
//   使い方: sudo -u tw-fetch node bin/tw-import.js < tw-bookmarks-export-xxxx.json
//   オプション: --dry-run   何件取り込むかを数えるだけで、書き込まない
//               --no-media  画像を取りに行かない（試しに取り込むとき用）
//
// 書き出しファイルの並びは「新しくブックマークしたものが先」と見なし、その順で保存順の番号を付ける。

import { normalizeExportRecord } from '../lib/normalize-export.js';
import { hasPost, writePost, saveMedia, maxSavedSeq, lacksCard, addCards } from '../lib/library.js';
import { fetchImage } from '../lib/media.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const noMedia = args.has('--no-media');
const LIBRARY_DIR = process.env.LIBRARY_DIR ?? '/var/lib/tw-bookmarks';

if (process.getuid?.() === 0) {
  console.error('root では実行しないでください（ファイルの持ち主が root になります）。sudo -u tw-fetch を付けて実行します。');
  process.exit(1);
}
if (process.stdin.isTTY) {
  console.error('書き出しファイルを標準入力で渡してください。例: sudo -u tw-fetch node bin/tw-import.js < ファイル名.json');
  process.exit(1);
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
let records;
try {
  records = JSON.parse(input.replace(/^﻿/, ''));
} catch {
  console.error('JSON として読めませんでした。ブラウザで書き出したファイルそのものか確かめてください。');
  process.exit(1);
}
if (!Array.isArray(records)) {
  console.error('想定と違う形のファイルです（投稿の一覧になっていません）。');
  process.exit(1);
}

const posts = [];
let invalid = 0;
let noMeta = 0;
const seen = new Set();
for (const rec of records) {
  const post = normalizeExportRecord(rec);
  if (!post) {
    invalid++;
    continue;
  }
  if (seen.has(post.id)) continue;
  seen.add(post.id);
  posts.push(post);
  if (!rec.metadata || typeof rec.metadata !== 'object') noMeta++;
}
const fresh = posts.filter((p) => !hasPost(LIBRARY_DIR, p.id));
const cardTargets = posts.filter((p) => hasPost(LIBRARY_DIR, p.id) && lacksCard(LIBRARY_DIR, p.id));
const cardFound = cardTargets.filter((p) => p.card || p.quoted?.card).length;

console.log(`書き出しファイル: ${records.length} 件（読めなかったもの ${invalid} 件）`);
console.log(`新しく取り込む: ${fresh.length} 件（取り込み済み ${posts.length - fresh.length} 件は飛ばします）`);
if (cardTargets.length) {
  console.log(`取り込み済みの投稿にリンクカードを書き足す: ${cardTargets.length} 件を確認（カードがあるのは ${cardFound} 件）`);
}
if (noMeta) {
  console.log(
    `注意: ${noMeta} 件にメタデータがありません。引用元の本文や長文ポストの続きが取り込めません。` +
      '書き出し時に「すべてのメタデータを含める」にチェックを入れると取れます。',
  );
}
if (dryRun || (!fresh.length && !cardTargets.length)) process.exit(0);

// 古いものから順に番号を振る（ファイルの先頭ほど新しいブックマーク）
let seq = maxSavedSeq(LIBRARY_DIR);
const queue = [
  ...fresh.reverse().map((post) => ({ kind: 'new', post, seq: ++seq })),
  ...cardTargets.map((post) => ({ kind: 'card', post })),
];
const total = queue.length;
const fetchedAt = new Date().toISOString();
let done = 0;
let added = 0;
let carded = 0;
let mediaFailed = 0;

async function saveImage(id, remote, size, name) {
  if (noMedia || !remote) return null;
  try {
    const { ext, bytes } = await fetchImage(remote, size);
    return saveMedia(LIBRARY_DIR, id, name, ext, bytes);
  } catch (err) {
    mediaFailed++;
    console.error(`  画像を保存できませんでした（投稿 ${id}）: ${err.message}`);
    return null;
  }
}

async function saveImages(id, media, prefix) {
  const out = [];
  for (const [i, m] of (media ?? []).entries()) {
    out.push({ ...m, file: await saveImage(id, m.remote, m.type === 'photo' ? 'orig' : 'large', `${prefix}${i + 1}`) });
  }
  return out;
}

async function saveCard(id, card, name) {
  if (!card) return null;
  return { ...card, image_file: await saveImage(id, card.image_remote, null, name) };
}

async function worker() {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const { post } = job;
    const quoted = post.quoted && !post.quoted.unavailable ? post.quoted : null;
    if (job.kind === 'new') {
      post.media = await saveImages(post.id, post.media, '');
      post.card = await saveCard(post.id, post.card, 'card');
      if (quoted) {
        quoted.media = await saveImages(post.id, quoted.media, 'q');
        quoted.card = await saveCard(post.id, quoted.card, 'qcard');
      }
      writePost(LIBRARY_DIR, post, { saved_seq: job.seq, source: 'browser-export', fetched_at: fetchedAt });
      added++;
    } else {
      const card = await saveCard(post.id, post.card, 'card');
      const quotedCard = quoted ? await saveCard(post.id, quoted.card, 'qcard') : null;
      if (addCards(LIBRARY_DIR, post.id, card, quotedCard) && (card || quotedCard)) carded++;
    }
    done++;
    if (done % 25 === 0 || done === total) console.log(`  ${done} / ${total}`);
  }
}

await Promise.all([worker(), worker(), worker()]);
console.log(
  `完了: ${added} 件を取り込みました。` +
    (carded ? `取り込み済みの ${carded} 件にリンクカードを書き足しました。` : '') +
    (mediaFailed ? `画像 ${mediaFailed} 件は保存できませんでした（元の投稿が消えている等）。` : ''),
);
