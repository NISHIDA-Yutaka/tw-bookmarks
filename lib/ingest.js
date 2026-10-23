// 投稿をライブラリに保存する（画像を取ってきてから Markdown を書く）。
// 過去分の取り込み（bin/tw-import.js）と自動取り込み（bin/tw-fetch.js）で共通に使う。

import { writePost, saveMedia } from './library.js';
import { fetchImage } from './media.js';

// 画像の保存係を作る。onError は保存に失敗した画像ごとに呼ばれる（元の投稿が消えている等）
export function imageSaver(dir, { noMedia = false, onError = () => {} } = {}) {
  async function saveImage(id, remote, size, name) {
    if (noMedia || !remote) return null;
    try {
      const { ext, bytes } = await fetchImage(remote, size);
      return saveMedia(dir, id, name, ext, bytes);
    } catch (err) {
      onError(id, err);
      return null;
    }
  }

  // 写真は原寸、動画はサムネイルを大きめで
  async function saveImages(id, media, prefix) {
    const out = [];
    for (const [i, m] of (media ?? []).entries()) {
      out.push({ ...m, file: await saveImage(id, m.remote, m.type === 'photo' ? 'orig' : 'large', `${prefix}${i + 1}`) });
    }
    return out;
  }

  async function saveCard(id, card, name) {
    if (!card) return null;
    return { ...card, image_file: await saveImage(id, card.image_remote, null, name) };
  }

  // 新しい投稿を1件、画像ごと保存する。すでにあれば書き換えずに false
  async function savePost(post, extra) {
    const quoted = post.quoted && !post.quoted.unavailable ? post.quoted : null;
    post.media = await saveImages(post.id, post.media, '');
    post.card = await saveCard(post.id, post.card, 'card');
    if (quoted) {
      quoted.media = await saveImages(post.id, quoted.media, 'q');
      quoted.card = await saveCard(post.id, quoted.card, 'qcard');
    }
    return writePost(dir, post, extra);
  }

  return { saveCard, savePost };
}
