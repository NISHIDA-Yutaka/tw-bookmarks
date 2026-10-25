// ID のコピーと、複数選択（まとめてコピー・まとめてアーカイブ）。選択はページをまたいで覚えておく（このタブの中だけ）。
// アーカイブの操作で同じページに戻ってきたときと、詳細から「← 一覧へ」で戻ったときは、元のスクロール位置に戻す。
(() => {
  const KEY = 'tw-picked';
  const load = () => {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) || '[]');
    } catch {
      return [];
    }
  };
  const save = (ids) => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(ids));
    } catch {
      // 保存できない環境では、このページの中だけで覚える
    }
  };
  let picked = load();

  // 操作の前に「戻り先のページ」と位置を覚え、戻ってきたページが同じならそこへスクロールする
  const SCROLL_KEY = 'tw-scroll';
  const here = () => location.pathname + location.search;
  const rememberScroll = (back, y = window.scrollY) => {
    try {
      sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ back, y: Math.round(y) }));
    } catch {
      // 覚えられない環境では先頭に戻るだけ
    }
  };
  const restoreScroll = () => {
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || 'null');
      sessionStorage.removeItem(SCROLL_KEY);
    } catch {
      return;
    }
    if (!saved || saved.back !== here() || !Number.isFinite(saved.y)) return;
    window.scrollTo(0, saved.y);
    // 画像が読み込まれて高さが変わっても、同じ位置にとどまる
    window.addEventListener('load', () => window.scrollTo(0, saved.y), { once: true });
  };

  // 一覧を離れるときに、その一覧（検索やタブも含む）と位置を覚える。詳細の「← 一覧へ」はそこへ戻す
  const LIST_KEY = 'tw-list';
  const isList = Boolean(document.querySelector('.cards'));
  const saveList = () => {
    if (!isList) return;
    try {
      sessionStorage.setItem(LIST_KEY, JSON.stringify({ url: here(), y: Math.round(window.scrollY) }));
    } catch {
      // 覚えられない環境では一覧の先頭に戻るだけ
    }
  };
  const savedList = () => {
    try {
      const v = JSON.parse(sessionStorage.getItem(LIST_KEY) || 'null');
      // 自分のページで覚えたものだけ使う（ほかのサイトへは飛ばない）
      if (v && typeof v.url === 'string' && v.url.startsWith('/') && !v.url.startsWith('//') && Number.isFinite(v.y)) return v;
    } catch {
      // 読めなければ使わない
    }
    return null;
  };
  window.addEventListener('pagehide', saveList);
  document.querySelectorAll('a.backlink').forEach((a) => {
    const list = savedList();
    if (!list) return;
    a.href = list.url;
    a.addEventListener('click', () => rememberScroll(list.url, list.y));
  });

  const $ = (id) => document.getElementById(id);
  let toastTimer;
  const toast = (msg) => {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 1800);
  };

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // https でない、許可がない等のときの予備の方法
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.className = 'offscreen';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }

  function render() {
    document.querySelectorAll('.pickbox').forEach((box) => {
      box.checked = picked.includes(box.value);
    });
    $('pickcount').textContent = String(picked.length);
    $('pickbar').hidden = picked.length === 0;
    document.body.classList.toggle('has-pickbar', picked.length > 0);
  }

  document.addEventListener('change', (e) => {
    const box = e.target;
    if (!box.classList || !box.classList.contains('pickbox')) return;
    picked = picked.filter((id) => id !== box.value);
    if (box.checked) picked.push(box.value);
    save(picked);
    render();
  });

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest && e.target.closest('button');
    if (!btn) return;
    if (btn.classList.contains('copyid')) {
      toast((await copy(btn.dataset.id)) ? `ID ${btn.dataset.id} をコピーしました` : 'コピーできませんでした');
    } else if (btn.id === 'pickcopy') {
      const ok = await copy(picked.join(' '));
      toast(ok ? `${picked.length} 件の ID をコピーしました` : 'コピーできませんでした');
    } else if (btn.id === 'pickarchive') {
      const form = $('pickform');
      form.elements.ids.value = picked.join(' ');
      form.elements.do.value = btn.dataset.do;
      form.elements.back.value = here();
      rememberScroll(form.elements.back.value);
      picked = [];
      save(picked);
      form.submit();
    } else if (btn.id === 'pickclear') {
      picked = [];
      save(picked);
      render();
    }
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.cards a')) saveList();
  });

  document.addEventListener('submit', (e) => {
    const back = e.target.elements && e.target.elements.back;
    if (back) rememberScroll(back.value);
  });

  window.addEventListener('pageshow', () => {
    picked = load();
    render();
  });
  render();
  restoreScroll();
})();
