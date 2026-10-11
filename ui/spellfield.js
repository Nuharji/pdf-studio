/* Spelling & grammar for a text field (textarea): checked in Rust (spell.rs), drawn as wavy underlines on a
   transparent copy of the text that lies exactly over the field. Right-click an underline for suggestions.
   SpellField.attach(textarea, {lang: () => 'auto'|'de'|'en'|'off', fallback: () => 'de'|'en', ignored: Set})
   SpellField.menu(event, t) -> Promise of context-menu items, or null when no issue is under the mouse
   SpellField.action(id) applies a chosen item (ids start with "spf:"). */
(() => {
  'use strict';
  const invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : null;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const fields = new WeakMap();
  let ctx = null;   // {st, issue, text, fixes}

  function attach(ta, opts) {
    const marks = document.createElement('div');
    marks.className = 'spell-marks'; marks.setAttribute('aria-hidden', 'true');
    ta.after(marks);
    const st = {ta, marks, opts, issues: [], seq: 0, timer: 0, ignored: opts.ignored || new Set()};
    fields.set(ta, st);
    const draw = () => {
      if (!ta.isConnected) return marks.remove();
      if (!st.issues.length) { marks.textContent = ''; return; }
      const cs = getComputedStyle(ta);
      Object.assign(marks.style, {left: ta.offsetLeft + ta.clientLeft + 'px', top: ta.offsetTop + ta.clientTop + 'px',
        width: ta.clientWidth + 'px', height: ta.clientHeight + 'px', padding: cs.padding, font: cs.font, lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing, whiteSpace: 'pre-wrap', overflowWrap: cs.overflowWrap, wordBreak: cs.wordBreak});
      const v = ta.value;
      let h = '', at = 0;
      st.issues.forEach((i, k) => {
        if (i.start < at) return;
        h += esc(v.slice(at, i.start)) + `<mark class="${i.kind === 'spell' ? 'sp' : 'gr'}" data-k="${k}">${esc(v.slice(i.start, i.end))}</mark>`;
        at = i.end;
      });
      marks.innerHTML = h + esc(v.slice(at)) + '\n';
      marks.scrollTop = ta.scrollTop;
    };
    const run = async () => {
      const text = ta.value, my = ++st.seq, lang = opts.lang();
      let list = [];
      if (invoke && lang !== 'off' && text.trim()) list = await invoke('spell_check', {text, lang, fallback: opts.fallback()}).catch(() => []);
      if (my !== st.seq || text !== ta.value) return;
      st.issues = list.filter(i => !st.ignored.has(i.kind + ':' + text.slice(i.start, i.end)));
      draw();
    };
    ta.addEventListener('input', () => { st.issues = []; draw(); clearTimeout(st.timer); st.timer = setTimeout(run, 500); });
    ta.addEventListener('scroll', () => { marks.scrollTop = ta.scrollTop; });
    new ResizeObserver(draw).observe(ta);
    st.run = run; st.draw = draw;
    run();
    return st;
  }

  /* Context-menu items for the issue under the mouse, or null. */
  function menu(e, t) {
    const st = fields.get(e.target);
    if (!st || !st.issues.length) return null;
    let issue = null;
    for (const m of st.marks.querySelectorAll('mark')) {
      for (const r of m.getClientRects()) if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 2 && e.clientY <= r.bottom + 2) issue = st.issues[+m.dataset.k];
    }
    if (!issue) return null;
    const text = st.ta.value.slice(issue.start, issue.end);
    ctx = {st, issue, text, fixes: issue.fix};
    if (issue.kind !== 'spell') {
      return Promise.resolve([{id: 'spf:rule', label: t('sp.rule.' + issue.kind), enabled: false},
        ...issue.fix.map((s, k) => ({id: 'spf:fix:' + k, label: t('sp.fix.' + issue.kind, {s})})), null, {id: 'spf:ignore', label: t('sp.ignore')}]);
    }
    return invoke('spell_suggest', {word: text, lang: st.opts.lang()}).catch(() => []).then(sug => {
      ctx.fixes = sug;
      return [...(sug.length ? sug.map((s, k) => ({id: 'spf:fix:' + k, label: s})) : [{id: 'spf:none', label: t('sp.noSuggestions'), enabled: false}]),
        null, {id: 'spf:add', label: t('sp.add', {w: text})}, {id: 'spf:ignore', label: t('sp.ignore')}];
    });
  }

  async function action(id) {
    if (!ctx) return;
    const {st, issue, text} = ctx, ta = st.ta;
    if (!ta.isConnected || ta.value.slice(issue.start, issue.end) !== text) return;
    if (id.startsWith('spf:fix:')) {
      ta.focus(); ta.setSelectionRange(issue.start, issue.end);
      const fix = ctx.fixes[+id.slice(8)];
      // insertText keeps Ctrl+Z working
      if (!document.execCommand('insertText', false, fix)) { ta.setRangeText(fix, issue.start, issue.end, 'end'); ta.dispatchEvent(new Event('input')); }
    } else if (id === 'spf:add') {
      await invoke('spell_add', {word: text}).catch(() => {});
      st.run();
    } else if (id === 'spf:ignore') {
      st.ignored.add(issue.kind + ':' + text);
      st.issues = st.issues.filter(i => !(i.kind === issue.kind && ta.value.slice(i.start, i.end) === text));
      st.draw();
    }
    ta.focus();
  }

  window.SpellField = {attach, menu, action};
})();
