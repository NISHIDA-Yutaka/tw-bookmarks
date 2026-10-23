// Markdown の前付け（先頭の --- で囲んだ部分）を読み書きする。
// 書くときは「キー: JSON の値」を1行ずつ並べる。JSON は YAML としても読めるので、人も Claude もそのまま読める。
// 読むときは、人や Claude が普通の YAML で書いた行（title: なにか）も受け付ける。

export function parse(src) {
  const text = src.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { data: {}, raw: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, raw: {}, body: text };
  const head = text.slice(4, end);
  const after = text.indexOf('\n', end + 4);
  const body = after === -1 ? '' : text.slice(after + 1);

  const data = {};
  const raw = {};
  for (const line of head.split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    raw[key] = value;
    data[key] = parseValue(value);
  }
  return { data, raw, body };
}

function parseValue(value) {
  if (value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return value.replace(/^(['"])(.*)\1$/, '$2');
  }
}

export function stringify(data, body) {
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n${body.endsWith('\n') ? body : body + '\n'}`;
}
