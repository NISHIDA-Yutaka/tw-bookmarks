// ID のコピーと、複数選択（まとめてコピー・まとめてアーカイブ）。選択はページをまたいで覚えておく（このタブの中だけ）。
// 一覧はスクロールで続きを足す。アーカイブの操作で同じページに戻ってきたときと、詳細から「← 一覧へ」で戻ったときは、元のスクロール位置に戻す。
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

  // スレッドは1つの選択に複数の ID が入っている
  const pickedCount = () => new Set(picked.join(' ').split(' ').filter(Boolean)).size;

  function render() {
    document.querySelectorAll('.pickbox').forEach((box) => {
      box.checked = picked.includes(box.value);
    });
    $('pickcount').textContent = String(pickedCount());
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
    if (btn.classList.contains('copytext')) {
      toast((await copy(btn.dataset.text)) ? '本文をコピーしました' : 'コピーできませんでした');
    } else if (btn.classList.contains('copyid')) {
      const n = btn.dataset.id.split(' ').length;
      toast((await copy(btn.dataset.id)) ? `${n > 1 ? `${n} 件の ID` : `ID ${btn.dataset.id}`} をコピーしました` : 'コピーできませんでした');
    } else if (btn.id === 'pickcopy') {
      const ok = await copy(picked.join(' '));
      toast(ok ? `${pickedCount()} 件の ID をコピーしました` : 'コピーできませんでした');
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

  // フォルダのメニューは選んだらすぐ移す（「移す」ボタンはスクリプトが動かないとき用なので隠す）
  document.documentElement.classList.add('js');
  document.addEventListener('change', (e) => {
    const sel = e.target;
    if (sel.matches && sel.matches('.folderform select')) sel.form.requestSubmit();
    if (sel.id === 'pickfolder' && sel.value) {
      const form = $('pickfolderform');
      form.elements.ids.value = picked.join(' ');
      form.elements.folder.value = sel.value === 'none' ? '' : sel.value;
      form.elements.back.value = here();
      rememberScroll(form.elements.back.value);
      picked = [];
      save(picked);
      form.submit();
    }
  });

  // 消すなど取り消せない操作は確かめる
  document.addEventListener('submit', (e) => {
    const msg = e.target.dataset && e.target.dataset.confirm;
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  document.addEventListener('submit', (e) => {
    const back = e.target.elements && e.target.elements.back;
    if (!back) return;
    // スクロールで足した分も含めて戻れるよう、今の URL を戻り先にする
    back.value = here();
    rememberScroll(back.value);
  });

  window.addEventListener('pageshow', () => {
    picked = load();
    render();
  });
  // 関連する投稿: まず言葉の重なりで選んだものを出し、Jev の判定が届いたら差し替える
  const related = document.getElementById('related');
  if (related && related.dataset.src) {
    fetch(related.dataset.src, { credentials: 'same-origin' })
      .then((r) => r.text())
      .then((html) => {
        related.innerHTML = html;
      })
      .catch(() => {
        const wait = related.querySelector('.rel-wait');
        if (wait) wait.textContent = '（Jev の判定は取れませんでした）';
      });
  }

  // Jev で探すのは数秒かかるので、押したことが分かるようにする
  document.addEventListener('submit', (e) => {
    const btn = e.submitter;
    if (btn && btn.classList.contains('jev')) {
      btn.textContent = 'Jev で探しています…';
      setTimeout(() => (btn.disabled = true), 0);
    }
  });

  // 一覧の続き: 下に近づいたら次のカードを足す。URL の page も進めるので、再読み込みや戻ったときも同じところまで見える
  const more = document.getElementById('more');
  const cards = document.querySelector('.cards');
  if (more && cards && 'IntersectionObserver' in window) {
    let next = Number(more.dataset.next);
    const last = Number(more.dataset.pages);
    let busy = false;
    const pageUrl = (n, part) => {
      const u = new URL(location.href);
      u.searchParams.set('page', String(n));
      if (part) u.searchParams.set('part', '1');
      return u.pathname + u.search;
    };
    const io = new IntersectionObserver(
      async (entries) => {
        if (busy || !entries.some((e) => e.isIntersecting)) return;
        busy = true;
        io.unobserve(more);
        try {
          const r = await fetch(pageUrl(next, true), { credentials: 'same-origin' });
          if (!r.ok) throw new Error(String(r.status));
          cards.insertAdjacentHTML('beforeend', await r.text());
          history.replaceState(history.state, '', pageUrl(next, false));
          render();
          next++;
          if (next > last) more.remove();
          else {
            more.querySelector('a').href = pageUrl(next, false);
            io.observe(more);
          }
        } catch {
          // 取れなければ自動で足すのをやめる。「もっと見る」のリンクは残る
        }
        busy = false;
      },
      { rootMargin: '1000px 0px' },
    );
    io.observe(more);
  }

  // 検索欄を空にしたら（× ボタンや全部消したとき）、少し待ってから検索する前の一覧に戻る。続けて打ち直したら戻らない
  const searchBox = document.querySelector('form.search input[name="q"]');
  if (searchBox && new URLSearchParams(location.search).get('q')) {
    let timer = null;
    const backToList = () => {
      const u = new URL(searchBox.form.action, location.href);
      new FormData(searchBox.form).forEach((v, k) => {
        if (k !== 'q' && k !== 'mode' && v) u.searchParams.set(k, String(v));
      });
      location.assign(u.pathname + u.search);
    };
    searchBox.addEventListener('input', () => {
      clearTimeout(timer);
      if (!searchBox.value.trim()) timer = setTimeout(backToList, 700);
    });
  }

  // 一覧の画像を押したら、ページを移らずに大きく開く。同じ投稿の画像は ← → やスワイプで切り替える
  let viewer = null;
  const openViewer = (links, index) => {
    if (!viewer) {
      viewer = document.createElement('dialog');
      viewer.className = 'viewer';
      viewer.innerHTML =
        '<button type="button" class="v-close" aria-label="閉じる">×</button>' +
        '<button type="button" class="v-prev" aria-label="前の画像">‹</button>' +
        '<figure><img alt=""><figcaption></figcaption></figure>' +
        '<button type="button" class="v-next" aria-label="次の画像">›</button>' +
        '<p class="v-count"></p>';
      document.body.appendChild(viewer);
      const img = viewer.querySelector('img');
      const step = (d) => {
        const n = viewer.links.length;
        viewer.index = (viewer.index + d + n) % n;
        show();
      };
      const show = () => {
        const a = viewer.links[viewer.index];
        const alt = a.querySelector('img')?.alt || '';
        img.src = a.getAttribute('href');
        img.alt = alt;
        viewer.querySelector('figcaption').textContent = alt;
        const many = viewer.links.length > 1;
        viewer.classList.toggle('many', many);
        viewer.querySelector('.v-count').textContent = many ? `${viewer.index + 1} / ${viewer.links.length}` : '';
      };
      viewer.show = show;
      viewer.querySelector('.v-close').addEventListener('click', () => viewer.close());
      viewer.querySelector('.v-prev').addEventListener('click', () => step(-1));
      viewer.querySelector('.v-next').addEventListener('click', () => step(1));
      // 画像の外（暗いところ）を押したら閉じる
      viewer.addEventListener('click', (e) => {
        if (e.target === viewer || e.target.tagName === 'FIGURE') viewer.close();
      });
      viewer.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') step(-1);
        if (e.key === 'ArrowRight') step(1);
      });
      let startX = null;
      viewer.addEventListener('touchstart', (e) => (startX = e.touches[0].clientX), { passive: true });
      viewer.addEventListener('touchend', (e) => {
        if (startX === null || viewer.links.length < 2) return;
        const dx = e.changedTouches[0].clientX - startX;
        startX = null;
        if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
      });
      viewer.addEventListener('close', () => {
        document.documentElement.classList.remove('viewer-open');
        img.removeAttribute('src');
      });
    }
    viewer.links = links;
    viewer.index = index;
    viewer.show();
    document.documentElement.classList.add('viewer-open');
    viewer.showModal();
  };
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('.thumbs a.zoom');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || typeof HTMLDialogElement !== 'function') return;
    e.preventDefault();
    const links = [...a.closest('.thumbs').querySelectorAll('a.zoom')];
    openViewer(links, links.indexOf(a));
  });

  // 動画は同時に1本だけ流す（一覧で次の動画を再生したら、前のものは止める）
  document.addEventListener(
    'play',
    (e) => {
      if (e.target.tagName !== 'VIDEO') return;
      document.querySelectorAll('video').forEach((v) => {
        if (v !== e.target && !v.paused) v.pause();
      });
    },
    true,
  );

  render();
  restoreScroll();
})();
