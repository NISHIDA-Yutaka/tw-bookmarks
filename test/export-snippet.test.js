import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeExportRecord } from '../lib/normalize-export.js';

// ブラウザの代わりの最小限の部品
function fakeBrowser() {
  const el = () => ({
    style: {},
    children: [],
    append(...c) { this.children.push(...c); },
    appendChild(c) { this.children.push(c); },
    addEventListener() {},
    remove() {},
    click() {},
  });
  class FakeXHR {
    constructor() { this.listeners = []; this.responseType = ''; }
    addEventListener(type, fn) { if (type === 'load') this.listeners.push(fn); }
    respond(body) { this.responseText = JSON.stringify(body); this.listeners.forEach((fn) => fn()); }
  }
  FakeXHR.prototype.open = function (method, url) { this.url = url; };
  const window = {
    fetch: async () => ({ clone: () => ({ json: async () => ({}) }) }),
    scrollTo() {},
  };
  const ctx = {
    window,
    XMLHttpRequest: FakeXHR,
    document: { body: el(), documentElement: { scrollHeight: 0 }, createElement: el },
    Blob: class {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    console,
    setInterval,
    clearInterval,
    setTimeout,
  };
  window.document = ctx.document;
  return ctx;
}

const tweet = (id, text) => ({
  __typename: 'Tweet',
  rest_id: id,
  core: { user_results: { result: { rest_id: '9', core: { screen_name: 'example_a', name: 'テスト' } } } },
  legacy: { created_at: 'Tue Oct 01 12:34:56 +0000 2024', full_text: text, entities: { urls: [] } },
});

const page = (items) => ({
  data: {
    bookmark_timeline_v2: {
      timeline: {
        instructions: [
          {
            type: 'TimelineAddEntries',
            entries: [
              ...items.map((t) => ({
                entryId: `tweet-${t.rest_id ?? t.tweet.rest_id}`,
                content: { itemContent: { tweet_results: { result: t } } },
              })),
              { entryId: 'cursor-bottom-1', content: { value: 'abc' } },
            ],
          },
        ],
      },
    },
  },
});

test('ブックマーク一覧の通信だけを記録し、取り込める形で持つ', () => {
  const ctx = fakeBrowser();
  vm.runInNewContext(fs.readFileSync(new URL('../tools/export-bookmarks.js', import.meta.url), 'utf8'), ctx);

  const xhr = new ctx.XMLHttpRequest();
  xhr.open('GET', 'https://x.com/i/api/graphql/abc123/Bookmarks?variables=%7B%7D');
  xhr.respond(page([tweet('1850000000000000010', '一件目'), { __typename: 'TweetWithVisibilityResults', tweet: tweet('1850000000000000011', '二件目') }]));

  // 同じ投稿が二度来ても1件として数える
  const again = new ctx.XMLHttpRequest();
  again.open('GET', 'https://x.com/i/api/graphql/abc123/Bookmarks?variables=%7B%22cursor%22%7D');
  again.respond(page([tweet('1850000000000000011', '二件目'), tweet('1850000000000000012', '三件目')]));

  // ほかの通信は記録しない
  const other = new ctx.XMLHttpRequest();
  other.open('GET', 'https://x.com/i/api/graphql/zzz/HomeTimeline');
  other.respond(page([tweet('1850000000000000099', 'ホーム')]));

  const records = ctx.window.__twExport.records;
  assert.deepEqual(Array.from(records, (r) => r.id), ['1850000000000000010', '1850000000000000011', '1850000000000000012']);
  const posts = JSON.parse(JSON.stringify(records)).map(normalizeExportRecord);
  assert.deepEqual(posts.map((p) => p.text), ['一件目', '二件目', '三件目']);
  assert.equal(posts[0].author.handle, 'example_a');
});
