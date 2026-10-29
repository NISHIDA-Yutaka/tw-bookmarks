// 画面から Jev の中継係（bin/tw-jev.js）に判定を頼む。中継係とはサーバーの中のソケットでだけ話す（画面は外へつながない）。

import http from 'node:http';
import fs from 'node:fs';

const SOCKET = process.env.JEV_SOCKET ?? '/run/tw-jev.sock';

export function jevAvailable() {
  return fs.existsSync(SOCKET);
}

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        socketPath: SOCKET,
        method,
        path: pathname,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        timeout: 90_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let out;
          try {
            out = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            return reject(new Error('中継係の応答を読めませんでした'));
          }
          if (res.statusCode !== 200) return reject(new Error(typeof out?.error === 'string' ? out.error : `中継係のエラー（${res.statusCode}）`));
          resolve(out);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Jev の判定が時間内に終わりませんでした')));
    req.on('error', (err) =>
      reject(
        err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
          ? new Error('Jev の中継係が動いていません（管理者が ops/setup-jev.sh を実行する）')
          : err,
      ),
    );
    if (data) req.write(data);
    req.end();
  });
}

// items: [{ id, text }] → Map(id → 確率)
export async function judge(question, items, context = null) {
  const out = await request('POST', '/judge', { question, context, items });
  const scores = new Map();
  for (const [id, p] of Object.entries(out?.scores ?? {})) if (Number.isFinite(p)) scores.set(id, p);
  return scores;
}

// Jev に見せる投稿の文。翻訳があれば翻訳、引用元・リンクカード・メモの見出しも添える
export function jevText(p, notes = []) {
  const handle = p.author_handle ?? p.author?.handle;
  const parts = [
    handle ? `@${handle}:` : '',
    p.translation?.text ?? p.text ?? '',
    p.quoted && !p.quoted.unavailable ? `[引用] ${p.quoted.translation?.text ?? p.quoted.text ?? ''}` : '',
    p.card?.title ? `[リンク] ${p.card.title}` : '',
    ...notes.map((n) => (n.title ? `[メモ] ${n.title}` : '')),
  ];
  return parts.filter(Boolean).join('\n').replace(/https?:\/\/\S+/g, '').slice(0, 1200);
}
