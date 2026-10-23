// ID のコピーと、複数選択。選択はページをまたいで覚えておく（このタブの中だけ）。
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
    } else if (btn.id === 'pickclear') {
      picked = [];
      save(picked);
      render();
    }
  });

  window.addEventListener('pageshow', () => {
    picked = load();
    render();
  });
  render();
})();
