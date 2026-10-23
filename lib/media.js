// 投稿の画像を手元に保存する。書き出しファイルや API の応答は他人が作ったデータなので、
// 取りに行く先は X の画像サーバー（pbs.twimg.com）の https だけに限る。

const ALLOWED_HOST = 'pbs.twimg.com';
const MAX_BYTES = 20 * 1024 * 1024;
const EXT_BY_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

// size: 写真は 'orig'（原寸）、動画のサムネイルは 'large'
export function imageUrl(remote, size) {
  const url = new URL(remote);
  if (url.protocol !== 'https:' || url.hostname !== ALLOWED_HOST) {
    throw new Error(`画像の取得先が想定外です: ${url.hostname}`);
  }
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
