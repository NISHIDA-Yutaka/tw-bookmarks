#!/usr/bin/env node
// X に「このアプリがブックマークを読んでよい」と許可する（最初の1回と、認証が切れたとき）。
// 管理者が `sudo tw-fetch-login` で実行する。中身は取り込みと同じ tw-fetch ユーザー・同じ囲いの中で動く。
//
//   1. 表示された URL を PC のブラウザで開き、X で「許可する」を押す
//   2. 移った先のページは「接続できません」になるが、それでよい。アドレス欄の内容をまるごとコピーする
//   3. この画面に貼って Enter（チャットには貼らない）
//
// 受け取った更新用トークンは tw-fetch だけが読めるファイルに保存し、画面にもログにも出さない。

import readline from 'node:readline/promises';
import { startAuthorization, parseCallback, exchangeCode, getMe } from '../lib/twapi.js';
import { saveToken, TOKEN_DIR } from '../lib/token-store.js';

const clientId = process.env.TW_CLIENT_ID;
if (!clientId) {
  console.error('Client ID が設定されていません。/etc/apps/tw-bookmarks.env に TW_CLIENT_ID=… を書いてください（sudoedit で）。');
  process.exit(1);
}
if (!process.stdin.isTTY) {
  console.error('対話で実行してください: sudo tw-fetch-login');
  process.exit(1);
}

const { url, verifier, state } = startAuthorization(clientId);
console.log('\n1. 次の URL を PC のブラウザで開き、X で「許可する」（Authorize app）を押してください。\n');
console.log(url);
console.log('\n2. 移った先のページは「接続できません」と出ますが、それで正常です。');
console.log('   そのページのアドレス欄（http://127.0.0.1/callback?state=…&code=… で始まる）をまるごとコピーしてください。\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pasted = await rl.question('3. ここに貼って Enter: ');
rl.close();

try {
  const code = parseCallback(pasted, state);
  const { accessToken, refreshToken } = await exchangeCode(clientId, code, verifier);
  const me = await getMe(accessToken);
  saveToken({ user_id: me.id, username: me.username, refresh_token: refreshToken, saved_at: new Date().toISOString() });
  console.log(`\n許可を保存しました（@${me.username ?? me.id}）。保存先: ${TOKEN_DIR}（tw-fetch だけが読めます）`);
  console.log('試しに取り込むには: sudo systemctl start tw-fetch.service');
} catch (err) {
  console.error(`\n失敗しました: ${err.message}`);
  process.exit(1);
}
