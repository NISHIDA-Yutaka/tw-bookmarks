// tw-bookmarks: X のブックマークを書き出す（PC のブラウザで x.com のコンソールに貼って使う）
//
// 何をするか:
//   x.com の画面が X から受け取る「ブックマーク一覧」のデータを横で記録し、最後に JSON ファイルとして保存する。
//   どこにも送信しない。拡張機能も要らない。タブを再読み込みすれば元に戻る。
//
// 使い方は README.md の「過去分の取り込み」を参照。
(() => {
  if (window.__twExport) {
    window.__twExport.show();
    return;
  }
  const MATCH = /\/graphql\/[^/?]+\/Bookmarks(\?|$)/;
  const records = [];
  const ids = new Set();

  function findInstructions(o, depth = 0) {
    if (!o || typeof o !== 'object' || depth > 8) return null;
    if (Array.isArray(o.instructions)) return o.instructions;
    for (const v of Object.values(o)) {
      const found = findInstructions(v, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function collect(json) {
    let added = 0;
    for (const ins of findInstructions(json) || []) {
      const entries = ins.entries || (ins.entry ? [ins.entry] : []);
      for (const e of entries) {
        if (!String(e.entryId || '').startsWith('tweet-')) continue;
        const r = e.content && e.content.itemContent && e.content.itemContent.tweet_results && e.content.itemContent.tweet_results.result;
        if (!r) continue;
        const t = r.__typename === 'TweetWithVisibilityResults' ? r.tweet : r;
        const id = t && t.rest_id;
        if (!id || ids.has(id)) continue;
        ids.add(id);
        records.push({ id, metadata: r });
        added++;
      }
    }
    update();
    return added;
  }

  // X の画面が使う通信（XMLHttpRequest と fetch）の結果を横から読む。送る内容は変えない
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (MATCH.test(String(url))) {
      this.addEventListener('load', () => {
        try {
          collect(this.responseType === 'json' ? this.response : JSON.parse(this.responseText));
        } catch (err) {
          console.warn('[tw-bookmarks] 読めない応答がありました', err);
        }
      });
    }
    return origOpen.apply(this, arguments);
  };
  const origFetch = window.fetch;
  window.fetch = function (input) {
    const p = origFetch.apply(this, arguments);
    const url = typeof input === 'string' ? input : input && input.url;
    if (MATCH.test(String(url))) {
      p.then((res) => res.clone().json().then(collect)).catch(() => {});
    }
    return p;
  };

  // 画面右上の小さな操作パネル
  const panel = document.createElement('div');
  Object.assign(panel.style, {
    position: 'fixed', top: '12px', right: '12px', zIndex: '2147483647', background: '#ffffff', color: '#111111',
    border: '2px solid #2563a8', borderRadius: '10px', padding: '10px 12px', font: '14px/1.5 system-ui, sans-serif',
    boxShadow: '0 4px 16px rgba(0,0,0,.2)', maxWidth: '280px',
  });
  const title = document.createElement('div');
  title.textContent = 'ブックマーク書き出し';
  title.style.fontWeight = '700';
  const count = document.createElement('div');
  const hint = document.createElement('div');
  hint.style.fontSize = '12px';
  hint.style.color = '#555555';
  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' });
  const button = (label, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    Object.assign(b.style, { font: 'inherit', padding: '3px 10px', borderRadius: '6px', border: '1px solid #999999', background: '#f4f4f4', color: '#111111', cursor: 'pointer' });
    b.addEventListener('click', onClick);
    row.appendChild(b);
    return b;
  };

  let timer = null;
  let idleTicks = 0;
  let lastCount = 0;
  const scrollBtn = button('自動スクロール', () => (timer ? stopScroll('止めました') : startScroll()));
  button('保存', save);
  button('閉じる', () => {
    stopScroll('');
    panel.remove();
  });
  panel.append(title, count, hint, row);
  document.body.appendChild(panel);

  function update(msg) {
    count.textContent = `取得 ${records.length} 件`;
    if (msg !== undefined) hint.textContent = msg;
  }

  function startScroll() {
    scrollBtn.textContent = '止める';
    idleTicks = 0;
    lastCount = records.length;
    update('下へ送っています…（増えなくなったら自動で止まります）');
    timer = setInterval(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      if (records.length > lastCount) {
        lastCount = records.length;
        idleTicks = 0;
      } else if (++idleTicks >= 10) {
        stopScroll('増えなくなりました。一番下まで来たら「保存」を押してください。');
      }
    }, 2500);
  }

  function stopScroll(msg) {
    clearInterval(timer);
    timer = null;
    scrollBtn.textContent = '自動スクロール';
    update(msg);
  }

  function save() {
    if (!records.length) {
      update('まだ1件も取れていません。左のメニューから「ブックマーク」を開いてください。');
      return;
    }
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const blob = new Blob([JSON.stringify(records)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tw-bookmarks-export-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    update(`${records.length} 件を保存しました。終わったらこのタブを再読み込みしてください。`);
  }

  window.__twExport = { collect, records, show: () => document.body.appendChild(panel) };
  update('準備できました。左のメニューから「ブックマーク」を開いてください。');
})();
