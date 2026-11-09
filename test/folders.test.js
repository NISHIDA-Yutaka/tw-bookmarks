import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// 自動の振り分けは中継係にソケットで頼むので、偽物の中継係を先に決めておく
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'twfold-'));
process.env.JEV_SOCKET = path.join(tmp, 'jev.sock');

const { writePost, Library } = await import('../lib/library.js');
const { applyFolderForm, assignPosts, readFolders, parseAssignForm } = await import('../lib/folders.js');
const { runAutoSort, pendingPosts } = await import('../lib/autosort.js');
const { listPage, foldersPage } = await import('../lib/render.js');
const { mediaLine } = await import('../lib/jev-client.js');

function library() {
  const dir = fs.mkdtempSync(path.join(tmp, 'lib-'));
  fs.mkdirSync(path.join(dir, 'state'));
  const mk = (id, text, extra = {}) =>
    writePost(dir, { id, url: `https://x.com/i/status/${id}`, author: { handle: 'u' }, text, media: [], card: null, quoted: null, ...extra }, { saved_seq: Number(id.slice(-2)), fetched_at: '2026-11-08T03:00:00.000Z', source: 'api' });
  return { dir, mk };
}

test('フォルダを作り・変え・消す。名前が空・重複は断り、消すと中の投稿はフォルダなしに戻る', () => {
  const { dir, mk } = library();
  mk('1000000000000000001', 'a');
  assert.match(applyFolderForm(dir, 'do=create&name=%E3%82%B7%E3%83%A7%E3%83%BC%E3%83%88&hide=1&rule=short'), /作りました/);
  assert.throws(() => applyFolderForm(dir, 'do=create&name='), /名前/);
  assert.throws(() => applyFolderForm(dir, 'do=create&name=%E3%82%B7%E3%83%A7%E3%83%BC%E3%83%88'), /同じ名前/);
  let st = readFolders(dir);
  const f = st.folders[0];
  assert.equal(f.name, 'ショート');
  assert.equal(f.hide, true);
  assert.equal(f.rule, 'short');
  assert.ok(st.autoSince, 'rule を書いたら自動の振り分けが始まる');
  assert.equal(assignPosts(dir, ['1000000000000000001', '../x'], f.id), 1);
  assert.equal(readFolders(dir).assign['1000000000000000001'].by, 'manual');
  applyFolderForm(dir, `do=update&id=${f.id}&name=%E5%8B%95%E7%94%BB`);
  st = readFolders(dir);
  assert.equal(st.folders[0].name, '動画');
  assert.equal(st.folders[0].hide, false);
  assert.equal(st.folders[0].rule, null);
  applyFolderForm(dir, `do=delete&id=${f.id}`);
  st = readFolders(dir);
  assert.equal(st.folders.length, 0);
  assert.deepEqual(st.assign, {});
  assert.deepEqual(parseAssignForm('ids=1+2&folder=evil&back=//x', '/tw'), { ids: ['1', '2'], folder: '', back: '/tw/' });
});

test('一覧に出さないフォルダの投稿は一覧から外れ、フォルダのタブとカードのメニューが出る', () => {
  const { dir, mk } = library();
  mk('1000000000000000011', 'ショート');
  mk('1000000000000000012', '残る<b>');
  applyFolderForm(dir, 'do=create&name=Short&hide=1');
  const f = readFolders(dir).folders[0];
  assignPosts(dir, ['1000000000000000011'], f.id);
  const lib = new Library(dir, { ttlMs: 0 }).refresh();
  assert.equal(lib.hiddenByFolder(lib.get('1000000000000000011')), true);
  assert.equal(lib.hiddenByFolder(lib.get('1000000000000000012')), false);
  const html = listPage('/tw', { posts: lib.posts, total: 2, q: '', noteOnly: false, back: '/tw/', page: 1, pages: 1, lib });
  assert.ok(html.includes(`class="tab folder" href="/tw/?folder=${f.id}"`));
  assert.ok(html.includes(`<option value="${f.id}" selected>Short</option>`));
  assert.match(html, /badge folder">Short</);
  assert.match(foldersPage('/tw', lib), /フォルダの管理[\s\S]*Short[\s\S]*一覧に出さない/);
});

test('動画の長さと画像の枚数を Jev に渡す文にする', () => {
  const lib = { videoDurationMs: (_id, name) => (name === '1' ? 42_000 : null) };
  assert.equal(mediaLine({ id: '1', media: [{ type: 'video' }, { type: 'animated_gif' }, { type: 'photo' }, { type: 'photo' }] }, lib), '[動画 0:42] [GIF] [画像 2枚]');
  assert.equal(mediaLine({ id: '1', media: [] }, lib), '');
});

test('自動の振り分け: 新しい投稿だけを1回ずつ判定し、70% 以上のいちばん近いフォルダに入れる。手で入れたものは動かさない', async () => {
  const { dir, mk } = library();
  const asked = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const j = JSON.parse(b);
      asked.push({ q: j.question, ids: j.items.map((i) => i.id) });
      const scores = {};
      for (const it of j.items) scores[it.id] = j.question.includes('SHORT') && it.text.includes('[動画') ? 0.9 : j.question.includes('NEWS') && it.text.includes('ニュース') ? 0.6 : 0.1;
      res.end(JSON.stringify({ scores, tokens: 1 }));
    });
  });
  await new Promise((r) => server.listen(process.env.JEV_SOCKET, r));
  try {
    applyFolderForm(dir, 'do=create&name=Short&hide=1&rule=SHORT', new Date('2026-11-08T00:00:00Z'));
    applyFolderForm(dir, 'do=create&name=News&rule=NEWS', new Date('2026-11-08T00:00:00Z'));
    const [short] = readFolders(dir).folders;
    mk('1000000000000000021', '動画です', { media: [{ type: 'video', file: null }] });
    mk('1000000000000000022', 'ニュース');
    mk('1000000000000000023', '手で入れた', { media: [{ type: 'video', file: null }] });
    assignPosts(dir, ['1000000000000000023'], short.id);
    const lib = new Library(dir, { ttlMs: 0 }).refresh();
    assert.equal(pendingPosts(lib).length, 2);
    const quiet = { log() {}, error() {} };
    assert.deepEqual(await runAutoSort(lib, dir, quiet), { judged: 2, assigned: 1 });
    const st = readFolders(dir);
    assert.equal(st.assign['1000000000000000021'].folder, short.id);
    assert.equal(st.assign['1000000000000000021'].by, 'jev');
    assert.equal(st.assign['1000000000000000022'], undefined, '60% では入れない');
    assert.equal(st.assign['1000000000000000023'].by, 'manual');
    assert.equal(asked.length, 2);
    assert.ok(asked.every((a) => !a.ids.includes('1000000000000000023')));
    // 2回目は判定済みなので何もしない
    assert.equal(await runAutoSort(lib.refresh(), dir, quiet), null);
    assert.equal(asked.length, 2);
  } finally {
    server.close();
  }
});

// 長さだけが入った小さな mp4（ftyp と moov/mvhd だけ）
function tinyMp4(ms) {
  const box = (type, body) => Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from(type, 'latin1'), body]).fill(0, 0, 0);
  const sized = (b) => (b.writeUInt32BE(b.length, 0), b);
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(ms, 16);
  return Buffer.concat([sized(box('ftyp', Buffer.from('isom0000', 'latin1'))), sized(box('moov', sized(box('mvhd', mvhd))))]);
}

test('mp4 の長さを読む（壊れたものは null）', async () => {
  const { mp4DurationMs } = await import('../lib/mp4.js');
  const f = path.join(tmp, 'a.mp4');
  fs.writeFileSync(f, tinyMp4(26_000));
  assert.equal(mp4DurationMs(f), 26_000);
  fs.writeFileSync(f, Buffer.from('not an mp4 at all'));
  assert.equal(mp4DurationMs(f), null);
});

test('動画の長さの条件を満たした投稿だけを Jev に渡し、50% で入れる。届かなかったものは惜しかった投稿に残り、条件を変えると判定し直す', async () => {
  const { dir, mk } = library();
  const asked = [];
  // 中継係の場所は読み込んだときに決まるので、前のテストと同じソケットで受け直す
  const sock = process.env.JEV_SOCKET;
  fs.rmSync(sock, { force: true });
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const j = JSON.parse(b);
      asked.push(j.items.map((i) => i.id));
      const scores = Object.fromEntries(j.items.map((it) => [it.id, it.text.includes('意味なし') ? 0.55 : 0.3]));
      res.end(JSON.stringify({ scores, tokens: 1 }));
    });
  });
  await new Promise((r) => server.listen(sock, r));
  try {
    const short = '1000000000000000031';
    const long = '1000000000000000032';
    const meh = '1000000000000000033';
    for (const [id, ms, text] of [[short, 26_000, '意味なし'], [long, 120_000, '意味なし'], [meh, 30_000, 'ふつう']]) {
      mk(id, text, { media: [{ type: 'video', file: null }] });
      fs.mkdirSync(path.join(dir, 'media', id), { recursive: true });
      fs.writeFileSync(path.join(dir, 'media', id, '1.mp4'), tinyMp4(ms));
    }
    applyFolderForm(dir, 'do=create&name=Short&hide=1&rule=R&maxsec=60', new Date('2026-11-08T00:00:00Z'));
    const lib = new Library(dir, { ttlMs: 0 }).refresh();
    const quiet = { log() {}, error() {} };
    await runAutoSort(lib, dir, quiet);
    const st = readFolders(dir);
    assert.deepEqual(asked.map((a) => a.sort()), [[short, meh]], '2分の動画は Jev に渡さない');
    assert.equal(st.assign[short]?.by, 'jev');
    assert.equal(st.assign[long], undefined);
    assert.equal(st.near[meh]?.p, 0.3);
    assert.match(foldersPage('/tw', lib.refresh()), /惜しかった投稿 1 件[\s\S]*30%/);
    assert.match(foldersPage('/tw', lib.refresh()), /最近 Jev が入れた投稿 1 件[\s\S]*55%[\s\S]*出す/);

    // 説明を変えると、まだ入っていない投稿を判定し直す（入っている投稿はそのまま）
    const f = st.folders[0];
    assert.match(applyFolderForm(dir, `do=update&id=${f.id}&name=Short&hide=1&rule=R2&maxsec=60`), /判定し直します/);
    const st2 = readFolders(dir);
    assert.equal(st2.judged[meh], undefined);
    assert.ok(st2.judged[short]);
    assert.deepEqual(st2.near, {});
    // 説明が無くても、長さの条件だけで入れられる
    applyFolderForm(dir, `do=update&id=${f.id}&name=Short&hide=1&rule=&maxsec=60`);
    asked.length = 0;
    await runAutoSort(lib.refresh(), dir, quiet);
    assert.equal(asked.length, 0);
    assert.equal(readFolders(dir).assign[meh]?.folder, f.id);
  } finally {
    server.close();
  }
});
