// 画面に出す文字はすべてここを通す。投稿の本文は他人が書いたデータなので、HTML として解釈させない。
export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 投稿の本文: 改行を保ち、URL だけをリンクにする
export function linkifyText(text) {
  const s = String(text ?? '');
  const re = /https?:\/\/[^\s<>"'　]+/g;
  let out = '';
  let last = 0;
  for (const m of s.matchAll(re)) {
    let url = m[0];
    const trail = url.match(/[.,;:!?)）」』。、]+$/);
    if (trail) url = url.slice(0, -trail[0].length);
    out += esc(s.slice(last, m.index));
    out += `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(shorten(url))}</a>`;
    last = m.index + url.length;
  }
  return out + esc(s.slice(last));
}

function shorten(url) {
  const u = url.replace(/^https?:\/\/(www\.)?/, '');
  return u.length > 60 ? `${u.slice(0, 57)}…` : u;
}
