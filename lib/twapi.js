// X API v2 との通信（ブックマークの読み取りに要る分だけ）。
// 認証は OAuth 2.0 の PKCE（公開クライアント = Client Secret を持たない「Native App」）。
// 通信先は x.com（許可画面）と api.x.com だけ。トークンはエラーメッセージやログに出さない。

import crypto from 'node:crypto';

const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
const API = 'https://api.x.com';
export const SCOPES = ['tweet.read', 'users.read', 'bookmark.read', 'offline.access'];
export const REDIRECT_URI = 'http://127.0.0.1/callback';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const b64url = (buf) => buf.toString('base64url');

// 許可の URL と、あとでトークンに引き換えるときに使う値を作る
export function startAuthorization(clientId) {
  const verifier = b64url(crypto.randomBytes(48));
  const state = b64url(crypto.randomBytes(24));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return { url: url.href, verifier, state };
}

// 許可のあとに移った先のアドレスから code を取り出す（state が違えば受け付けない）
export function parseCallback(pasted, state) {
  let u;
  try {
    u = new URL(String(pasted).trim());
  } catch {
    throw new Error('アドレスとして読めませんでした。ブラウザのアドレス欄の内容をそのまま貼ってください。');
  }
  if (u.searchParams.get('error')) throw new Error(`許可されませんでした（${u.searchParams.get('error').slice(0, 60)}）`);
  if (u.searchParams.get('state') !== state) throw new Error('別の許可操作のアドレスです。もう一度最初からやり直してください。');
  const code = u.searchParams.get('code');
  if (!code) throw new Error('アドレスに code が含まれていません。');
  return code;
}

export function exchangeCode(clientId, code, verifier) {
  return token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier, client_id: clientId });
}

// 更新用のトークンで、新しいアクセストークンを得る。更新用のトークンも新しいものに替わる
export function refresh(clientId, refreshToken) {
  return token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
}

async function token(params) {
  const res = await request(`${API}/2/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (typeof res?.access_token !== 'string' || typeof res?.refresh_token !== 'string') {
    throw new ApiError('X からトークンを受け取れませんでした（offline.access の許可が無い可能性があります）', 200);
  }
  return { accessToken: res.access_token, refreshToken: res.refresh_token };
}

export async function getMe(accessToken) {
  const res = await request(`${API}/2/users/me`, { headers: auth(accessToken) });
  const id = res?.data?.id;
  if (typeof id !== 'string' || !/^\d{1,25}$/.test(id)) throw new ApiError('X からユーザー情報を受け取れませんでした', 200);
  return { id, username: typeof res.data.username === 'string' ? res.data.username : null };
}

export function getBookmarks(accessToken, userId, { maxResults = 10, paginationToken } = {}) {
  const url = new URL(`${API}/2/users/${encodeURIComponent(userId)}/bookmarks`);
  const params = {
    max_results: String(maxResults),
    expansions: 'author_id,attachments.media_keys,referenced_posts',
    'post.fields': 'attachments,created_at,entities,note_post',
    'user.fields': 'name,username',
    'media.fields': 'alt_text,media_key,preview_image_url,type,url',
  };
  if (paginationToken) params.pagination_token = paginationToken;
  url.search = new URLSearchParams(params).toString();
  return request(url.href, { headers: auth(accessToken) });
}

function auth(accessToken) {
  return { authorization: `Bearer ${accessToken}` };
}

async function request(url, init) {
  let res;
  try {
    res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new ApiError(`X に接続できませんでした（${err.name}）`, 0);
  }
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // 下で扱う
  }
  if (!res.ok) throw new ApiError(describeError(res.status, body), res.status);
  if (body === null) throw new ApiError('X の応答が JSON ではありませんでした', res.status);
  return body;
}

// 画面に出すエラーの文。X の応答の説明を短く添える（トークンは応答に含まれない）
export function describeError(status, body) {
  const detail = [body?.error_description, body?.detail, body?.title, body?.error]
    .find((v) => typeof v === 'string' && v)
    ?.slice(0, 160);
  const head =
    status === 400 && ['invalid_request', 'invalid_grant'].includes(body?.error)
      ? 'X の認証が切れたか、取り消されました。管理者が 「sudo tw-fetch-login」 でもう一度許可してください'
      : status === 401
        ? 'X の認証が通りませんでした。管理者が 「sudo tw-fetch-login」 でもう一度許可してください'
        : status === 402
          ? 'X API のクレジットが足りないか、利用上限に達しました（Developer Console で確認）'
          : status === 429
            ? 'X API の回数制限か利用上限に達しました。しばらく待つと戻ります'
            : `X API がエラーを返しました（HTTP ${status}）`;
  return detail ? `${head}: ${detail}` : head;
}
