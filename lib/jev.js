// Jev（Typesafe AI, Inc.・米国）の API を呼ぶ。中継係（bin/tw-jev.js）だけが使う。キーは中継係しか持たない。
//
//   POST https://api.typesafe.ai/v1/systemone
//   「state」に判定する内容、「questions」に質問を入れると、質問ごとに「はい」の確率（noul）が返る。
//   1回に数件ずつまとめて聞き、件数が多いときは少しずつ並べて送る。

export const API_URL = 'https://api.typesafe.ai/v1/systemone';
export const MODEL = 'jev-latest';
// まとめすぎると精度が落ちる（20件を超えると落ちるという報告がある）
export const BATCH = 10;
export const CONCURRENCY = 4;
export const MAX_ITEMS = 1000;
export const MAX_TEXT = 1500;
export const MAX_QUESTION = 400;

export class JevError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// 画面から来た依頼を確かめ、形のおかしいものは断る
export function checkRequest(body) {
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (!question || question.length > MAX_QUESTION) throw new JevError('質問が空か、長すぎます', 400);
  const context = typeof body.context === 'string' ? body.context.slice(0, MAX_TEXT) : null;
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > MAX_ITEMS) {
    throw new JevError(`判定する投稿は1〜${MAX_ITEMS}件にしてください`, 400);
  }
  const items = [];
  const seen = new Set();
  for (const it of body.items) {
    if (typeof it?.id !== 'string' || !/^\d{1,25}$/.test(it.id) || seen.has(it.id)) throw new JevError('投稿IDの形が不正です', 400);
    if (typeof it.text !== 'string') throw new JevError('本文がありません', 400);
    seen.add(it.id);
    items.push({ id: it.id, text: it.text.slice(0, MAX_TEXT) });
  }
  return { question, context, items };
}

// 1回分の依頼の中身。投稿は p1, p2… の名前で state に入れ、同じ名前の質問を1つずつ付ける
export function buildBody({ question, context }, chunk) {
  const state = {};
  if (context) state.base = context;
  const questions = {};
  chunk.forEach((it, i) => {
    const key = `p${i + 1}`;
    state[key] = it.text;
    questions[key] = { type: 'noul', instructions: `About the item "${key}" in the state only: ${question}` };
  });
  return { model: MODEL, state, questions };
}

async function call(apiKey, body) {
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new JevError(`Jev につながりませんでした（${err.name === 'TimeoutError' ? '時間切れ' : '通信エラー'}）`);
  }
  const text = await res.text();
  if (!res.ok) throw new JevError(describeError(res.status, text), res.status === 429 ? 429 : 502);
  try {
    return JSON.parse(text);
  } catch {
    throw new JevError('Jev の応答を読めませんでした');
  }
}

export function describeError(status, body) {
  if (status === 401 || status === 403) return 'Jev の API キーが無効です。管理者が /etc/apps/tw-jev.env のキーを確かめてください';
  if (status === 402) return 'Jev の残高（クレジット）が足りません。Typesafe のコンソールでチャージしてください';
  if (status === 429) return 'Jev の利用の上限に達しました。しばらくしてから試してください';
  let detail = '';
  try {
    const j = JSON.parse(body);
    detail = typeof j?.detail === 'string' ? j.detail : typeof j?.message === 'string' ? j.message : '';
  } catch {
    // 本文が JSON でなければ出さない
  }
  return `Jev がエラーを返しました（HTTP ${status}）${detail ? `: ${detail.slice(0, 200)}` : ''}`;
}

// 全件を判定して { id → 確率 } と使ったトークン数を返す
export async function judge(apiKey, req) {
  const chunks = [];
  for (let i = 0; i < req.items.length; i += BATCH) chunks.push(req.items.slice(i, i + BATCH));
  const scores = {};
  let tokens = 0;
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      const out = await call(apiKey, buildBody(req, chunk));
      tokens += Number(out?.usage?.input_tokens) || 0;
      chunk.forEach((it, i) => {
        const p = Number(out?.answers?.[`p${i + 1}`]?.noul);
        if (Number.isFinite(p)) scores[it.id] = Math.min(1, Math.max(0, p));
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  return { scores, tokens };
}

// 使う前のおおよそのトークン数（上限を超えそうなら送らない）。日本語は1文字1トークン強として多めに見る
export function estimateTokens(req) {
  const chars = req.items.reduce((n, it) => n + it.text.length + 80, 0);
  const extra = Math.ceil(req.items.length / BATCH) * ((req.context?.length ?? 0) + req.question.length * BATCH + 100);
  return Math.ceil((chars + extra) * 1.3);
}
