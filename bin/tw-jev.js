#!/usr/bin/env node
// Jev の中継係。systemd が tw-jev.socket（/run/tw-jev.sock、画面のグループだけがつなげる）で受けた依頼を、Jev に取り次ぐ。
// API キーは systemd が root の権限で /etc/apps/tw-jev.env から読んで渡す。画面・噛み砕き役・開発用ユーザーからは読めない。
// プログラムは root の持ち物の /usr/local/lib/tw-jev にあり、ops/setup-jev.sh で置いたときだけ変わる。
//
//   POST /judge   { question, context?, items: [{ id, text }] } → { scores: { id: 確率 }, tokens }
//   GET  /status  { configured, month, used_tokens, limit_tokens }
//
//   JEV_API_KEY          Jev の API キー
//   JEV_MONTHLY_TOKENS   1か月に使ってよいトークン数（既定 2500万 ≒ $1.05）
//   STATE_DIRECTORY      使った量の記録の置き場（systemd が用意する）

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { judge, checkRequest, estimateTokens, JevError } from '../lib/jev.js';

const apiKey = process.env.JEV_API_KEY ?? '';
const limit = Number(process.env.JEV_MONTHLY_TOKENS) || 25_000_000;
const usageFile = path.join(process.env.STATE_DIRECTORY ?? '/var/lib/tw-jev', 'usage.json');
const MAX_BODY = 4 * 1024 * 1024;

const month = () => new Date().toISOString().slice(0, 7);

function readUsage() {
  try {
    const u = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
    if (u.month === month() && Number.isFinite(u.used_tokens)) return u;
  } catch {
    // 無ければ今月はまだ使っていない
  }
  return { month: month(), used_tokens: 0 };
}

function addUsage(tokens) {
  const u = readUsage();
  u.used_tokens += tokens;
  const tmp = `${usageFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(u)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, usageFile);
}

function reply(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// 同時に走らせる判定は1つだけ（使いすぎと上限の数え漏れを防ぐ）
let busy = Promise.resolve();

async function handleJudge(body) {
  const req = checkRequest(body);
  if (!apiKey) throw new JevError('Jev の API キーが設定されていません（/etc/apps/tw-jev.env の JEV_API_KEY）', 503);
  const run = busy.then(async () => {
    const used = readUsage().used_tokens;
    if (used + estimateTokens(req) > limit) {
      throw new JevError(`今月の Jev の利用上限（${limit.toLocaleString()} トークン）に達しました。来月まで待つか、管理者が上限を上げてください`, 429);
    }
    const out = await judge(apiKey, req);
    addUsage(out.tokens);
    return out;
  });
  busy = run.catch(() => {});
  return run;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/status') {
    const u = readUsage();
    return reply(res, 200, { configured: Boolean(apiKey), month: u.month, used_tokens: u.used_tokens, limit_tokens: limit });
  }
  if (req.method !== 'POST' || req.url !== '/judge') return reply(res, 404, { error: 'Not Found' });
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      reply(res, 413, { error: '依頼が大きすぎます' });
      req.destroy();
    } else chunks.push(c);
  });
  req.on('end', async () => {
    if (res.headersSent) return;
    try {
      const out = await handleJudge(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      reply(res, 200, out);
    } catch (err) {
      const known = err instanceof JevError;
      // キーや依頼の中身はログに出さない
      console.error(`判定できませんでした: ${known ? err.message : err.name}`);
      reply(res, known ? err.status : 500, { error: known ? err.message : '中継係で問題が起きました' });
    }
  });
});

// systemd のソケット（LISTEN_FDS）から受ける。手で試すときは JEV_SOCKET のパスで待ち受ける
if (process.env.LISTEN_FDS === '1') server.listen({ fd: 3 });
else server.listen(process.env.JEV_SOCKET ?? path.join(process.cwd(), 'tw-jev.sock'));
console.log(`tw-jev: 待ち受けを始めました（キー: ${apiKey ? '設定あり' : '空'}、今月の上限 ${limit} トークン）`);
