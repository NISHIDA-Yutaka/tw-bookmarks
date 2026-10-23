// X API v2 のブックマーク一覧（GET /2/users/:id/bookmarks）の応答を、このアプリの投稿データの形にそろえる。
// 形は lib/normalize-export.js と同じ。応答は他人が作ったデータなので、型と形を確かめてから使う。
//
// API の項目名は 2026 年に tweet → post へ変わった（note_tweet → note_post、referenced_tweets → referenced_posts、
// includes.tweets → includes.posts）。どちらで返ってきても読めるようにしておく。

import { isPostId, baseImageUrl, decodeEntities, toIso, str, safeHost } from './normalize-export.js';

// 応答1ページ分を投稿の配列にする（並びは応答のまま。新しくブックマークしたものが先）
export function normalizeApiPage(res) {
  const data = Array.isArray(res?.data) ? res.data : [];
  const inc = res?.includes ?? {};
  const ctx = {
    users: byKey(inc.users, 'id'),
    media: byKey(inc.media, 'media_key'),
    posts: byKey(inc.posts ?? inc.tweets, 'id'),
  };
  const out = [];
  for (const t of data) {
    const post = fromApi(t, ctx, true);
    if (post) out.push(post);
  }
  return out;
}

function byKey(list, key) {
  const m = new Map();
  if (Array.isArray(list)) for (const v of list) if (v && typeof v[key] === 'string') m.set(v[key], v);
  return m;
}

function fromApi(t, ctx, withQuoted) {
  if (!t || typeof t !== 'object' || !isPostId(t.id)) return null;
  const user = ctx.users.get(t.author_id) ?? {};
  const handle = str(user.username);

  const note = t.note_post ?? t.note_tweet;
  const urls = Array.isArray(t.entities?.urls) ? t.entities.urls : [];
  const noteUrls = Array.isArray(note?.entities?.urls) ? note.entities.urls : [];
  let text = decodeEntities(str(note?.text || t.text));
  for (const u of [...noteUrls, ...urls]) {
    if (!u?.url || typeof u.url !== 'string') continue;
    // 画像・動画を指すだけの t.co は消し、それ以外は元の URL に戻す
    const to = u.media_key ? '' : str(u.unwound_url || u.expanded_url);
    if (u.media_key || /^https?:\/\//.test(to)) text = text.split(u.url).join(to);
  }

  const keys = Array.isArray(t.attachments?.media_keys) ? t.attachments.media_keys : [];
  const media = keys
    .map((k) => ctx.media.get(k))
    .filter(Boolean)
    .map((m) => ({
      type: str(m.type) || 'photo',
      // 写真は原寸の URL、動画と GIF はサムネイル（preview_image_url）を元にする
      remote: baseImageUrl(m.type === 'photo' ? m.url : m.preview_image_url),
      alt: str(m.alt_text) || null,
    }));

  const refs = t.referenced_posts ?? t.referenced_tweets;
  const ref = (type) => (Array.isArray(refs) ? refs.find((r) => r?.type === type && isPostId(r.id))?.id : null) ?? null;

  const post = {
    id: t.id,
    url: handle ? `https://x.com/${handle}/status/${t.id}` : `https://x.com/i/status/${t.id}`,
    author: { id: isPostId(t.author_id) ? t.author_id : null, handle: handle || null, name: str(user.name) || null },
    created_at: toIso(t.created_at),
    text: text.trim(),
    media,
    card: extractCard(urls),
    quoted: null,
    reply_to_id: ref('replied_to'),
  };

  const quotedId = ref('quoted');
  if (withQuoted && quotedId) {
    const q = fromApi(ctx.posts.get(quotedId), ctx, false);
    if (q) {
      delete q.quoted;
      post.quoted = q;
    } else {
      post.quoted = { id: quotedId, url: `https://x.com/i/status/${quotedId}`, unavailable: true };
    }
  }
  return post;
}

// 本文の URL に付く「リンクカード」。API では URL の項目にタイトル・説明・画像が入っている
function extractCard(urls) {
  for (const u of urls) {
    if (!u || u.media_key) continue;
    const title = str(u.title).trim();
    if (!title) continue;
    const url = [u.unwound_url, u.expanded_url].map(str).find((v) => /^https?:\/\//.test(v)) ?? null;
    // 投稿へのリンク（引用など）はカードにしない
    if (url && /^https?:\/\/(www\.)?(x|twitter)\.com\//.test(url)) continue;
    const images = Array.isArray(u.images) ? u.images.filter((i) => typeof i?.url === 'string') : [];
    images.sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0));
    return {
      title,
      description: str(u.description).trim() || null,
      domain: url ? safeHost(url) : null,
      url,
      image_remote: images[0]?.url ?? null,
    };
  }
  return null;
}
