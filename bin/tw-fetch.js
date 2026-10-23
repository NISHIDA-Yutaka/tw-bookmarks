#!/usr/bin/env node
// X API から新しいブックマークを取り込む。systemd のタイマー（tw-fetch.timer）が1時間ごとに tw-fetch ユーザーで実行する。
//
//   新しくブックマークした順に10件ずつ受け取り、取り込み済みの投稿が出てきたページで止める。
//   X API は同じ投稿を1日（UTC）に何度読んでも課金は1回なので、毎時同じ10件を読んでも費用はほぼ増えない。
//   結果は <ライブラリ>/status/fetch.json に書き、失敗していれば画面に赤い帯が出る。
//
//   オプション: --check  1ページ（10件）だけ受け取り、どんな項目が取れたかを表示する。ライブラリには書かない

import fs from 'node:fs';
import path from 'node:path';
import { refresh, getBookmarks, ApiError } from '../lib/twapi.js';
import { loadToken, saveToken } from '../lib/token-store.js';
import { normalizeApiPage } from '../lib/normalize-api.js';
import { hasPost, maxSavedSeq } from '../lib/library.js';
import { imageSaver } from '../lib/ingest.js';

const LIBRARY_DIR = process.env.LIBRARY_DIR ?? '/var/lib/tw-bookmarks';
const PAGE_SIZE = 10;
// 1回で読むのは最大10ページ（100件）。それより多く溜まっていたら、次の回に続きを読まずに知らせる
const MAX_PAGES = 10;
const check = process.argv.includes('--check');
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
  const { savePost } = imageSaver(LIBRARY_DIR, {
    onError(id, err) {
      mediaFailed++;
      console.error(`画像を保存できませんでした（投稿 ${id}）: ${err.message}`);
    },
  });
  const fetchedAt = new Date().toISOString();
  for (const post of fresh.reverse()) {
    if (await savePost(post, { saved_seq: ++seq, source: 'api', fetched_at: fetchedAt })) added++;
  }
  const truncated = !reachedKnown && pages >= MAX_PAGES;
  return { added, pages, mediaFailed, truncated };
}

function printCheck(res, posts) {
  const raw = Array.isArray(res?.data) ? res.data.length : 0;
  console.log(`受け取った投稿: ${raw} 件（読めたもの ${posts.length} 件）。includes: ${Object.keys(res?.includes ?? {}).join(', ') || 'なし'}`);
  for (const p of posts) {
    const q = p.quoted ? (p.quoted.unavailable ? '引用元: 取れず' : `引用元: @${p.quoted.author?.handle ?? '?'}`) : '';
    console.log(
      `  ${p.id} @${p.author.handle ?? '?'} 本文${p.text.length}字 画像${p.media.length} ` +
        `${p.card ? 'カードあり ' : ''}${q} ${hasPost(LIBRARY_DIR, p.id) ? '（取り込み済み）' : '（新しい）'}`,
    );
  }
}

const startedAt = new Date().toISOString();
try {
  const result = await run();
  if (result) {
    const { added, pages, mediaFailed, truncated } = result;
    writeStatus({
      last_run_at: startedAt,
      last_success: new Date().toISOString(),
      last_added: added,
      last_pages: pages,
      last_media_failed: mediaFailed,
      last_warning: truncated
        ? `前回の取り込みから ${MAX_PAGES * PAGE_SIZE} 件以上ブックマークが増えていたため、古い分の一部を取り込めていない可能性があります`
        : null,
    });
    console.log(`取り込み: ${added} 件（${pages} ページ読みました${mediaFailed ? `、画像 ${mediaFailed} 件は保存できず` : ''}）`);
  }
} catch (err) {
  const message = err instanceof ApiError ? err.message : `${err.message}`.slice(0, 300);
  console.error(`取り込みに失敗しました: ${message}`);
  if (!check) writeStatus({ last_run_at: startedAt, last_error_at: new Date().toISOString(), last_error: message });
  process.exit(1);
}
