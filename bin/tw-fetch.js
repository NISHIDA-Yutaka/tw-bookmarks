#!/usr/bin/env node
// X API から新しいブックマークを取り込む。systemd のタイマー（tw-fetch.timer）が1時間ごとに tw-fetch ユーザーで実行する。
//
//   新しくブックマークした順に10件ずつ受け取り、取り込み済みの投稿が出てきたページで止める。
//   X API は同じ投稿を1日（UTC）に何度読んでも課金は1回なので、毎時同じ10件を読んでも費用はほぼ増えない。
//   結果は <ライブラリ>/status/fetch.json に書き、失敗していれば画面に赤い帯が出る。
//
//   オプション: --check   1ページ（10件）だけ受け取り、どんな項目が取れたかを表示する。ライブラリには書かない
//              --media   ブックマークを最初から読み直し（X の仕様で新しい順に800件まで）、保存済みの投稿で
//                        まだ無い画像・動画・リンクカードの画像だけを保存する。投稿のファイルは書き換えない
//                        （取れなかった分を取り直すときに使う。約 $0.001 × 件数）。--videos も同じ。
//                        そのあと、まだ足りない投稿（X でブックマークを外したもの・引用元）の件数と費用を出す
//              --lookup  （--media と一緒に）足りない投稿を ID で直接読んで取りに行く（1件 $0.005）

import fs from 'node:fs';
import path from 'node:path';
import { canSaveVideo } from '../lib/disk.js';
import { refresh, getBookmarks, getPosts, ApiError } from '../lib/twapi.js';
import { loadToken, saveToken, TOKEN_DIR } from '../lib/token-store.js';
import { normalizeApiPage } from '../lib/normalize-api.js';
import { hasPost, maxSavedSeq, Library } from '../lib/library.js';
import { imageSaver } from '../lib/ingest.js';

const LIBRARY_DIR = process.env.LIBRARY_DIR ?? '/var/lib/tw-bookmarks';
const PAGE_SIZE = 10;
// 1回で読むのは最大10ページ（100件）。それより多く溜まっていたら、次の回に続きを読まずに知らせる
const MAX_PAGES = 10;
const check = process.argv.includes('--check');
const videos = process.argv.includes('--media') || process.argv.includes('--videos');
const lookup = process.argv.includes('--lookup');
const statusFile = path.join(LIBRARY_DIR, 'status', 'fetch.json');

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  } catch {
    return {};
  }
}

function writeStatus(patch) {
  const next = { ...readStatus(), ...patch };
  const tmp = `${statusFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o640 });
  fs.renameSync(tmp, statusFile);
}

async function run() {
  const clientId = process.env.TW_CLIENT_ID;
  if (!clientId) throw new Error('Client ID が設定されていません（/etc/apps/tw-bookmarks.env の TW_CLIENT_ID）');
  const tok = loadToken();
  if (!tok) throw new Error('X の許可がまだです。管理者が 「sudo tw-fetch-login」 を実行してください');

  // 更新用トークンは使うと新しいものに替わるので、受け取ったらすぐ保存する
  const { accessToken, refreshToken } = await refresh(clientId, tok.refresh_token);
  saveToken({ ...tok, refresh_token: refreshToken, refreshed_at: new Date().toISOString() });

  if (videos) return backfillMedia(accessToken, tok.user_id);

  const fresh = [];
  const seen = new Set();
  let reachedKnown = false;
  let pages = 0;
  let paginationToken;
  while (pages < MAX_PAGES) {
    const res = await getBookmarks(accessToken, tok.user_id, { maxResults: PAGE_SIZE, paginationToken });
    pages++;
    const posts = normalizeApiPage(res);
    if (check) {
      printCheck(res, posts);
      return null;
    }
    for (const p of posts) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      if (hasPost(LIBRARY_DIR, p.id)) reachedKnown = true;
      else fresh.push(p);
    }
    paginationToken = typeof res?.meta?.next_token === 'string' ? res.meta.next_token : null;
    if (reachedKnown || !paginationToken) break;
  }

  // 応答は新しいものが先。古いものから順に保存順の番号を振る
  let seq = maxSavedSeq(LIBRARY_DIR);
  let added = 0;
  let mediaFailed = 0;
  let mediaError = null;
  let videoSkipped = 0;
  const { savePost } = imageSaver(LIBRARY_DIR, {
    onError(id, err) {
      mediaFailed++;
      mediaError ??= err.message;
      console.error(`画像・動画を保存できませんでした（投稿 ${id}）: ${err.message}`);
    },
    onVideoSkipped() {
      videoSkipped++;
    },
  });
  const fetchedAt = new Date().toISOString();
  for (const post of fresh.reverse()) {
    if (await savePost(post, { saved_seq: ++seq, source: 'api', fetched_at: fetchedAt })) added++;
  }
  const truncated = !reachedKnown && pages >= MAX_PAGES;
  return { added, pages, mediaFailed, mediaError, truncated, videoSkipped };
}

// 保存済みの投稿の画像・動画を、あとから取りに行く（--media）
const exists = (id, name, exts) => exts.some((ext) => fs.existsSync(path.join(LIBRARY_DIR, 'media', id, `${name}.${ext}`)));
const IMAGE_EXTS = ['jpg', 'png', 'gif', 'webp'];

async function backfillMedia(accessToken, userId) {
  const r = { backfill: true, images: 0, saved: 0, failed: 0, notLocal: 0, pages: 0, stopped: false, missing: 0, looked: 0, gone: 0 };
  const { saveVideo, saveImage } = imageSaver(LIBRARY_DIR, {
    onError(id, err) {
      r.failed++;
      console.error(`  投稿 ${id}: 保存できませんでした（${err.message}）`);
    },
  });

  // owner の置き場に、prefix（'' か引用元の 'q'）の名前で、無いものだけ保存する。容量が足りなければ false
  async function fill(owner, prefix, media, card) {
    for (const [i, m] of (media ?? []).entries()) {
      const name = `${prefix}${i + 1}`;
      if (!exists(owner, name, IMAGE_EXTS) && (await saveImage(owner, m.remote, m.type === 'photo' ? 'orig' : 'large', name))) {
        r.images++;
        console.log(`  投稿 ${owner}: 画像 ${name} を保存しました`);
      }
      if (!m.video_remote || exists(owner, name, ['mp4'])) continue;
      if (!canSaveVideo(LIBRARY_DIR)) {
        console.error('サーバーの空き容量が 20GB を切ったので、動画の保存を止めました');
        r.stopped = true;
        return false;
      }
      if (await saveVideo(owner, m.video_remote, name)) {
        r.saved++;
        console.log(`  投稿 ${owner}: 動画 ${name} を保存しました`);
      }
    }
    const cardName = `${prefix}card`;
    if (card?.image_remote && !exists(owner, cardName, IMAGE_EXTS) && (await saveImage(owner, card.image_remote, null, cardName))) {
      r.images++;
      console.log(`  投稿 ${owner}: リンクカードの画像を保存しました`);
    }
    return true;
  }

  // 1. ブックマーク一覧を読み直す（X の仕様で新しい順に800件まで）
  while (r.pages < 8) {
    const res = await getBookmarks(accessToken, userId, { maxResults: 100, paginationToken: r.token });
    r.pages++;
    for (const p of normalizeApiPage(res)) {
      if (!hasPost(LIBRARY_DIR, p.id)) {
        r.notLocal++;
        continue;
      }
      const quoted = p.quoted && !p.quoted.unavailable ? p.quoted : null;
      if (!(await fill(p.id, '', p.media, p.card))) return r;
      if (quoted && !(await fill(p.id, 'q', quoted.media, quoted.card))) return r;
    }
    r.token = typeof res?.meta?.next_token === 'string' ? res.meta.next_token : null;
    if (!r.token) break;
  }
  delete r.token;

  // 2. まだ足りない投稿（X でブックマークを外したもの、引用元）。読む ID → [置き場の投稿, 名前の頭]
  const lib = new Library(LIBRARY_DIR, { ttlMs: 0 }).refresh();
  const lacks = (owner, prefix, media, card) =>
    (media ?? []).some((m, i) => !m.file || (m.type !== 'photo' && !exists(owner, `${prefix}${i + 1}`, ['mp4']))) || Boolean(card?.image_remote && !card.image_file);
  const want = new Map();
  const add = (id, owner, prefix) => {
    if (!want.has(id)) want.set(id, []);
    want.get(id).push({ owner, prefix });
  };
  for (const p of lib.posts) {
    if (lacks(p.id, '', p.media, p.card)) add(p.id, p.id, '');
    const q = p.quoted && !p.quoted.unavailable ? p.quoted : null;
    if (q && /^\d{1,25}$/.test(q.id ?? '') && lacks(p.id, 'q', q.media, q.card)) add(q.id, p.id, 'q');
  }
  r.missing = want.size;
  if (!want.size || !lookup) return r;

  const ids = [...want.keys()];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const got = new Map(normalizeApiPage(await getPosts(accessToken, chunk)).map((p) => [p.id, p]));
    r.looked += chunk.length;
    for (const id of chunk) {
      const post = got.get(id);
      if (!post) {
        r.gone++;
        continue;
      }
      for (const { owner, prefix } of want.get(id)) if (!(await fill(owner, prefix, post.media, post.card))) return r;
    }
  }
  return r;
}

function printCheck(res, posts) {
  const raw = Array.isArray(res?.data) ? res.data.length : 0;
  console.log(`受け取った投稿: ${raw} 件（読めたもの ${posts.length} 件）。includes: ${Object.keys(res?.includes ?? {}).join(', ') || 'なし'}`);
  for (const p of posts) {
    const v = [...p.media, ...(p.quoted?.media ?? [])].filter((m) => m.video_remote).length;
    const q = p.quoted ? (p.quoted.unavailable ? '引用元: 取れず' : `引用元: @${p.quoted.author?.handle ?? '?'}`) : '';
    console.log(
      `  ${p.id} @${p.author.handle ?? '?'} 本文${p.text.length}字 画像${p.media.length} ${v ? `動画${v} ` : ''}` +
        `${p.card ? 'カードあり ' : ''}${q} ${hasPost(LIBRARY_DIR, p.id) ? '（取り込み済み）' : '（新しい）'}`,
    );
  }
}

// 同時に2つ動かさない。更新用トークンは使うと替わるので、2つが同じトークンを使うと認証が切れる
const lockFile = path.join(TOKEN_DIR, 'run.lock');
function takeLock() {
  try {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  // 前の実行が途中で落ちて残ったもの（1時間より古いか、そのプロセスがもう無い）は外す
  let held;
  try {
    held = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch {
    held = {};
  }
  let alive = false;
  try {
    process.kill(held.pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  if (alive && Date.now() - Number(held.at) < 60 * 60 * 1000) return false;
  fs.rmSync(lockFile, { force: true });
  return takeLock();
}

if (!takeLock()) {
  console.log('ほかの取り込み（自動取り込みか tw-fetch-videos など）が動いているので、今回は何もしません');
  process.exit(0);
}
process.on('exit', () => fs.rmSync(lockFile, { force: true }));

const startedAt = new Date().toISOString();
try {
  const result = await run();
  if (result?.backfill) {
    const { images, saved, failed, notLocal, pages, stopped, missing, looked, gone } = result;
    console.log(`画像 ${images} 枚・動画 ${saved} 本を保存しました（ブックマーク一覧を ${pages} ページ読みました${looked ? `、投稿 ${looked} 件を ID で読みました` : ''}${failed ? `、${failed} 件は保存できず` : ''}${notLocal ? `、取り込み前の投稿 ${notLocal} 件は飛ばしました` : ''}${gone ? `、${gone} 件は X で消えていて読めませんでした` : ''}${stopped ? '、空き容量が足りず途中で止めました' : ''}）`);
    if (missing && !lookup) {
      console.log(`まだ画像・動画が足りない投稿が ${missing} 件あります（X でブックマークを外したものや引用元）。`);
      console.log(`ID で直接読んで取りに行くには: sudo tw-fetch-media --lookup（費用の目安 $${(missing * 0.005).toFixed(2)}、1件 $0.005）`);
    }
  } else if (result) {
    const { added, pages, mediaFailed, mediaError, truncated, videoSkipped } = result;
    writeStatus({
      last_run_at: startedAt,
      last_success: new Date().toISOString(),
      last_added: added,
      last_pages: pages,
      last_media_failed: mediaFailed,
      last_warning: truncated
        ? `前回の取り込みから ${MAX_PAGES * PAGE_SIZE} 件以上ブックマークが増えていたため、古い分の一部を取り込めていない可能性があります`
        : videoSkipped
          ? `サーバーの空き容量が足りないため、動画 ${videoSkipped} 本を保存しませんでした（サムネイルは保存済み）`
          : mediaFailed
            ? `画像・動画 ${mediaFailed} 件を保存できませんでした（${mediaError}）。投稿は保存済み。原因を直したら sudo tw-fetch-media で取り直せます`
            : null,
    });
    console.log(`取り込み: ${added} 件（${pages} ページ読みました${mediaFailed ? `、画像 ${mediaFailed} 件は保存できず` : ''}）`);
  }
} catch (err) {
  const message = err instanceof ApiError ? err.message : `${err.message}`.slice(0, 300);
  console.error(`取り込みに失敗しました: ${message}`);
  if (!check && !videos) writeStatus({ last_run_at: startedAt, last_error_at: new Date().toISOString(), last_error: message });
  process.exit(1);
}
