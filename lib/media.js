import fs from 'node:fs';
import path from 'node:path';

// 投稿の画像を手元に保存する。書き出しファイルや API の応答は他人が作ったデータなので、
// 取りに行く先は X の画像サーバー（pbs.twimg.com）の https だけに限る。

const ALLOWED_HOST = 'pbs.twimg.com';
const MAX_BYTES = 20 * 1024 * 1024;
const EXT_BY_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

// size: 写真は 'orig'（原寸）、動画のサムネイルは 'large'。null ならリンクカードの画像として URL をそのまま使う
export function imageUrl(remote, size) {
  const url = new URL(remote);
  if (url.protocol !== 'https:' || url.hostname !== ALLOWED_HOST) {
    throw new Error(`画像の取得先が想定外です: ${url.hostname}`);
  }
  if (size === null) return url.href;
  const m = url.pathname.match(/^(.+)\.(jpg|jpeg|png|gif|webp)$/i);
  if (m) return `${url.origin}${m[1]}?format=${m[2].toLowerCase()}&name=${size}`;
  return `${url.origin}${url.pathname}?name=${size}`;
}

// 画像を取ってきて { ext, bytes } を返す
export async function fetchImage(remote, size) {
  const res = await fetch(imageUrl(remote, size), {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`画像の取得に失敗: HTTP ${res.status}`);
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  const ext = EXT_BY_TYPE[type];
  if (!ext) throw new Error(`画像ではない応答です: ${type}`);

  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_BYTES) throw new Error('画像が大きすぎます');
    chunks.push(chunk);
  }
  return { ext, bytes: Buffer.concat(chunks) };
}

// 動画（GIF も中身は mp4）。取りに行く先は X の動画サーバー（video.twimg.com）の https だけ。
// 画質は短い辺が 720 までのうちいちばん良いもの。200MB を超えるものは保存しない（サムネイルのまま）
const VIDEO_HOST = 'video.twimg.com';
export const MAX_VIDEO_SIDE = 720;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

export function videoUrl(remote) {
  const url = new URL(remote);
  if (url.protocol !== 'https:' || url.hostname !== VIDEO_HOST) throw new Error(`動画の取得先が想定外です: ${url.hostname}`);
  return url.href;
}

// API の variants（{ bit_rate, content_type, url }）から保存するものを選ぶ。選べなければ null
export function pickVideoVariant(variants) {
  if (!Array.isArray(variants)) return null;
  const mp4 = variants
    .filter((v) => v && v.content_type === 'video/mp4' && typeof v.url === 'string')
    .filter((v) => {
      try {
        videoUrl(v.url);
        return true;
      } catch {
        return false;
      }
    })
    .map((v) => {
      // URL に「/1280x720/」のように大きさが入っている
      const m = v.url.match(/\/(\d{2,5})x(\d{2,5})\//);
      return { url: v.url, rate: Number(v.bit_rate) || 0, side: m ? Math.min(Number(m[1]), Number(m[2])) : null };
    });
  if (!mp4.length) return null;
  const fit = mp4.filter((v) => v.side === null || v.side <= MAX_VIDEO_SIDE);
  const pool = fit.length ? fit : [mp4.reduce((a, b) => ((a.side ?? 0) <= (b.side ?? 0) ? a : b))];
  return pool.reduce((a, b) => (b.rate > a.rate ? b : a)).url;
}

// 動画を file に保存する。途中の分は隠しファイルに書き、終わってから名前を変える（メモリに全部は載せない）
export async function downloadVideo(remote, file) {
  const res = await fetch(videoUrl(remote), { redirect: 'error', signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`動画の取得に失敗: HTTP ${res.status}`);
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  if (type !== 'video/mp4') throw new Error(`動画ではない応答です: ${type}`);
  if (Number(res.headers.get('content-length')) > MAX_VIDEO_BYTES) {
    await res.body?.cancel();
    throw new Error('動画が 200MB を超えるので保存しません');
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  const fh = await fs.promises.open(tmp, 'w', 0o640);
  let total = 0;
  try {
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > MAX_VIDEO_BYTES) throw new Error('動画が 200MB を超えるので保存しません');
      await fh.write(chunk);
    }
    await fh.close();
    fs.renameSync(tmp, file);
  } catch (err) {
    await fh.close().catch(() => {});
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return total;
}
