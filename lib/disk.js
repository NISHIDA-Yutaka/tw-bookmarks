// サーバーの空き容量。画面に注意を出すのと、少ないときに動画の保存を止めるのに使う。

import fs from 'node:fs';

const GB = 1024 ** 3;
// これを切ったら動画を保存しない（投稿と画像は保存する）
export const VIDEO_MIN_FREE = 20 * GB;
// これを切ったら画面に注意を出す（全体の 10% か 30GB の大きいほう）
const warnBelow = (total) => Math.max(total * 0.1, 30 * GB);

export function diskStatus(dir) {
  const s = fs.statfsSync(dir);
  return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
}

export const gb = (bytes) => `${Math.round((bytes / GB) * 10) / 10}GB`;

// 注意の文（問題なければ null）
export function diskAlert(st) {
  if (!st || st.free >= warnBelow(st.total)) return null;
  const left = `空きは残り ${gb(st.free)}（全体 ${gb(st.total)}）`;
  if (st.free < VIDEO_MIN_FREE) return `サーバーの空き容量がとても少なくなっています。${left}。動画の保存を止めています`;
  return `サーバーの空き容量が少なくなっています。${left}。${gb(VIDEO_MIN_FREE)} を切ると動画の保存を止めます`;
}

export function canSaveVideo(dir) {
  try {
    return diskStatus(dir).free >= VIDEO_MIN_FREE;
  } catch {
    return false;
  }
}
