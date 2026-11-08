// Jev による自動の振り分け。画面のサーバーが数分ごとに動かす（中継係にソケットで頼むのは画面だけなので）。
// 振り分けるのは、rule を書いたフォルダがあるときに、まだ見ていない投稿だけ。1件は1回だけ判定する。
//   新しく取り込んだ投稿（autoSince より後）と、「保存済みの投稿にもかける」を押したときは全件
// 手でフォルダに入れた投稿・アーカイブした投稿は動かさない。

import { updateFolders } from './folders.js';
import { judge, jevText, jevAvailable } from './jev-client.js';

// いちばん当てはまるフォルダの確率がこれ以上なら入れる
export const AUTO_MIN = 0.7;
// 1回で判定する件数（多すぎると時間がかかるので、残りは次の回に）
const PER_RUN = 300;

let running = false;

export function pendingPosts(lib) {
  const st = lib.folders;
  if (!st.folders.some((f) => f.rule)) return [];
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
  const rules = lib.folders.folders.filter((f) => f.rule);
  const todo = pendingPosts(lib).slice(0, PER_RUN);
  if (!todo.length) {
    if (lib.folders.backfill && !pendingPosts(lib).length) updateFolders(dir, (d) => void (d.backfill = false));
    return null;
  }
  running = true;
  try {
    const items = todo.map((p) => ({ id: p.id, text: jevText(p, lib.notesFor(p.id), lib) }));
    const best = new Map();
    for (const f of rules) {
      const scores = await judge(`Does this post belong to the folder described below? Folder description (may be in Japanese): ${f.rule}`, items);
      for (const [id, prob] of scores) if (!best.has(id) || prob > best.get(id).p) best.set(id, { folder: f.id, p: prob });
    }
    let assigned = 0;
    updateFolders(dir, (d, at) => {
      for (const p of todo) {
        // 判定のあいだに手で入れられていたら動かさない
        if (d.judged[p.id] || d.assign[p.id]) continue;
        d.judged[p.id] = at;
        const b = best.get(p.id);
        if (b && b.p >= AUTO_MIN && d.folders.some((f) => f.id === b.folder)) {
          d.assign[p.id] = { folder: b.folder, by: 'jev', at, p: Math.round(b.p * 1000) / 1000 };
          assigned++;
        }
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
