// Jev による自動の振り分け。画面のサーバーが数分ごとに動かす（中継係にソケットで頼むのは画面だけなので）。
// 振り分けるのは、rule を書いたフォルダがあるときに、まだ見ていない投稿だけ。1件は1回だけ判定する。
//   新しく取り込んだ投稿（autoSince より後）と、「保存済みの投稿にもかける」を押したときは全件
// 手でフォルダに入れた投稿・アーカイブした投稿は動かさない。

import { updateFolders, autoFolder } from './folders.js';
import { judge, jevText, jevAvailable } from './jev-client.js';

// いちばん当てはまるフォルダの確率がこれ以上なら入れる。動画の長さの条件を先に満たしたものは、Jev は本文だけを
// 見ればよいので基準を下げる。NEAR_MIN 以上で届かなかったものは「惜しかった投稿」として残す
export const AUTO_MIN = 0.7;
export const AUTO_MIN_WITH_VIDEO = 0.5;
export const NEAR_MIN = 0.25;
// 1回で判定する件数（多すぎると時間がかかるので、残りは次の回に）
const PER_RUN = 300;

let running = false;

export function pendingPosts(lib) {
  const st = lib.folders;
  if (!st.folders.some(autoFolder)) return [];
  return lib.posts.filter(
    (p) =>
      !st.judged[p.id] &&
      !st.assign[p.id] &&
      !p.archived_at &&
      (st.backfill || (st.autoSince && String(p.fetched_at ?? '') > st.autoSince)),
  );
}

// 1回分を動かす。返り値は { judged, assigned } か、何もしなければ null
export async function runAutoSort(lib, dir, log = console) {
  if (running || !jevAvailable()) return null;
  lib.refresh();
  const rules = lib.folders.folders.filter(autoFolder);
  const todo = pendingPosts(lib).slice(0, PER_RUN);
  if (!todo.length) {
    if (lib.folders.backfill && !pendingPosts(lib).length) updateFolders(dir, (d) => void (d.backfill = false));
    return null;
  }
  running = true;
  try {
    const best = new Map();
    const offer = (id, folder, p, min) => {
      if (!best.has(id) || p - min > best.get(id).p - best.get(id).min) best.set(id, { folder, p, min });
    };
    for (const f of rules) {
      // 動画の長さの条件は、こちらで確かめる（Jev は動画を見られない）
      const fit = f.maxVideoSec ? todo.filter((p) => (lib.shortestVideoMs(p) ?? Infinity) < f.maxVideoSec * 1000) : todo;
      if (!fit.length) continue;
      const min = f.maxVideoSec ? AUTO_MIN_WITH_VIDEO : AUTO_MIN;
      if (!f.rule) {
        for (const p of fit) offer(p.id, f.id, 1, min);
        continue;
      }
      const scores = await judge(
        `Does this post match the following description? Answer about the post's text and attachments as described. Description (may be in Japanese): ${f.rule}`,
        fit.map((p) => ({ id: p.id, text: jevText(p, lib.notesFor(p.id), lib) })),
      );
      for (const [id, prob] of scores) offer(id, f.id, prob, min);
    }
    let assigned = 0;
    updateFolders(dir, (d, at) => {
      for (const p of todo) {
        // 判定のあいだに手で入れられていたら動かさない
        if (d.judged[p.id] || d.assign[p.id]) continue;
        d.judged[p.id] = at;
        const b = best.get(p.id);
        if (!b || !d.folders.some((f) => f.id === b.folder)) continue;
        const p3 = Math.round(b.p * 1000) / 1000;
        if (b.p >= b.min) {
          d.assign[p.id] = { folder: b.folder, by: 'jev', at, p: p3 };
          delete d.near[p.id];
          assigned++;
        } else if (b.p >= NEAR_MIN) d.near[p.id] = { folder: b.folder, p: p3 };
      }
      d.last = { at, judged: todo.length, assigned, error: null };
    });
    lib.invalidate();
    log.log(`自動の振り分け: ${todo.length} 件を判定、${assigned} 件をフォルダに入れました`);
    return { judged: todo.length, assigned };
  } catch (err) {
    updateFolders(dir, (d, at) => void (d.last = { at, judged: 0, assigned: 0, error: err.message }));
    log.error(`自動の振り分けができませんでした: ${err.message}`);
    return null;
  } finally {
    running = false;
  }
}
