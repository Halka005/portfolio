// ヒアリングのページの画面の処理。入力はこのページの中だけで扱い、どこにも送らない。
(function () {
  'use strict';
  const lib = window.HearingLib;
  const page = document.querySelector('[data-job]');
  if (!lib || !page) return;
  const jobType = page.getAttribute('data-job');
  const qs = lib.questions(jobType);
  const box = (key) => document.querySelector('[data-q="' + key + '"]');

  // ---------- 行を足せる一覧 ----------
  function renumber(list) {
    list.querySelectorAll('.row').forEach((r, i) => { r.querySelector('.n').textContent = String(i + 1).padStart(2, '0'); });
  }
  function addRow(list, name) {
    const tpl = list.parentNode.querySelector('template');
    const row = tpl.content.firstElementChild.cloneNode(true);
    row.querySelector('[data-part="name"]').value = name || '';
    row.querySelector('.del').addEventListener('click', () => { row.remove(); renumber(list); });
    list.appendChild(row);
    renumber(list);
    return row;
  }
  document.querySelectorAll('.rows').forEach((list) => {
    let initial = [];
    try { initial = JSON.parse(list.getAttribute('data-initial') || '[]'); } catch (e) { initial = []; }
    initial.forEach((n) => addRow(list, n));
    const add = list.parentNode.querySelector('.add');
    add.addEventListener('click', () => { addRow(list, '').querySelector('[data-part="name"]').focus(); });
  });

  // ---------- 質問名をまとめて貼って行にする ----------
  const paste = document.getElementById('paste');
  const pasteBtn = document.getElementById('paste-rows');
  if (paste && pasteBtn) {
    const pasted = document.getElementById('pasted');
    pasteBtn.addEventListener('click', () => {
      const list = pasteBtn.closest('[data-q]').querySelector('.rows');
      const names = lib.parseQuestionLines(paste.value);
      if (names.length === 0) { pasted.textContent = '貼られた質問名がありません'; return; }
      // 空の行は置き換え、入力のある行は残してその後ろに足す（同じ名前は足さない）
      const kept = [];
      list.querySelectorAll('.row').forEach((r) => {
        const v = r.querySelector('[data-part="name"]').value.trim();
        if (v === '') r.remove(); else kept.push(v);
      });
      const added = names.filter((n) => !kept.includes(n));
      added.forEach((n) => addRow(list, n));
      renumber(list);
      paste.value = '';
      pasted.textContent = added.length + ' 件を行にしました';
      const q = list.closest('[data-q]');
      if (q) q.classList.remove('is-missing');
    });
  }

  // ---------- 入力を集める ----------
  function collect() {
    const a = {};
    for (const q of qs) {
      const el = box(q.key);
      if (!el) continue;
      if (q.type === 'choice') {
        const c = el.querySelector('input[type="radio"]:checked');
        a[q.key] = c ? c.value : '';
      } else if (q.type === 'checks') {
        a[q.key] = Array.from(el.querySelectorAll('input[type="checkbox"]:checked')).map((c) => c.value);
      } else if (q.type === 'rows') {
        a[q.key] = Array.from(el.querySelectorAll('.row')).map((r) => {
          const kind = r.querySelector('[data-part="kind"]');
          return { name: r.querySelector('[data-part="name"]').value, kind: kind ? kind.value : '' };
        });
      } else {
        const input = el.querySelector('input, textarea');
        a[q.key] = input ? input.value : '';
      }
    }
    return a;
  }

  function refresh() {
    const a = collect();
    for (const q of qs) {
      const el = box(q.key);
      if (el) el.hidden = !lib.isVisible(jobType, q.key, a);
    }
    // 出ている質問だけで番号を振り直す
    let n = 0;
    document.querySelectorAll('.q').forEach((el) => {
      const no = el.querySelector('.no');
      if (no && !el.hidden) no.textContent = String(++n).padStart(2, '0');
    });
  }
  document.addEventListener('input', (e) => {
    const q = e.target.closest('[data-q]');
    if (q) q.classList.remove('is-missing');
    refresh();
  });
  document.addEventListener('change', refresh);
  refresh();

  // ---------- 文章を作る・コピー ----------
  const out = document.getElementById('out');
  const missingMsg = document.getElementById('missing');
  const warnMsg = document.getElementById('warnings');
  const copied = document.getElementById('copied');

  function list(title, items) {
    const frag = document.createDocumentFragment();
    const p = document.createElement('div');
    p.textContent = title;
    frag.appendChild(p);
    const ul = document.createElement('ul');
    items.forEach((t) => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
    frag.appendChild(ul);
    return frag;
  }

  document.getElementById('build').addEventListener('click', () => {
    const a = collect();
    const r = lib.buildSummary(jobType, a);
    missingMsg.replaceChildren();
    warnMsg.replaceChildren();
    copied.textContent = '';
    document.querySelectorAll('.is-missing').forEach((el) => el.classList.remove('is-missing'));
    if (!r.ok) {
      missingMsg.appendChild(list('まだ答えていない欄があります。', r.missing));
      const labels = new Set(r.missing);
      let first = null;
      for (const q of qs) {
        const bad = labels.has(q.label) || (q.type === 'url' && labels.has(lib.FORM_URL_INVALID));
        if (!bad) continue;
        const el = box(q.key);
        if (el) { el.classList.add('is-missing'); if (!first) first = el; }
      }
      out.value = '';
      if (first) first.scrollIntoView({ block: 'start' });
      return;
    }
    if (r.warnings.length) warnMsg.appendChild(list('送る前に確かめてください（文章はできています）。', r.warnings));
    out.value = r.text;
  });

  document.getElementById('copy').addEventListener('click', () => {
    if (out.value === '') return;
    const selectOnly = () => { out.focus(); out.select(); copied.textContent = '選択しました。コピーして貼ってください'; };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(out.value)
        .then(() => { copied.textContent = 'コピーしました'; })
        .catch(selectOnly);
    } else {
      selectOnly();
    }
  });
})();
