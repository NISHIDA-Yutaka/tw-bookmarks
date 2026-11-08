#!/usr/bin/env node
// X API から新しいブックマークを取り込む。systemd のタイマー（tw-fetch.timer）が1時間ごとに tw-fetch ユーザーで実行する。
//
//   新しくブックマークした順に10件ずつ受け取り、取り込み済みの投稿が出てきたページで止める。
//   X API は同じ投稿を1日（UTC）に何度読んでも課金は1回なので、毎時同じ10件を読んでも費用はほぼ増えない。
//   結果は <ライブラリ>/status/fetch.json に書き、失敗していれば画面に赤い帯が出る。
//
//   オプション: --check   1ページ（10件）だけ受け取り、どんな項目が取れたかを表示する。ライブラリには書かない
//              --videos  ブックマークを最初から読み直し（X の仕様で新しい順に800件まで）、保存済みの投稿で
//                        まだ無い動画だけを保存する。投稿のファイルは書き換えない（1回だけ使う。約 $0.001 × 件数）

import fs from 'node:fs';
import path from 'node:path';
import { canSaveVideo } from '../lib/disk.js';
import { refresh, getBookmarks, ApiError } from '../lib/twapi.js';
import { loadToken, saveToken, TOKEN_DIR } from '../lib/token-store.js';
import { normalizeApiPage } from '../lib/normalize-api.js';
import { hasPost, maxSavedSeq } from '../lib/library.js';
import { imageSaver } from '../lib/ingest.js';

const LIBRARY_DIR = process.env.LIBRARY_DIR ?? '/var/lib/tw-bookmarks';
const PAGE_SIZE = 10;
// 1回で読むのは最大10ページ（100件）。それより多く溜まっていたら、次の回に続きを読まずに知らせる
const MAX_PAGES = 10;
const check = process.argv.includes('--check');
const videos = process.argv.includes('--videos');
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

  if (videos) return backfillVideos(accessToken, tok.user_id);

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
  let videoSkipped = 0;
  const { savePost } = imageSaver(LIBRARY_DIR, {
    onError(id, err) {
      mediaFailed++;
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
  return { added, pages, mediaFailed, truncated, videoSkipped };
}

// 保存済みの投稿の動画を、あとから取りに行く（--videos）
async function backfillVideos(accessToken, userId) {
  let saved = 0;
  let failed = 0;
  let notLocal = 0;
  let pages = 0;
  let paginationToken;
  const { saveVideo } = imageSaver(LIBRARY_DIR, {
    onError(id, err) {
      failed++;
      console.error(`  投稿 ${id}: 保存できませんでした（${err.message}）`);
    },
  });
  // X の仕様で、ブックマークは新しい順に800件までしか読めない
  while (pages < 8) {
    const res = await getBookmarks(accessToken, userId, { maxResults: 100, paginationToken });
    pages++;
    for (const p of normalizeApiPage(res)) {
      if (!hasPost(LIBRARY_DIR, p.id)) {
        notLocal++;
        continue;
      }
      const lists = [['', p.media], ['q', p.quoted && !p.quoted.unavailable ? p.quoted.media : []]];
      for (const [prefix, media] of lists) {
        for (const [i, m] of (media ?? []).entries()) {
          if (!m.video_remote) continue;
          const name = `${prefix}${i + 1}`;
          if (fs.existsSync(path.join(LIBRARY_DIR, 'media', p.id, `${name}.mp4`))) continue;
          if (!canSaveVideo(LIBRARY_DIR)) {
            console.error('サーバーの空き容量が 20GB を切ったので、動画の保存を止めました');
            return { backfill: true, saved, failed, notLocal, pages, stopped: true };
          }
          if (await saveVideo(p.id, m.video_remote, name)) {
            saved++;
            console.log(`  投稿 ${p.id}: 動画 ${name} を保存しました`);
          }
        }
      }
    }
    paginationToken = typeof res?.meta?.next_token === 'string' ? res.meta.next_token : null;
    if (!paginationToken) break;
  }
  return { backfill: true, saved, failed, notLocal, pages, stopped: false };
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
    const { saved, failed, notLocal, pages, stopped } = result;
    console.log(`動画: ${saved} 本を保存しました（${pages} ページ読みました${failed ? `、${failed} 本は保存できず` : ''}${notLocal ? `、取り込み前の投稿 ${notLocal} 件は飛ばしました` : ''}${stopped ? '、空き容量が足りず途中で止めました' : ''}）`);
  } else if (result) {
    const { added, pages, mediaFailed, truncated, videoSkipped } = result;
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
