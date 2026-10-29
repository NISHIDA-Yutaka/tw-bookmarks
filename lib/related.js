// 「関連する投稿」。まずこのプログラムの中だけで候補を選び（言葉の重なり・同じ投稿者・同じリンク先・同じメモ）、
// Jev が使えれば候補を「同じ話題か」で判定し直す。Jev の結果は <ライブラリ>/state/related.json に覚えておく。

import fs from 'node:fs';
import path from 'node:path';
import { isPostId } from './normalize-export.js';

// 日本語は単語の区切りが無いので、2文字ずつの並び（と英数字の単語）で比べる
function grams(text) {
  const s = String(text ?? '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#][\w]+/g, ' ');
  const out = new Map();
  const add = (g) => out.set(g, (out.get(g) ?? 0) + 1);
  for (const w of s.match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? []) add(w);
  for (const run of s.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) add(run.slice(i, i + 2));
  }
  return out;
}

function topicText(p, notes) {
  return [p.text, p.translation?.text, p.quoted?.text, p.quoted?.translation?.text, p.card?.title, ...notes.map((n) => n.title)]
    .filter(Boolean)
    .join('\n');
}

// ライブラリの投稿が変わるたびに作り直す索引（重みは「珍しい言葉ほど重い」）
const indexes = new WeakMap();
function indexFor(lib) {
  let idx = indexes.get(lib.posts);
  if (idx) return idx;
  const vecs = new Map();
  const df = new Map();
  for (const p of lib.posts) {
    const g = grams(topicText(p, lib.notesFor(p.id)));
    vecs.set(p.id, g);
    for (const k of g.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  }
  const n = lib.posts.length;
  const weighted = new Map();
  for (const [id, g] of vecs) {
    const w = new Map();
    let norm = 0;
    for (const [k, tf] of g) {
      const v = (1 + Math.log(tf)) * Math.log(1 + n / (df.get(k) ?? 1));
      w.set(k, v);
      norm += v * v;
    }
    weighted.set(id, { w, norm: Math.sqrt(norm) || 1 });
  }
  idx = { weighted };
  indexes.set(lib.posts, idx);
  return idx;
}

// 候補を点数の高い順に返す（Jev を使わない計算）
export function localRelated(lib, post, limit = 20) {
  const { weighted } = indexFor(lib);
  const me = weighted.get(post.id);
  if (!me) return [];
  const handle = post.author_handle ?? post.author?.handle;
  const domain = post.card?.domain;
  const quoted = post.quoted?.id;
  const noteMates = new Set(lib.notesFor(post.id).flatMap((n) => n.posts));
  const out = [];
  for (const p of lib.posts) {
    if (p.id === post.id) continue;
    const o = weighted.get(p.id);
    let dot = 0;
    const [small, big] = me.w.size < o.w.size ? [me.w, o.w] : [o.w, me.w];
    for (const [k, v] of small) {
      const u = big.get(k);
      if (u) dot += v * u;
    }
    let score = dot / (me.norm * o.norm);
    if (handle && (p.author_handle ?? p.author?.handle) === handle) score += 0.08;
    if (domain && p.card?.domain === domain) score += 0.05;
    if (quoted && (p.quoted?.id === quoted || p.id === quoted)) score += 0.3;
    if (noteMates.has(p.id)) score += 0.5;
    if (score > 0.05) out.push({ id: p.id, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Jev で判定した結果の覚え書き。投稿が10件以上増えたら作り直す
export const RECOMPUTE_AFTER = 10;

export function relatedFile(dir) {
  return path.join(dir, 'state', 'related.json');
}

export function readRelatedCache(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(relatedFile(dir), 'utf8'));
    return data?.items && typeof data.items === 'object' ? data.items : {};
  } catch {
    return {};
  }
}

export function cachedRelated(dir, id, postCount) {
  const e = readRelatedCache(dir)[id];
  if (!e || !Array.isArray(e.list) || !Number.isFinite(e.n)) return null;
  if (Math.abs(postCount - e.n) >= RECOMPUTE_AFTER) return null;
  return e.list.filter((x) => isPostId(x?.id) && Number.isFinite(x?.p));
}

export function saveRelated(dir, id, postCount, list) {
  const items = readRelatedCache(dir);
  items[id] = { at: new Date().toISOString(), n: postCount, list };
  const file = relatedFile(dir);
  const tmp = path.join(path.dirname(file), `.related.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify({ items })}\n`, { mode: 0o640 });
  fs.renameSync(tmp, file);
}
