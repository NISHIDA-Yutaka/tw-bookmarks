// twitter-web-exporter が書き出した JSON の1件を、このアプリの投稿データの形にそろえる。
// 「すべてのメタデータを含める」付きで書き出すと metadata に X 内部の投稿データがまるごと入るので、
// それがあれば優先して使う（引用元の本文や長文ポストの全文が取れる）。無ければ表の列だけで作る。
//
// そろえた形:
//   { id, url, author: { id, handle, name }, created_at, text,
//     media: [{ type, remote, alt }], card: リンクカード | null,
//     quoted: 投稿 | { id, url, unavailable: true } | null, reply_to_id }
//   リンクカード: { title, description, domain, url, image_remote }

const ID_RE = /^\d{1,25}$/;

export function isPostId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function normalizeExportRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (rec.metadata && typeof rec.metadata === 'object') {
    const post = fromGraphql(rec.metadata, true);
    if (post) return post;
  }
  return fromFlat(rec);
}

function unwrap(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.__typename === 'TweetWithVisibilityResults') return unwrap(r.tweet);
  if (r.__typename === 'TweetTombstone' || r.__typename === 'TweetUnavailable') return null;
  return r.rest_id ? r : null;
}

function fromGraphql(raw, withQuoted) {
  const t = unwrap(raw);
  if (!t || !isPostId(String(t.rest_id))) return null;
  const id = String(t.rest_id);
  const legacy = t.legacy ?? {};
  const user = t.core?.user_results?.result ?? {};
  const handle = str(user.core?.screen_name ?? user.legacy?.screen_name);
  const name = str(user.core?.name ?? user.legacy?.name);

  const note = t.note_tweet?.note_tweet_results?.result;
  let text;
  let urls;
  if (note?.text) {
    text = str(note.text);
    urls = note.entity_set?.urls ?? [];
  } else {
    text = decodeEntities(str(legacy.full_text));
    urls = legacy.entities?.urls ?? [];
  }
  const mediaList = legacy.extended_entities?.media ?? legacy.entities?.media ?? [];
  text = expandLinks(text, urls, mediaList);

  const post = {
    id,
    url: handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/status/${id}`,
    author: { id: str(user.rest_id) || null, handle: handle || null, name: name || null },
    created_at: toIso(legacy.created_at),
    text,
    media: mediaList.map((m) => ({
      type: str(m.type) || 'photo',
      remote: str(m.media_url_https) || null,
      alt: str(m.ext_alt_text) || null,
    })),
    card: extractCard(t.card, urls),
    quoted: null,
    reply_to_id: isPostId(legacy.in_reply_to_status_id_str) ? legacy.in_reply_to_status_id_str : null,
  };

  const quotedId = legacy.quoted_status_id_str;
  if (withQuoted && (t.quoted_status_result || isPostId(quotedId))) {
    const q = fromGraphql(t.quoted_status_result?.result, false);
    if (q) {
      delete q.quoted;
      post.quoted = q;
    } else if (isPostId(quotedId)) {
      post.quoted = { id: quotedId, url: `https://x.com/i/status/${quotedId}`, unavailable: true };
    }
  }
  return post;
}

function fromFlat(rec) {
  const id = String(rec.id ?? '');
  if (!isPostId(id)) return null;
  const handle = str(rec.screen_name);
  const media = Array.isArray(rec.media) ? rec.media : [];
  const quotedId = rec.quoted_status == null ? null : String(rec.quoted_status);
  return {
    id,
    url: handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/status/${id}`,
    author: { id: str(rec.user_id) || null, handle: handle || null, name: str(rec.name) || null },
    // 表の日付は書き出し側の表示設定で形が変わるので、読めたときだけ使う
    created_at: toIso(rec.created_at),
    text: decodeEntities(str(rec.full_text)),
    media: media.map((m) => ({
      type: str(m?.type) || 'photo',
      // 写真は原寸の URL、動画は thumbnail（サムネイル画像）を元にする
      remote: baseImageUrl(str(m?.type) === 'photo' ? m?.original : m?.thumbnail),
      alt: str(m?.ext_alt_text) || null,
    })),
    // 表の列にはリンクカードの情報が無い
    card: null,
    quoted: isPostId(quotedId) ? { id: quotedId, url: `https://x.com/i/status/${quotedId}`, unavailable: true } : null,
    reply_to_id: isPostId(String(rec.in_reply_to ?? '')) ? String(rec.in_reply_to) : null,
  };
}

// 本文の URL に付く「リンクカード」（記事のタイトル・説明・画像）。投票やアプリ紹介などの特殊なカードは扱わない
const CARD_IMAGE_KEYS = [
  'summary_photo_image_original',
  'thumbnail_image_original',
  'photo_image_full_size_original',
  'player_image_original',
  'summary_photo_image_large',
  'thumbnail_image_large',
  'player_image_large',
];

function extractCard(card, urls) {
  const legacy = card?.legacy;
  if (!legacy || !Array.isArray(legacy.binding_values)) return null;
  const values = {};
  for (const b of legacy.binding_values) {
    if (b?.key) values[b.key] = b.value;
  }
  const text = (k) => str(values[k]?.string_value).trim();
  const title = text('title');
  if (!title) return null;

  // カードのリンクは t.co の短縮 URL なので、本文の URL の一覧から元の URL を探す
  const short = text('card_url') || str(legacy.url);
  const expanded = urls.find((u) => u?.url && u.url === short)?.expanded_url;
  let url = typeof expanded === 'string' ? expanded : short;
  if (!/^https?:\/\//.test(url)) url = null;

  const imageKey = CARD_IMAGE_KEYS.find((k) => values[k]?.image_value?.url);
  return {
    title,
    description: text('description') || null,
    domain: text('domain') || text('vanity_url') || (url ? safeHost(url) : null),
    url,
    image_remote: imageKey ? str(values[imageKey].image_value.url) : null,
  };
}

export function safeHost(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
}

// https://pbs.twimg.com/media/ABC?format=jpg&name=orig → https://pbs.twimg.com/media/ABC.jpg
export function baseImageUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  try {
    const url = new URL(u);
    const format = url.searchParams.get('format');
    const path = format && !/\.\w+$/.test(url.pathname) ? `${url.pathname}.${format}` : url.pathname;
    return `${url.origin}${path}`;
  } catch {
    return null;
  }
}

// 本文の t.co 短縮リンクを元の URL に戻し、画像を指すだけの t.co は消す
function expandLinks(text, urls, media) {
  let out = text;
  for (const u of urls) {
    if (u?.url && u?.expanded_url) out = out.split(u.url).join(u.expanded_url);
  }
  for (const m of media) {
    if (m?.url) out = out.split(m.url).join('');
  }
  return out.trim();
}

export function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function toIso(v) {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function str(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
