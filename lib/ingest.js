// 投稿をライブラリに保存する（画像を取ってきてから Markdown を書く）。
// 過去分の取り込み（bin/tw-import.js）と自動取り込み（bin/tw-fetch.js）で共通に使う。

import path from 'node:path';
import { writePost, saveMedia, mediaDir } from './library.js';
import { fetchImage, downloadVideo } from './media.js';
import { canSaveVideo } from './disk.js';

// 画像の保存係を作る。onError は保存に失敗した画像・動画ごとに呼ばれる（元の投稿が消えている等）
// 動画は video_remote があるものだけ、空き容量が足りるときだけ保存する（onVideoSkipped が呼ばれる）
export function imageSaver(dir, { noMedia = false, onError = () => {}, onVideoSkipped = () => {} } = {}) {
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

  // 動画の本体を <投稿ID>/<name>.mp4 に保存する。保存できたらその相対パス
  async function saveVideo(id, remote, name) {
    if (noMedia || !remote) return null;
    if (!canSaveVideo(dir)) {
      onVideoSkipped(id);
      return null;
    }
    try {
      await downloadVideo(remote, path.join(mediaDir(dir, id), `${name}.mp4`));
      return `${id}/${name}.mp4`;
    } catch (err) {
      onError(id, err);
      return null;
    }
  }

  // 写真は原寸、動画はサムネイルを大きめで（本体も保存する）
  async function saveImages(id, media, prefix) {
    const out = [];
    for (const [i, m] of (media ?? []).entries()) {
      const name = `${prefix}${i + 1}`;
      const item = { ...m, file: await saveImage(id, m.remote, m.type === 'photo' ? 'orig' : 'large', name) };
      if (m.video_remote) item.video_file = await saveVideo(id, m.video_remote, name);
      out.push(item);
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

  return { saveCard, savePost, saveVideo, saveImage };
}
