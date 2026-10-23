// メモ用の小さな Markdown → HTML 変換。すべての文字を先にエスケープし、
// リンクは http/https だけを通す（メモには投稿の文が引用されることがあるため、HTML は一切そのまま出さない）。

import { esc } from './html.js';

export function renderMarkdown(src) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      // ページの見出しより下の段にそろえる
      const level = Math.min(h[1].length + 2, 6);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }
    const list = line.match(/^(\s*)([-*+]|\d+[.)])\s+/);
    if (list) {
      const ordered = /\d/.test(list[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m && /\d/.test(m[2]) === ordered && m[1].length <= list[1].length) {
          items.push([m[3]]);
          i++;
        } else if (items.length && /^\s{2,}\S/.test(lines[i])) {
          // 字下げされた続きの行や入れ子は、直前の項目に含める
          items[items.length - 1].push(lines[i].trim());
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${it.map(inline).join('<br>')}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      out.push(table(rows));
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(```|#{1,6}\s|\s*>|\s*([-*+]|\d+[.)])\s|\s*\|.*\|\s*$)/.test(lines[i])
    ) {
      buf.push(lines[i++]);
    }
    out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
  }
  return out.join('\n');
}

function table(rows) {
  const cells = (r) =>
    r
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
  const sep = rows[1] && /^[\s|:-]+$/.test(rows[1]);
  const head = sep ? cells(rows[0]) : null;
  const body = rows.slice(sep ? 2 : 0).map(cells);
  const th = head ? `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` : '';
  const tb = body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table>${th}<tbody>${tb}</tbody></table></div>`;
}

// 行の中の書式: `コード`、**太字**、[文字](URL)、そのまま書かれた URL
export function inline(text) {
  const parts = text.split(/(`[^`]+`)/);
  return parts
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) return `<code>${esc(part.slice(1, -1))}</code>`;
      const tokens = [];
      const keep = (html) => `\u0000${tokens.push(html) - 1}\u0000`;
      let s = part.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) =>
        keep(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`),
      );
      s = s.replace(/https?:\/\/[^\s<>"'\u0000]+/g, (url) => keep(link(url)));
      s = esc(s);
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      return s.replace(/\u0000(\d+)\u0000/g, (_, n) => tokens[Number(n)]);
    })
    .join('');
}

function link(url) {
  // 文末の句読点や閉じかっこはリンクに含めない
  const m = url.match(/^(.*?)([.,;:!?)）」』。、]*)$/);
  return `<a href="${esc(m[1])}" target="_blank" rel="noopener noreferrer">${esc(m[1])}</a>${esc(m[2])}`;
}
