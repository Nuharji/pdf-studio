import * as pdfjsLib from './vendor/pdfjs/pdf.min.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
const PDF_OPTS = {
  cMapUrl: new URL('./vendor/pdfjs/cmaps/', import.meta.url).href, cMapPacked: true,
  standardFontDataUrl: new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).href,
  isEvalSupported: false
};
const CSS_UNITS = 96 / 72;   // 100 % = real size on screen
const SVGNS = 'http://www.w3.org/2000/svg';
const STORE = 'pdf-studio.v1';

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const viewer = $('#viewer'), pagesEl = $('#pages'), thumbsEl = $('#thumbs'), dockBody = $('#dockBody');
// Native backend (Rust/Tauri). Null when the UI is opened directly in a browser.
const invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : null;
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ================= Translations ================= */
/* The texts (English / German) live in src-tauri/i18n/*.json and are loaded from Rust at start. */
let I18N = {en: {}, de: {}};
let lang = 'en';
function t(key, vars) {
  let s = I18N[lang][key] ?? I18N.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
  return s;
}
const fmtKey = k => lang === 'de' ? k.replace(/Ctrl/g, 'Strg').replace(/Shift/g, 'Umschalt').replace(/Delete/g, 'Entf') : k;
const fmtSize = b => b >= 1048576 ? (b / 1048576).toLocaleString(lang, {maximumFractionDigits: 1}) + ' MB'
  : Math.max(1, Math.round(b / 1024)).toLocaleString(lang) + ' KB';

/* ================= Settings & state ================= */
const THEMES = ['dark', 'light', 'github', 'github-dark'];
const COLORS = ['#FFD400', '#7CE38B', '#62B3FF', '#FF7AB6', '#E5384F', '#1F2328'];
const DEF = {keys: {}, autoHide: false, lang: 'auto', theme: 'dark', zoomMode: 'fit-width', invert: false, dock: true, dockTab: 'pages', reopen: true, color: '#FFD400', spell: 'auto',
  textColor: '#1F2328', textFont: 'helv', textSize: 14, textBold: false};
let settings = {...DEF}, recent = [], docs = [], active = -1, tool = 'select', booted = false, docSeq = 0, pageSeq = 0;
const cur = () => docs[active];
const effectiveLang = () => settings.lang === 'auto'
  ? ((navigator.language || 'en').toLowerCase().startsWith('de') ? 'de' : 'en') : settings.lang;

function saveState() {
  try {
    localStorage.setItem(STORE, JSON.stringify({settings, recent,
      open: docs.filter(d => d.path).map(d => d.path), active: cur() && cur().path}));
  } catch (e) {}
}

/* ================= File access (native or browser) ================= */
const enc = s => encodeURIComponent(s || '');
async function readPath(path, job = null) { return new Uint8Array(await invoke('read_file', {path, progress: job ? job.id : null})); }
async function writeBytes(bytes, {path = null, name, filter = 'PDF', ext = 'pdf', mime = 'application/pdf'}) {
  if (invoke) {
    return invoke('save_binary', bytes, {headers: {'x-path': enc(path), 'x-name': enc(name), 'x-filter': enc(filter), 'x-ext': enc(ext)}});
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], {type: mime}));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  return {path: null, name};
}
async function pickFiles() {
  if (invoke) return invoke('pick_pdfs');
  return new Promise(res => {
    const inp = $('#fileIn');
    inp.onchange = async () => {
      const out = [];
      for (const f of inp.files) out.push({name: f.name, size: f.size, path: null, bytes: new Uint8Array(await f.arrayBuffer())});
      inp.value = ''; res(out);
    };
    inp.click();
  });
}
const bytesOf = async (f, job) => f.bytes || readPath(f.path, job);

/* ================= Loading documents ================= */
function askPassword(name, wrong) {
  return new Promise(resolve => {
    modal(t('ui.password'), `<p>${esc(t(wrong ? 'ui.passwordWrong' : 'ui.passwordPrompt', {name}))}</p>
      <input type="password" class="field-in pw-in" id="pwIn">`, [
      {label: t('ui.cancel'), onClick: () => { closeModal(); resolve(null); }},
      {label: t('ui.open'), primary: true, onClick: () => { const v = $('#pwIn').value; closeModal(); resolve(v); }}
    ]);
    const inp = $('#pwIn'); inp.focus();
    inp.onkeydown = e => { if (e.key === 'Enter') { const v = inp.value; closeModal(); resolve(v); } };
  });
}
/* job: the loading bar (loadbar.js) — the steps open, pages and prepare fill it from 30 % on. */
async function loadPdf(bytes, name, job = null) {
  if (job) job.step(t('load.open'), .3, .4, {busy: true});
  const task = pdfjsLib.getDocument({...PDF_OPTS, data: bytes.slice()});
  let password = null;
  task.onPassword = async (update, reason) => {
    const pw = await askPassword(name, reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
    if (pw == null) task.destroy(); else { password = pw; update(pw); }
  };
  const pdf = await task.promise;
  const proxies = [];
  if (job) job.step(t('load.pages'), .4, .95);
  for (let i = 1; i <= pdf.numPages; i++) { proxies.push(await pdf.getPage(i)); if (job) job.set(i / pdf.numPages, `${i} / ${pdf.numPages}`); }
  if (job) job.step(t('load.prepare'), .95, 1, {busy: true});
  // Rust keeps a copy for building the saved file (pdfbuild.rs); the UI then only sends page lists.
  const rid = invoke ? await invoke('pdf_cache', bytes) : null;
  // Properties and bookmarks are read in Rust too (pdfinfo.rs); the password is only passed on, not kept.
  const info = rid ? await invoke('pdf_info', {id: rid, password}).catch(() => null) : null;
  return {bytes, pdf, proxies, encrypted: password != null, rid, info};
}
function pagesOf(src, srcIndex) {
  return src.proxies.map((p, index) => {
    const [x1, y1, x2, y2] = p.view;
    return {id: ++pageSeq, src: srcIndex, index, rot: 0, base: p.rotate, w: x2 - x1, h: y2 - y1};
  });
}
async function openFileInfo(f) {
  if (f.path) {
    const i = docs.findIndex(d => d.path === f.path);
    if (i >= 0) return activate(i);
  }
  let bytes, src;
  const job = window.LoadBar ? LoadBar.start(f.name) : null;
  try {
    if (job) job.step(t('load.read'), 0, .3);
    try { bytes = await bytesOf(f, job); } catch (e) { return toast(t('toast.missing', {name: f.name})); }
    try { src = await loadPdf(bytes, f.name, job); }
    catch (e) { if (!/destroy|abort/i.test(String(e && (e.name + e.message)))) toast(t('toast.openFail', {name: f.name, e: e.message || e})); return; }
  } finally { if (job) job.done(); }
  const d = {id: ++docSeq, name: f.name, path: f.path, size: f.size || bytes.length, sources: [src], pages: pagesOf(src, 0),
    annots: {}, dirty: false, history: [], future: [], cleanDepth: 0, selected: new Set(), current: 0, zoom: 1,
    zoomMode: settings.zoomMode, scroll: 0};
  docs.push(d);
  if (f.path) { recent = [{path: f.path, name: f.name}, ...recent.filter(r => r.path !== f.path)].slice(0, 10); }
  activate(docs.length - 1, true);
}
async function openFiles(list) { for (const f of list) await openFileInfo(f); }

/* ================= Tabs ================= */
function activate(i, fresh = false) {
  if (docs[i] !== cur()) finishEditors();
  const prev = cur();
  if (prev && prev !== docs[i]) prev.scroll = viewer.scrollTop;
  active = i;
  const d = cur();
  find.hits = []; $('#fCount').textContent = '';
  if (d) {
    viewer.hidden = false; $('#emptyState').hidden = true;
    if (fresh || d.zoomMode !== 'custom') d.zoom = d.zoomMode === 'custom' ? d.zoom : fitZoom(d, d.zoomMode);
    layout();
    viewer.scrollTop = d.scroll;
    viewer.focus({preventScroll: true});
  } else {
    viewer.hidden = true; $('#emptyState').hidden = false; pagesEl.innerHTML = ''; renderRecent();
  }
  buildThumbs(); buildOutline(); buildProps(); renderTabs(); updateUI(); saveState();
}
async function closeTab(i) {
  if (i === active) finishEditors();
  const d = docs[i];
  if (d.dirty && !await ask(t('confirm.close', {name: d.name}), t('confirm.ok'))) return;
  docs.splice(i, 1);
  forgetSources(d.sources);
  let next = active;
  if (i < active) next--; else if (i === active) next = Math.min(active, docs.length - 1);
  active = -1;
  activate(next);
}
function renderTabs() {
  const box = $('#tabs'); box.innerHTML = '';
  docs.forEach((d, i) => {
    const el = document.createElement('div');
    el.className = 'tab' + (i === active ? ' active' : '') + (d.dirty ? ' dirty' : '');
    el.title = (d.path || d.name) + (d.dirty ? ' — ' + t('ui.notSaved') : '');
    el.innerHTML = `<span class="tab-ico">PDF</span><span class="name">${esc(d.name)}</span><button class="x" title="${esc(t('a.closeTab'))} (Alt+W)">&#10005;</button>`;
    el.onmousedown = e => { if (e.button === 1) { e.preventDefault(); closeTab(i); } };
    el.onclick = e => e.target.closest('.x') ? closeTab(i) : (i !== active && activate(i));
    box.append(el);
  });
  const plus = document.createElement('button');
  plus.className = 'tab-new'; plus.title = `${t('ui.openTip')} (Ctrl+O)`; plus.textContent = '+';
  plus.onclick = () => A.openFile();
  box.append(plus);
}
function renderRecent() {
  const box = $('#recent');
  box.innerHTML = recent.length ? `<div class="sect">${esc(t('ui.recent'))}</div>` + recent.map((r, i) =>
    `<button data-recent="${i}"><span class="tab-ico">PDF</span><span>${esc(r.name)}</span><small>${esc(r.path)}</small></button>`).join('') : '';
}
$('#recent').addEventListener('click', e => {
  const b = e.target.closest('[data-recent]'); if (!b) return;
  const r = recent[+b.dataset.recent];
  openFileInfo({path: r.path, name: r.name});
});

/* ================= Page layout & rendering ================= */
const effRot = pg => (pg.base + pg.rot) % 360;
function dispSize(pg, zoom) {
  const s = zoom * CSS_UNITS, sw = effRot(pg) % 180 !== 0;
  return [(sw ? pg.h : pg.w) * s, (sw ? pg.w : pg.h) * s];
}
const proxyOf = (d, pg) => d.sources[pg.src].proxies[pg.index];
const viewportOf = (d, pg, zoom) => proxyOf(d, pg).getViewport({scale: zoom * CSS_UNITS, rotation: effRot(pg)});
function fitZoom(d, mode) {
  const pg = d.pages[d.current] || d.pages[0];
  const [w, h] = dispSize(pg, 1);
  const availW = Math.max(200, (viewer.clientWidth || 900) - 64), availH = Math.max(200, (viewer.clientHeight || 700) - 56);
  if (mode === 'fit-width') return clamp(availW / w, 0.1, 6);
  if (mode === 'fit-page') return clamp(Math.min(availW / w, availH / h), 0.1, 6);
  return 1;
}

function layout() {
  const d = cur(); pagesEl.innerHTML = '';
  d.pages.forEach((pg, i) => {
    const el = document.createElement('div');
    el.className = 'page'; el.dataset.i = i;
    el.innerHTML = `<svg class="annots" xmlns="${SVGNS}"></svg>`;
    pagesEl.append(el);
    sizePage(el, d, pg);
  });
  requestAnimationFrame(renderVisible);
}
function sizePage(el, d, pg) {
  const [w, h] = dispSize(pg, d.zoom);
  el.style.width = w + 'px'; el.style.height = h + 'px';
  el._pg = pg; el._vp = viewportOf(d, pg, d.zoom);
  drawAnnots(el);
}
let scrollRaf = 0;
viewer.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; renderVisible(); });
});
window.addEventListener('resize', () => {
  const d = cur();
  if (d && d.zoomMode !== 'custom') setZoom(d.zoomMode);
});

function renderVisible() {
  const d = cur(); if (!d || viewer.hidden) return;
  const top = viewer.scrollTop, bottom = top + viewer.clientHeight, margin = viewer.clientHeight;
  const key = String(d.zoom);
  for (const el of pagesEl.children) {
    const y = el.offsetTop, y2 = y + el.offsetHeight;
    if (y2 > top - margin && y < bottom + margin) { if (el.dataset.z !== key) renderPage(el); }
    else if ((y2 < top - 5 * margin || y > bottom + 5 * margin) && el.dataset.z) freePage(el);
  }
  updateCurrentPage();
}
async function renderPage(el) {
  const d = cur(), pg = el._pg, key = String(d.zoom);
  el.dataset.z = key;
  if (el._task) { el._task.cancel(); el._task = null; }
  if (!el.querySelector('canvas')) el.classList.add('loading');
  const vp = viewportOf(d, pg, d.zoom);
  let dpr = window.devicePixelRatio || 1;
  dpr = Math.min(dpr, Math.sqrt(16e6 / (vp.width * vp.height)));   // cap canvas memory on huge zoom
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
  const task = proxyOf(d, pg).render({canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    annotationMode: pg.src === 0 ? pdfjsLib.AnnotationMode.ENABLE_FORMS : pdfjsLib.AnnotationMode.ENABLE});
  el._task = task;
  try { await task.promise; } catch (e) { return; }
  if (el.dataset.z !== key || !el.isConnected) return;
  el._task = null;
  const old = el.querySelector('canvas'); if (old) old.remove();
  el.prepend(canvas);
  el.classList.remove('loading');
  const oldTl = el.querySelector('.textLayer'); if (oldTl) oldTl.remove();
  const tl = document.createElement('div'); tl.className = 'textLayer';
  el.style.setProperty('--scale-factor', vp.scale); el.style.setProperty('--total-scale-factor', vp.scale);
  canvas.after(tl);
  try {
    await new pdfjsLib.TextLayer({textContentSource: proxyOf(d, pg).streamTextContent(), container: tl, viewport: vp}).render();
    markHits(el);
  } catch (e) {}
  renderForm(el, key);
}

/* ================= Forms ================= */
/* Form fields of the opened PDF (its first file) are shown as real inputs over the page. Values are kept in d.form
   (full field name → text, true/false or a choice; part of undo) and written into the fields when saving (Rust:
   pdfbuild.rs fill_form). Fields of PDFs inserted later are not editable. */
async function renderForm(el, key) {
  const d = cur(), pg = el._pg, seq = el._formSeq = (el._formSeq || 0) + 1;
  if (pg.src !== 0) { el.querySelectorAll('.formLayer').forEach(x => x.remove()); return; }
  let list;
  try { list = await proxyOf(d, pg).getAnnotations({intent: 'display'}); } catch (e) { return; }
  // Only the newest call for this page draws (undo and a new rendering may overlap).
  if (seq !== el._formSeq || el.dataset.z !== key || !el.isConnected) return;
  el.querySelectorAll('.formLayer').forEach(x => x.remove());
  const widgets = list.filter(a => a.subtype === 'Widget' && a.fieldName && !a.pushButton && !a.hidden && !a.noView);
  if (!widgets.length) return;
  if (!d.formSeen) { d.formSeen = true; toast(t('form.found')); }
  d.form = d.form || {};
  const vp = viewportOf(d, pg, d.zoom), layer = document.createElement('div');
  layer.className = 'formLayer';
  for (const a of widgets) {
    const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
    const box = {left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1)};
    const name = a.fieldName, has = Object.prototype.hasOwnProperty.call(d.form, name);
    let input;
    if (a.fieldType === 'Tx') {
      input = document.createElement(a.multiLine ? 'textarea' : 'input');
      input.value = has ? d.form[name] : (a.fieldValue || '');
      if (a.maxLen) input.maxLength = a.maxLen;
      if (a.readOnly) input.readOnly = true;
      input.style.fontSize = Math.max(8, Math.min(a.multiLine ? 12 * vp.scale : box.height * 0.65, 16 * vp.scale)) + 'px';
      if (a.comb && a.maxLen) input.style.letterSpacing = `${box.width / a.maxLen - box.height * 0.4}px`;
    } else if (a.fieldType === 'Btn' && (a.checkBox || a.radioButton)) {
      input = document.createElement('input');
      input.type = a.checkBox ? 'checkbox' : 'radio';
      input.name = 'f:' + name;
      const v = has ? d.form[name] : a.fieldValue;
      input.checked = a.checkBox ? (v === true || (typeof v === 'string' && v !== 'Off' && v !== '')) : v === a.buttonValue;
      input.dataset.on = a.checkBox ? (a.exportValue || 'Yes') : a.buttonValue;
    } else if (a.fieldType === 'Ch') {
      input = document.createElement('select');
      if (!a.combo) input.size = Math.max(2, Math.min(6, a.options.length));
      const v = has ? d.form[name] : (Array.isArray(a.fieldValue) ? a.fieldValue[0] : a.fieldValue);
      input.innerHTML = a.options.map(o => `<option value="${esc(o.exportValue)}"${o.exportValue === v ? ' selected' : ''}>${esc(o.displayValue)}</option>`).join('');
    } else continue;
    input.className = 'ff';
    input.title = a.alternativeText || name;
    Object.assign(input.style, {left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px'});
    input.addEventListener('change', () => {
      const value = input.type === 'checkbox' ? input.checked : input.type === 'radio' ? (input.checked ? input.dataset.on : 'Off') : input.value;
      pushHistory(d); d.form[name] = value; changed();
      // The other buttons of a radio group follow.
      if (input.type === 'radio') pagesEl.querySelectorAll(`.formLayer input[name="${CSS.escape(input.name)}"]`).forEach(r => { r.checked = r.dataset.on === value; });
    });
    layer.append(input);
  }
  el.append(layer);
}
function refreshForms() { const d = cur(); if (!d) return; for (const el of pagesEl.children) if (el.dataset.z) renderForm(el, el.dataset.z); }
function freePage(el) {
  if (el._task) { el._task.cancel(); el._task = null; }
  el.querySelectorAll('canvas,.textLayer').forEach(x => x.remove());
  delete el.dataset.z;
}
function updateCurrentPage() {
  const d = cur(); if (!d) return;
  const mid = viewer.scrollTop + viewer.clientHeight * 0.4;
  let i = 0;
  for (const el of pagesEl.children) { if (el.offsetTop <= mid) i = +el.dataset.i; else break; }
  if (i !== d.current) { d.current = i; markThumbs(); }
  updatePageUI();
}
function goToPage(i) {
  const d = cur(); if (!d) return;
  i = clamp(i, 0, d.pages.length - 1);
  const el = pagesEl.children[i]; if (!el) return;
  viewer.scrollTop = el.offsetTop - 14;
  d.current = i; markThumbs(); updatePageUI();
}

/* ================= Zoom ================= */
const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6];
function setZoom(mode) {
  const d = cur(); if (!d) return;
  // Keep the same spot of the current page in view.
  const el = pagesEl.children[d.current];
  const frac = el ? (viewer.scrollTop - el.offsetTop) / el.offsetHeight : 0;
  const fracX = viewer.scrollWidth > viewer.clientWidth ? (viewer.scrollLeft + viewer.clientWidth / 2) / viewer.scrollWidth : 0.5;
  d.zoomMode = typeof mode === 'string' ? mode : 'custom';
  d.zoom = typeof mode === 'string' ? fitZoom(d, mode) : clamp(mode, 0.1, 6);
  for (const p of pagesEl.children) sizePage(p, d, p._pg);
  if (el) viewer.scrollTop = el.offsetTop + frac * el.offsetHeight;
  viewer.scrollLeft = fracX * viewer.scrollWidth - viewer.clientWidth / 2;
  renderVisible(); updateZoomUI();
}
const zoomStep = dir => {
  const d = cur(); if (!d) return;
  const z = d.zoom, next = dir > 0 ? STEPS.find(s => s > z + 0.001) : [...STEPS].reverse().find(s => s < z - 0.001);
  setZoom(next ?? z);
};
viewer.addEventListener('wheel', e => {
  if (!e.ctrlKey || !cur()) return;
  e.preventDefault();
  setZoom(cur().zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, {passive: false});
function updateZoomUI() {
  const d = cur(), sel = $('#zoomSel');
  const opts = [['fit-width', t('ui.fitWidthOpt')], ['fit-page', t('ui.fitPageOpt')],
    ...[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map(z => [String(z), Math.round(z * 100) + ' %'])];
  let value = d ? (d.zoomMode === 'custom' ? String(d.zoom) : d.zoomMode === 'actual' ? '1' : d.zoomMode) : 'fit-width';
  if (d && d.zoomMode === 'custom' && !opts.some(o => o[0] === value)) opts.push([value, Math.round(d.zoom * 100) + ' %']);
  sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  sel.value = value;
  $('#stZoom').textContent = d ? t('st.zoom', {n: Math.round(d.zoom * 100)}) : '';
}
$('#zoomSel').onchange = e => { const v = e.target.value; setZoom(v.startsWith('fit') ? v : +v); viewer.focus({preventScroll: true}); };

/* ================= Annotations ================= */
const hexRgb = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const NOTE = {size: 11, line: 13.5, pad: 4};
let measureCtx = null;
function noteBox(text, scale) {
  measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
  measureCtx.font = `${NOTE.size}px Helvetica, Arial, sans-serif`;
  const lines = text.split('\n');
  const w = Math.max(...lines.map(l => measureCtx.measureText(l).width)) + NOTE.pad * 2;
  return {lines, w: w * scale, h: (lines.length * NOTE.line + NOTE.pad * 2) * scale};
}
/* Text tool: text written straight onto the page in a standard PDF font. Arial, Times New Roman and Courier New have
   the widths of Helvetica, Times and Courier, so what you see is laid out like the saved file. */
const TEXT_FONTS = {helv: 'Helvetica, Arial, sans-serif', times: '"Times New Roman", Times, serif', cour: '"Courier New", Courier, monospace'};
const FONT_NAMES = {helv: 'Helvetica', times: 'Times', cour: 'Courier'};
const TEXT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64, 72];
const TEXT_LINE = 1.2, TEXT_BASE = .94;   // line height and first baseline below the top, in font sizes
const textCss = (a, size) => `${a.bold ? 'bold ' : ''}${size}px ${TEXT_FONTS[a.font] || TEXT_FONTS.helv}`;
function textWidth(s, a, size = a.size) {
  measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
  measureCtx.font = textCss(a, size);
  return measureCtx.measureText(s).width;
}
const textBox = (a, scale) => { const lines = a.text.split('\n'); return {w: Math.max(...lines.map(l => textWidth(l, a))) * scale, h: lines.length * TEXT_LINE * a.size * scale}; };
function drawAnnots(el) {
  const d = cur(), pg = el._pg, vp = el._vp, svg = el.querySelector('svg.annots');
  if (!svg || !vp) return;
  svg.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`);
  const list = d.annots[pg.id] || [];
  svg.innerHTML = list.map((a, k) => {
    if (a.t === 'hl') {
      const [x1, y1] = vp.convertToViewportPoint(a.r[0], a.r[1]), [x2, y2] = vp.convertToViewportPoint(a.r[2], a.r[3]);
      return `<rect class="ann hl" data-k="${k}" x="${Math.min(x1, x2)}" y="${Math.min(y1, y2)}" width="${Math.abs(x2 - x1)}" height="${Math.abs(y2 - y1)}" fill="${a.c}" fill-opacity=".4"/>`;
    }
    if (a.t === 'hlt') {   // highlighted text: one bar per line
      return `<g class="ann hl" data-k="${k}" fill="${a.c}" fill-opacity=".4">${a.rs.map(r => {
        const [x1, y1] = vp.convertToViewportPoint(r[0], r[1]), [x2, y2] = vp.convertToViewportPoint(r[2], r[3]);
        return `<rect x="${Math.min(x1, x2)}" y="${Math.min(y1, y2)}" width="${Math.abs(x2 - x1)}" height="${Math.abs(y2 - y1)}"/>`;
      }).join('')}</g>`;
    }
    if (a.t === 'ink') {
      const pts = a.p.map(p => vp.convertToViewportPoint(p[0], p[1]).map(v => v.toFixed(1)).join(',')).join(' ');
      return `<polyline class="ann" data-k="${k}" points="${pts}" fill="none" stroke="${a.c}" stroke-width="${a.w * vp.scale}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    if (a.t === 'sig') {
      return `<g class="ann sig" data-k="${k}" fill="none" stroke="${a.c}" stroke-width="${a.w * vp.scale}" stroke-linecap="round" stroke-linejoin="round">` +
        a.s.map(st => `<polyline points="${st.map(p => vp.convertToViewportPoint(p[0], p[1]).map(v => v.toFixed(1)).join(',')).join(' ')}"/>`).join('') + '</g>';
    }
    if (a.t === 'note') {
      const [x, y] = vp.convertToViewportPoint(a.x, a.y), s = vp.scale, box = noteBox(a.text, s);
      const tsp = box.lines.map((l, i) => `<tspan x="${x + NOTE.pad * s}" y="${y + (NOTE.pad + (i + 1) * NOTE.line - 3.5) * s}">${esc(l) || ' '}</tspan>`).join('');
      return `<g class="ann" data-k="${k}"><rect x="${x}" y="${y}" width="${box.w}" height="${box.h}" fill="#FFF7B3" stroke="${a.c}" stroke-width="${s}"/>` +
        `<text font-family="Helvetica, Arial, sans-serif" font-size="${NOTE.size * s}" fill="#222">${tsp}</text></g>`;
    }
    if (a.t === 'text') {
      const [x, y] = vp.convertToViewportPoint(a.x, a.y), s = vp.scale;
      const tsp = a.text.split('\n').map((l, i) => `<tspan x="${x}" y="${y + (TEXT_BASE + i * TEXT_LINE) * a.size * s}">${esc(l) || ' '}</tspan>`).join('');
      return `<text class="ann txt" data-k="${k}" font-family="${esc(TEXT_FONTS[a.font] || TEXT_FONTS.helv)}" font-size="${a.size * s}"` +
        `${a.bold ? ' font-weight="bold"' : ''} fill="${a.c}" style="white-space:pre">${tsp}</text>`;
    }
    return '';
  }).join('');
}
/* Which annotation (index) lies under a screen point on a page, or -1. Works in every tool,
   unlike event targets (the annotation layer ignores the mouse while selecting text). */
function annotAt(el, clientX, clientY) {
  const d = cur(), list = d.annots[el._pg.id] || [], vp = el._vp, box = el.getBoundingClientRect();
  const x = clientX - box.left, y = clientY - box.top;
  for (let k = list.length - 1; k >= 0; k--) {
    const a = list[k];
    if (a.t === 'hl') {
      const [x1, y1] = vp.convertToViewportPoint(a.r[0], a.r[1]), [x2, y2] = vp.convertToViewportPoint(a.r[2], a.r[3]);
      if (x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && y >= Math.min(y1, y2) && y <= Math.max(y1, y2)) return k;
    } else if (a.t === 'hlt') {
      if (a.rs.some(r => {
        const [x1, y1] = vp.convertToViewportPoint(r[0], r[1]), [x2, y2] = vp.convertToViewportPoint(r[2], r[3]);
        return x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && y >= Math.min(y1, y2) && y <= Math.max(y1, y2);
      })) return k;
    } else if (a.t === 'ink' || a.t === 'sig') {
      for (const p of (a.t === 'sig' ? a.s.flat() : a.p)) { const [px, py] = vp.convertToViewportPoint(p[0], p[1]); if (Math.hypot(px - x, py - y) < 8) return k; }
    } else if (a.t === 'note') {
      const [nx, ny] = vp.convertToViewportPoint(a.x, a.y), b = noteBox(a.text, vp.scale);
      if (x >= nx && x <= nx + b.w && y >= ny && y <= ny + b.h) return k;
    } else if (a.t === 'text') {
      const [tx, ty] = vp.convertToViewportPoint(a.x, a.y), b = textBox(a, vp.scale);
      if (x >= tx - 3 && x <= tx + b.w + 3 && y >= ty && y <= ty + b.h) return k;
    }
  }
  return -1;
}
function addAnnot(pg, a) {
  const d = cur();
  pushHistory(d);
  (d.annots[pg.id] = d.annots[pg.id] || []).push(a);
  changed();
}
pagesEl.addEventListener('pointerdown', e => {
  if (tool === 'select' || tool === 'hand' || e.button !== 0) return;
  const el = e.target.closest('.page'); if (!el) return;
  const d = cur(), pg = el._pg, vp = el._vp, svg = el.querySelector('svg.annots');
  const box = el.getBoundingClientRect();
  const local = ev => [ev.clientX - box.left, ev.clientY - box.top];
  const toPdf = p => vp.convertToPdfPoint(p[0], p[1]);
  if (tool === 'erase') {
    const a = e.target.closest('.ann');
    if (a) { pushHistory(d); d.annots[pg.id].splice(+a.dataset.k, 1); changed(); }
    return;
  }
  e.preventDefault();
  if (tool === 'highlight' && textAt(el, e.clientX, e.clientY)) return highlightDrag(e);
  if (tool === 'note') return openNoteEditor(el, local(e));
  if (tool === 'text') return textDown(e, el, local(e));
  if (tool === 'sign') return placeSignature(el, local(e));
  svg.setPointerCapture(e.pointerId);
  const start = local(e), pts = [start];
  const temp = document.createElementNS(SVGNS, tool === 'highlight' ? 'rect' : 'polyline');
  if (tool === 'highlight') { temp.setAttribute('fill', settings.color); temp.setAttribute('fill-opacity', '.4'); temp.classList.add('hl'); }
  else {
    temp.setAttribute('fill', 'none'); temp.setAttribute('stroke', settings.color);
    temp.setAttribute('stroke-width', 2 * vp.scale); temp.setAttribute('stroke-linecap', 'round'); temp.setAttribute('stroke-linejoin', 'round');
  }
  svg.append(temp);
  const move = ev => {
    const p = local(ev);
    if (tool === 'highlight') {
      temp.setAttribute('x', Math.min(start[0], p[0])); temp.setAttribute('y', Math.min(start[1], p[1]));
      temp.setAttribute('width', Math.abs(p[0] - start[0])); temp.setAttribute('height', Math.abs(p[1] - start[1]));
    } else {
      const last = pts[pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 1.5) return;
      pts.push(p);
      temp.setAttribute('points', pts.map(q => q.join(',')).join(' '));
    }
  };
  const up = ev => {
    svg.removeEventListener('pointermove', move);
    temp.remove();
    const end = local(ev);
    if (tool === 'highlight') {
      if (Math.abs(end[0] - start[0]) < 3 || Math.abs(end[1] - start[1]) < 3) return;
      const [x1, y1] = toPdf(start), [x2, y2] = toPdf(end);
      addAnnot(pg, {t: 'hl', r: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)], c: settings.color});
    } else if (pts.length > 1) {
      addAnnot(pg, {t: 'ink', p: pts.map(p => toPdf(p).map(v => +v.toFixed(2))), c: settings.color, w: 2});
    }
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', up, {once: true});
});
/* An open note or text editor is finished (kept) before saving, printing, closing or switching documents:
   the toolbar buttons and shortcuts don't take the focus away from it, so its blur doesn't do it. */
let noteEd = null;
function finishEditors() {
  if (textEd) textEd.commit(true); if (noteEd) noteEd.commit(true);
  const f = document.activeElement; if (f && f.closest && f.closest('.formLayer')) f.blur();   // its change event stores the value
}
const spellIgnored = new Set();   // spelling issues ignored in notes this session
function openNoteEditor(el, [x, y]) {
  const ta = document.createElement('textarea');
  ta.className = 'note-edit'; ta.placeholder = t('ui.notePh');
  ta.style.left = x + 'px'; ta.style.top = y + 'px';
  el.append(ta); ta.focus();
  // Spelling & grammar while typing (spellfield.js; right-click an underline for suggestions).
  if (window.SpellField) SpellField.attach(ta, {lang: () => settings.spell, fallback: () => lang, ignored: spellIgnored});
  let done = false;
  const commit = keep => {
    if (done) return; done = true; noteEd = null;
    const text = ta.value.replace(/\s+$/, ''), marks = ta.nextElementSibling;
    ta.remove(); if (marks && marks.classList.contains('spell-marks')) marks.remove();
    if (keep && text) { const [px, py] = el._vp.convertToPdfPoint(x, y); addAnnot(el._pg, {t: 'note', x: px, y: py, text, c: settings.color}); }
  };
  noteEd = {commit};
  ta.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') commit(false);
    if (e.key === 'Enter' && (e.ctrlKey || !e.shiftKey)) { e.preventDefault(); commit(true); }
  });
  ta.addEventListener('blur', () => { if (document.hasFocus()) commit(true); });
  ta.addEventListener('pointerdown', e => e.stopPropagation());
}
/* ---- Highlighting existing text: a text selection becomes highlight bars, one per line, on each page it touches. ---- */
const textAt = (el, x, y) => [...el.querySelectorAll('.textLayer span:not(.markedContent)')].some(s => {
  const r = s.getBoundingClientRect(); return r.width && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
});
/* The current text selection, if it lies in the pages. */
function selectionRange() {
  const s = getSelection();
  if (!s.rangeCount || s.isCollapsed) return null;
  const r = s.getRangeAt(0), n = r.commonAncestorContainer, host = n.nodeType === 1 ? n : n.parentElement;
  return host && pagesEl.contains(host) && r.toString().trim() ? r : null;
}
/* Rectangles on one line (overlapping vertically, close horizontally) become one bar. */
function mergeLines(rects) {
  rects.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out = [];
  for (const r of rects) {
    const h = r[3] - r[1];
    const m = out.find(o => Math.min(o[3], r[3]) - Math.max(o[1], r[1]) >= .5 * Math.min(h, o[3] - o[1]) && r[0] <= o[2] + h && r[2] >= o[0] - h);
    if (m) { m[0] = Math.min(m[0], r[0]); m[1] = Math.min(m[1], r[1]); m[2] = Math.max(m[2], r[2]); m[3] = Math.max(m[3], r[3]); }
    else out.push([...r]);
  }
  return out;
}
/* Highlights the text of a range (only the letters: the range's other boxes, like whole pages, are ignored). */
function highlightRange(range, color = settings.color) {
  const d = cur(); if (!d) return 0;
  const byPage = new Map();
  for (const span of pagesEl.querySelectorAll('.textLayer span:not(.markedContent)')) {
    const tn = span.firstChild;
    if (!tn || tn.nodeType !== 3 || !range.intersectsNode(tn)) continue;
    const sub = document.createRange(); sub.selectNodeContents(tn);
    if (range.startContainer === tn) sub.setStart(tn, range.startOffset);
    if (range.endContainer === tn) sub.setEnd(tn, range.endOffset);
    if (!sub.toString().trim()) continue;
    const el = span.closest('.page'); if (!el || !el._vp) continue;
    const b = el.getBoundingClientRect();
    if (!byPage.has(el)) byPage.set(el, []);
    for (const r of sub.getClientRects()) if (r.width >= 1 && r.height >= 1) byPage.get(el).push([r.left - b.left, r.top - b.top, r.right - b.left, r.bottom - b.top]);
  }
  const pages = [...byPage].filter(([, rects]) => rects.length);
  if (!pages.length) return 0;
  pushHistory(d);
  for (const [el, rects] of pages) {
    const rs = mergeLines(rects).map(([x0, y0, x1, y1]) => {
      const [a, b] = el._vp.convertToPdfPoint(x0, y0), [c, e] = el._vp.convertToPdfPoint(x1, y1);
      return [Math.min(a, c), Math.min(b, e), Math.max(a, c), Math.max(b, e)].map(v => +v.toFixed(2));
    });
    (d.annots[el._pg.id] = d.annots[el._pg.id] || []).push({t: 'hlt', rs, c: color});
  }
  changed();
  return pages.length;
}
/* Highlight tool on text: dragging selects letters (like the select tool) and the selection becomes the highlight. */
function highlightDrag(e) {
  document.body.classList.add('hl-text');   // the text layer takes the mouse, so the browser finds the letters under it
  const caret = (x, y) => {
    const r = document.caretRangeFromPoint(x, y);
    return r && r.startContainer.nodeType === 3 && r.startContainer.parentElement.closest('.textLayer') ? r : null;
  };
  const start = caret(e.clientX, e.clientY), sel = getSelection();
  if (!start) { document.body.classList.remove('hl-text'); return; }
  sel.removeAllRanges();
  const move = ev => { const r = caret(ev.clientX, ev.clientY); if (r) sel.setBaseAndExtent(start.startContainer, start.startOffset, r.startContainer, r.startOffset); };
  const up = () => {
    window.removeEventListener('pointermove', move);
    document.body.classList.remove('hl-text');
    const range = selectionRange();
    if (range) highlightRange(range);
    sel.removeAllRanges();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, {once: true});
}
// In the highlight tool the cursor shows whether a drag will follow the text or draw a box.
pagesEl.addEventListener('pointermove', e => {
  if (tool !== 'highlight' || e.buttons) return;
  const el = e.target.closest('.page'), svg = el && el.querySelector('svg.annots');
  if (svg) svg.style.cursor = textAt(el, e.clientX, e.clientY) ? 'text' : '';
});
/* Text tool: a click writes new text; a click on a text edits it, dragging moves it. */
function textDown(e, el, p) {
  if (textEd) return textEd.commit(true);   // a click beside the open editor just finishes it
  const d = cur(), list = d.annots[el._pg.id] || [], k = annotAt(el, e.clientX, e.clientY);
  if (k < 0 || list[k].t !== 'text') return openTextEditor(el, p);
  const svg = el.querySelector('svg.annots'), node = svg.querySelector(`[data-k="${k}"]`);
  svg.setPointerCapture(e.pointerId);
  let dx = 0, dy = 0;
  const move = ev => { dx = ev.clientX - e.clientX; dy = ev.clientY - e.clientY; if (node) node.setAttribute('transform', `translate(${dx} ${dy})`); };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', () => {
    svg.removeEventListener('pointermove', move);
    if (Math.hypot(dx, dy) < 3) { if (node) node.removeAttribute('transform'); return openTextEditor(el, null, k); }
    const vp = el._vp, a = list[k], [x, y] = vp.convertToViewportPoint(a.x, a.y);
    pushHistory(d);
    [a.x, a.y] = vp.convertToPdfPoint(x + dx, y + dy);
    changed();
  }, {once: true});
}
let textEd = null;   // the open text editor: {ta, style(), commit(keep)}
function openTextEditor(el, p, k = -1) {
  const d = cur(), list = d.annots[el._pg.id] = d.annots[el._pg.id] || [], orig = k >= 0 ? list[k] : null;
  if (orig) {   // editing: the text leaves the page while it is in the editor, with its look in the options
    list.splice(k, 1); drawAnnots(el);
    Object.assign(settings, {textFont: orig.font, textSize: orig.size, textBold: !!orig.bold, textColor: orig.c}); syncTextOpts();
  }
  const [x, y] = orig ? el._vp.convertToViewportPoint(orig.x, orig.y) : p;
  const ta = document.createElement('textarea');
  ta.className = 'text-edit'; ta.placeholder = t('ui.textPh'); ta.wrap = 'off';
  ta.value = orig ? orig.text : '';
  ta.style.left = x + 'px'; ta.style.top = y + 'px';
  el.append(ta);
  const style = () => {
    const a = {font: settings.textFont, bold: settings.textBold}, size = settings.textSize * el._vp.scale, lines = (ta.value || ta.placeholder).split('\n');
    Object.assign(ta.style, {font: textCss(a, size), lineHeight: TEXT_LINE, color: settings.textColor});
    ta.style.width = Math.max(...lines.map(l => textWidth(l, a, size))) + size + 'px';
    ta.style.height = lines.length * TEXT_LINE * size + 'px';
  };
  style(); ta.addEventListener('input', style);
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  if (window.SpellField) SpellField.attach(ta, {lang: () => settings.spell, fallback: () => lang, ignored: spellIgnored});
  let done = false;
  const commit = keep => {
    if (done) return; done = true; textEd = null;
    const text = ta.value.replace(/\s+$/, ''), marks = ta.nextElementSibling;
    ta.remove(); if (marks && marks.classList.contains('spell-marks')) marks.remove();
    const a = {t: 'text', x: 0, y: 0, text, size: settings.textSize, font: settings.textFont, bold: settings.textBold, c: settings.textColor};
    if (orig) {
      list.splice(k, 0, orig);
      const next = {...a, x: orig.x, y: orig.y};
      if (!keep || JSON.stringify(next) === JSON.stringify(orig)) return drawAnnots(el);
      pushHistory(d);
      if (text) list[k] = next; else list.splice(k, 1);
      return changed();
    }
    if (keep && text) { [a.x, a.y] = el._vp.convertToPdfPoint(x, y); addAnnot(el._pg, a); }
  };
  ta.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') commit(false);
    if (e.key === 'Enter' && (e.ctrlKey || !e.shiftKey)) { e.preventDefault(); commit(true); }
  });
  // Choosing a font or size in the options bar keeps the editor open.
  ta.addEventListener('blur', e => { if (e.relatedTarget && e.relatedTarget.closest('#textOpts')) return; if (document.hasFocus()) commit(true); });
  ta.addEventListener('pointerdown', e => e.stopPropagation());
  textEd = {ta, style, commit};
}
const colorKey = () => tool === 'text' ? 'textColor' : 'color';
function syncTextOpts() {
  const f = $('#textFont'), s = $('#textSize'), b = $('#textOpts [data-act="textBold"]');
  if (f) f.value = settings.textFont;
  if (s) s.value = String(settings.textSize);
  if (b) b.classList.toggle('active', !!settings.textBold);
  $$('.swatch').forEach(w => w.classList.toggle('active', w.dataset.color === settings[colorKey()]));
}
$('#textOpts').addEventListener('change', e => {
  if (e.target.id === 'textFont') settings.textFont = e.target.value;
  if (e.target.id === 'textSize') settings.textSize = +e.target.value;
  saveState();
  if (textEd) { textEd.style(); textEd.ta.focus(); }
});
/* Hand tool: drag to pan */
viewer.addEventListener('pointerdown', e => {
  if (tool !== 'hand' || e.button !== 0) return;
  const sx = e.clientX, sy = e.clientY, l = viewer.scrollLeft, tp = viewer.scrollTop;
  document.body.classList.add('panning'); viewer.setPointerCapture(e.pointerId);
  const move = ev => { viewer.scrollLeft = l - (ev.clientX - sx); viewer.scrollTop = tp - (ev.clientY - sy); };
  viewer.addEventListener('pointermove', move);
  viewer.addEventListener('pointerup', () => { viewer.removeEventListener('pointermove', move); document.body.classList.remove('panning'); }, {once: true});
});
function setTool(name) {
  if (textEd && name !== 'text') textEd.commit(true);
  tool = name;
  document.body.className = document.body.className.replace(/\btool-\S+/g, '').trim() + ' tool-' + name;
  document.body.classList.toggle('invert', settings.invert);
  $$('#tools .ibtn[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === name));
  $('#swatches').style.display = ['highlight', 'pen', 'note', 'text'].includes(name) ? '' : 'none';
  $('#textOpts').style.display = name === 'text' ? '' : 'none';
  syncTextOpts();
  $('#stTool').textContent = t('tool.status', {name: t('a.' + TOOL_ACT[name])});
}
const TOOL_ACT = {select: 'toolSelect', hand: 'toolHand', highlight: 'toolHighlight', pen: 'toolPen', note: 'toolNote', text: 'toolText', sign: 'toolSign', erase: 'toolErase'};

/* ================= Signature ================= */
/* The signature is drawn once in a pad (kept in the settings, on this PC only) and placed with a click; on the page it
   is a group of ink strokes (saved like the pen), 160 pt wide, which the eraser removes as one. */
const SIG_W = 160, SIG_COLOR = '#1a3d8f';
function signaturePad(then) {
  const strokes = [];
  modal(t('sig.title'), `<p class="hint" style="margin-top:0">${esc(t('sig.hint'))}</p><canvas class="sig-pad" width="900" height="300"></canvas>`, [
    {label: t('sig.clear'), onClick: () => { strokes.length = 0; draw(); }},
    {label: t('confirm.cancel'), onClick: closeModal},
    {label: t('sig.save'), primary: true, onClick: () => {
      if (!strokes.length) return toast(t('sig.empty'));
      // Trimmed to the drawing and stored relative to its width.
      const all = strokes.flat(), x0 = Math.min(...all.map(p => p[0])), y0 = Math.min(...all.map(p => p[1]));
      const w = Math.max(1, Math.max(...all.map(p => p[0])) - x0), h = Math.max(1, Math.max(...all.map(p => p[1])) - y0);
      settings.signature = {ratio: h / w, s: strokes.map(st => st.map(([x, y]) => [+((x - x0) / w).toFixed(4), +((y - y0) / w).toFixed(4)]))};
      saveState(); closeModal(); toast(t('sig.saved')); if (then) then();
    }}]);
  const cv = $('.sig-pad'), g = cv.getContext('2d');
  const draw = () => {
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    g.strokeStyle = '#d0d4dc'; g.lineWidth = 1; g.beginPath(); g.moveTo(40, 230); g.lineTo(860, 230); g.stroke();
    g.strokeStyle = SIG_COLOR; g.lineWidth = 4; g.lineCap = g.lineJoin = 'round';
    for (const st of strokes) { g.beginPath(); st.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); if (st.length === 1) g.lineTo(st[0][0] + .1, st[0][1]); g.stroke(); }
  };
  let cur = null;
  const at = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * cv.width, (e.clientY - r.top) / r.height * cv.height]; };
  cv.onpointerdown = e => { cv.setPointerCapture(e.pointerId); cur = [at(e)]; strokes.push(cur); draw(); };
  cv.onpointermove = e => { if (!cur) return; const p = at(e), l = cur[cur.length - 1]; if (Math.hypot(p[0] - l[0], p[1] - l[1]) > 2) { cur.push(p); draw(); } };
  cv.onpointerup = cv.onpointercancel = () => { cur = null; };
  draw();
}
function placeSignature(el, at) {
  const sig = settings.signature;
  if (!sig || !sig.s || !sig.s.length) return signaturePad(() => setTool('sign'));
  const vp = el._vp, w = SIG_W * vp.scale, h = w * sig.ratio;
  // The click is the left end of the signature's middle.
  const ox = at[0], oy = at[1] - h / 2;
  addAnnot(el._pg, {t: 'sig', w: 1.4, c: SIG_COLOR, s: sig.s.map(st => st.map(([x, y]) => vp.convertToPdfPoint(ox + x * w, oy + y * w).map(v => +v.toFixed(2))))});
}

/* ================= History & page operations ================= */
const snapshot = d => ({pages: d.pages.map(p => ({...p})), annots: JSON.parse(JSON.stringify(d.annots)), form: {...(d.form || {})}});
function pushHistory(d) {
  if (d.history.length < d.cleanDepth) d.cleanDepth = -1;
  d.history.push(snapshot(d));
  if (d.history.length > 150) { d.history.shift(); d.cleanDepth--; }
  d.future = [];
}
function changed(structure = false) {
  const d = cur();
  d.dirty = d.history.length !== d.cleanDepth;
  if (structure) {
    d.selected = new Set([...d.selected].filter(id => d.pages.some(p => p.id === id)));
    d.current = clamp(d.current, 0, d.pages.length - 1);
    const keep = viewer.scrollTop;
    layout(); viewer.scrollTop = keep; buildThumbs();
  } else {
    for (const el of pagesEl.children) drawAnnots(el);
  }
  renderTabs(); updateUI();
}
function undoRedo(redo) {
  const d = cur(); if (!d) return;
  const from = redo ? d.future : d.history, to = redo ? d.history : d.future;
  if (!from.length) return;
  to.push(snapshot(d));
  const s = from.pop();
  const structure = s.pages.length !== d.pages.length || s.pages.some((p, i) => p.id !== d.pages[i].id || p.rot !== d.pages[i].rot);
  const formChanged = JSON.stringify(s.form || {}) !== JSON.stringify(d.form || {});
  d.pages = s.pages; d.annots = s.annots; d.form = s.form || {};
  changed(structure);
  if (formChanged) refreshForms();
}
const targetIds = d => d.selected.size ? new Set(d.selected) : new Set([d.pages[d.current].id]);
function rotatePages(delta) {
  const d = cur(); if (!d) return;
  const ids = targetIds(d);
  pushHistory(d);
  d.pages.forEach(p => { if (ids.has(p.id)) p.rot = (p.rot + delta + 360) % 360; });
  changed(true);
}
function deletePages() {
  const d = cur(); if (!d) return;
  const ids = targetIds(d);
  if (ids.size >= d.pages.length) return toast(t('toast.lastPage'));
  pushHistory(d);
  d.pages = d.pages.filter(p => !ids.has(p.id));
  d.selected.clear();
  changed(true);
}
function movePages(ids, beforeIndex) {
  const d = cur();
  const moving = d.pages.filter(p => ids.has(p.id));
  const at = d.pages.slice(0, beforeIndex).filter(p => !ids.has(p.id)).length;
  const rest = d.pages.filter(p => !ids.has(p.id));
  const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  if (order.every((p, i) => p.id === d.pages[i].id)) return;
  pushHistory(d);
  d.pages = order;
  changed(true);
}
async function insertPdf(files = null) {
  const d = cur(); if (!d) return;
  files = files || await pickFiles();
  let added = 0;
  for (const f of files) {
    try {
      const src = await loadPdf(await bytesOf(f), f.name);
      const idx = d.sources.push(src) - 1, pages = pagesOf(src, idx);
      if (!added) pushHistory(d);
      d.pages.splice(d.current + 1 + added, 0, ...pages);
      added += pages.length;
    } catch (e) { toast(t('toast.openFail', {name: f.name, e: e.message || e})); }
  }
  if (added) { changed(true); toast(t('toast.inserted', {n: added})); }
}

/* Blank pages: Rust writes a PDF of empty pages (pdf_blank), which joins the document as one more source. */
const PAPER = {a4: [595.28, 841.89], a5: [419.53, 595.28], a3: [841.89, 1190.55], letter: [612, 792], legal: [612, 1008]};
const PAPER_NAMES = {a4: 'A4', a5: 'A5', a3: 'A3', letter: 'Letter', legal: 'Legal'};
/* The current page as it is shown (rotation included), in points. */
const curSize = d => { const p = d.pages[d.current] || d.pages[0]; return p ? (effRot(p) % 180 ? [p.h, p.w] : [p.w, p.h]) : PAPER.a4; };
const mmSize = ([w, h]) => `${Math.round(w / 72 * 25.4)} × ${Math.round(h / 72 * 25.4)} mm`;
async function insertBlank({size = 'current', landscape = null, n = 1, where = 'after'} = {}) {
  const d = cur(); if (!d || !invoke) return;
  let [w, h] = size === 'current' ? curSize(d) : PAPER[size] || PAPER.a4;
  if (landscape != null && w !== h && (w > h) !== landscape) [w, h] = [h, w];
  n = clamp(Math.round(+n) || 1, 1, 100);
  let src;
  try { src = await loadPdf(new Uint8Array(await invoke('pdf_blank', {w, h, n})), 'blank.pdf'); }
  catch (e) { return toast(t('toast.saveFail', {e: e.message || e})); }
  const idx = d.sources.push(src) - 1, pages = pagesOf(src, idx);
  const at = {after: d.current + 1, before: d.current, start: 0, end: d.pages.length}[where] ?? d.current + 1;
  pushHistory(d);
  d.pages.splice(clamp(at, 0, d.pages.length), 0, ...pages);
  d.selected = new Set(pages.map(p => p.id));
  changed(true);
  goToPage(clamp(at, 0, d.pages.length - 1));
  toast(t('toast.blankAdded', {n}));
}
function blankDialog() {
  const d = cur(); if (!d) return;
  const o = {size: 'current', n: 1, where: 'after', landscape: false, ...settings.blank}, cs = curSize(d);
  let land = o.size === 'current' ? cs[0] > cs[1] : !!o.landscape;
  const opt = (v, l, on) => `<option value="${v}"${on ? ' selected' : ''}>${esc(l)}</option>`;
  modal(t('a.insertBlank'), `<div class="blank-form">
    <label for="bSize">${esc(t('blank.size'))}</label><select id="bSize">${opt('current', t('blank.current', {size: mmSize(cs)}), o.size === 'current')}${
      Object.keys(PAPER).map(k => opt(k, PAPER_NAMES[k] + ' · ' + mmSize(PAPER[k]), o.size === k)).join('')}</select>
    <label>${esc(t('blank.orient'))}</label><div class="seg" id="bOrient"><button data-o="0">${esc(t('blank.portrait'))}</button><button data-o="1">${esc(t('blank.landscape'))}</button></div>
    <label for="bCount">${esc(t('blank.count'))}</label><input type="number" class="field-in" id="bCount" min="1" max="100" value="${o.n}">
    <label for="bWhere">${esc(t('blank.where'))}</label><select id="bWhere">${['after', 'before', 'start', 'end'].map(w => opt(w, t('blank.' + w), o.where === w)).join('')}</select>
  </div>`, [{label: t('ui.cancel'), onClick: closeModal}, {label: t('blank.insert'), primary: true, onClick: () => go()}]);
  const seg = () => $$('#bOrient button').forEach(b => b.classList.toggle('active', +b.dataset.o === +land));
  seg();
  $('#bOrient').onclick = e => { const b = e.target.closest('button'); if (b) { land = b.dataset.o === '1'; seg(); } };
  $('#bSize').onchange = e => { if (e.target.value === 'current') { land = cs[0] > cs[1]; seg(); } };
  const go = () => {
    const choice = {size: $('#bSize').value, landscape: land, n: clamp(Math.round(+$('#bCount').value) || 1, 1, 100), where: $('#bWhere').value};
    settings.blank = choice; saveState(); closeModal();
    insertBlank(choice);
  };
  $('#bCount').onkeydown = e => { if (e.key === 'Enter') go(); };
  $('#bCount').focus(); $('#bCount').select();
}

/* ================= Building the output PDF ================= */
/* The PDF is assembled in Rust (pdfbuild.rs): page order and rotation, pages from other files, and the annotations.
   The UI only lays out the notes (display geometry); Rust writes everything into the file. */
const forgetSources = list => { list.forEach(s => s.pdf.destroy()); if (invoke) invoke('pdf_forget', {ids: list.map(s => s.rid).filter(Boolean)}).catch(() => {}); };
let helvCtx = null;
/* Width of text in Helvetica (Arial has the same widths and is always available). */
const helvWidth = (s, size) => { helvCtx = helvCtx || document.createElement('canvas').getContext('2d'); helvCtx.font = `${size}px Helvetica, Arial, sans-serif`; return helvCtx.measureText(s).width; };
function annotsPdf(d, p) {
  const R = effRot(p), vp1 = proxyOf(d, p).getViewport({scale: 1, rotation: R});
  return (d.annots[p.id] || []).flatMap(a => {
    if (a.t === 'hl') return {t: 'hl', r: a.r, c: a.c};
    if (a.t === 'hlt') return a.rs.map(r => ({t: 'hl', r, c: a.c}));
    if (a.t === 'ink') return {t: 'ink', p: a.p, w: a.w, c: a.c};
    if (a.t === 'sig') return a.s.map(p => ({t: 'ink', p, w: a.w, c: a.c}));
    if (a.t === 'text') {   // lines laid out in display space like notes, so the text reads upright on rotated pages
      const [vx, vy] = vp1.convertToViewportPoint(a.x, a.y);
      return {t: 'text', rot: R, c: a.c, size: a.size, font: a.font, bold: !!a.bold, lines: a.text.split('\n').map((text, k) => {
        const [x, y] = vp1.convertToPdfPoint(vx, vy + (TEXT_BASE + k * TEXT_LINE) * a.size);
        return {x, y, text};
      })};
    }
    // Notes are laid out in display space (scale 1) and mapped back, so they read upright on rotated pages.
    const [vx, vy] = vp1.convertToViewportPoint(a.x, a.y), lines = a.text.split('\n');
    const w = Math.max(...lines.map(l => helvWidth(l, NOTE.size))) + NOTE.pad * 2, h = lines.length * NOTE.line + NOTE.pad * 2;
    const [bx, by] = vp1.convertToPdfPoint(vx, vy + h);
    return {t: 'note', x: bx, y: by, w, h, rot: R, c: a.c, size: NOTE.size, lines: lines.map((text, k) => {
      const [x, y] = vp1.convertToPdfPoint(vx + NOTE.pad, vy + NOTE.pad + (k + 1) * NOTE.line - 3.5);
      return {x, y, text};
    })};
  });
}
async function buildPdf(d, onlyIds = null) {
  if (d === cur()) finishEditors();   // the note or text being typed belongs in the file
  // Files that needed a password to open keep their protection: they aren't re-saved unencrypted.
  if (d.sources.some(s => s.encrypted)) throw new Error('encrypted');
  const list = onlyIds ? d.pages.filter(p => onlyIds.has(p.id)) : d.pages;
  const pages = list.map(p => ({src: p.src, index: p.index, rot: effRot(p), annots: annotsPdf(d, p)}));
  const form = Object.entries(d.form || {}).map(([name, value]) => ({name, value}));
  return new Uint8Array(await invoke('pdf_build', {req: {sources: d.sources.map(s => s.rid), pages, form}}));
}
async function guardedBuild(d, onlyIds) {
  try { return await buildPdf(d, onlyIds); }
  catch (e) {
    if (/encrypt/i.test(e.message || '')) toast(t('toast.encrypted')); else toast(t('toast.saveFail', {e: e.message || e}));
    return null;
  }
}
async function save(as = false) {
  const d = cur(); if (!d) return;
  const unchanged = !d.dirty && !as && d.path;
  if (unchanged) return toast(t('toast.saved', {name: d.name}));
  const bytes = await guardedBuild(d); if (!bytes) return;
  try {
    const r = await writeBytes(bytes, {path: as ? null : d.path, name: d.name});
    if (!r) return;
    if (r.path) { d.path = r.path; d.name = r.name; recent = [{path: r.path, name: r.name}, ...recent.filter(x => x.path !== r.path)].slice(0, 10); }
    await reloadFrom(d, bytes);
    toast(t('toast.saved', {name: d.name}));
  } catch (e) { toast(t('toast.saveFail', {e: e.message || e})); }
}
/* After saving, the saved file becomes the document: edits are now part of its pages. */
async function reloadFrom(d, bytes) {
  const src = await loadPdf(bytes, d.name);
  forgetSources(d.sources);
  const current = d.current;
  Object.assign(d, {sources: [src], pages: pagesOf(src, 0), annots: {}, history: [], future: [], cleanDepth: 0, dirty: false,
    size: bytes.length, selected: new Set()});
  textCache.clear();
  if (d === cur()) {
    const keep = viewer.scrollTop;
    layout(); viewer.scrollTop = keep; d.current = Math.min(current, d.pages.length - 1);
    buildThumbs(); buildOutline(); buildProps();
  }
  renderTabs(); updateUI(); saveState();
}
async function extractPages() {
  const d = cur(); if (!d) return;
  const ids = targetIds(d), bytes = await guardedBuild(d, ids); if (!bytes) return;
  const name = d.name.replace(/\.pdf$/i, '') + (lang === 'de' ? '-Seiten.pdf' : '-pages.pdf');
  const r = await writeBytes(bytes, {name}).catch(e => toast(t('toast.saveFail', {e})));
  if (r) toast(t('toast.extracted', {n: ids.size, name: r.name}));
}
async function renderPdfPage(bytes, pageNo, scale) {
  const pdf = await pdfjsLib.getDocument({...PDF_OPTS, data: bytes}).promise;
  try {
    const page = await pdf.getPage(pageNo), vp = page.getViewport({scale});
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({canvasContext: ctx, viewport: vp}).promise;
    return {canvas: c, pdf};
  } catch (e) { pdf.destroy(); throw e; }
}
async function exportPng() {
  const d = cur(); if (!d) return;
  const pg = d.pages[d.current], bytes = await guardedBuild(d, new Set([pg.id])); if (!bytes) return;
  const {canvas, pdf} = await renderPdfPage(bytes, 1, 2 * CSS_UNITS);
  pdf.destroy();
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  const name = `${d.name.replace(/\.pdf$/i, '')}-${lang === 'de' ? 'Seite' : 'page'}-${d.current + 1}.png`;
  const r = await writeBytes(new Uint8Array(await blob.arrayBuffer()), {name, filter: 'PNG', ext: 'png', mime: 'image/png'})
    .catch(e => toast(t('toast.saveFail', {e})));
  if (r) toast(t('toast.exported', {name: r.path || r.name}));
}
async function printDoc() {
  const d = cur(); if (!d) return;
  const bytes = (await buildPdf(d).catch(() => null)) || d.sources[0].bytes;
  toast(t('toast.preparing', {n: d.pages.length}));
  const area = $('#printArea'); area.innerHTML = '';
  const pdf = await pdfjsLib.getDocument({...PDF_OPTS, data: bytes.slice()}).promise;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i), vp = page.getViewport({scale: 2});
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await page.render({canvasContext: c.getContext('2d'), viewport: vp}).promise;
    const img = new Image(); img.src = c.toDataURL('image/jpeg', 0.92); area.append(img);
  }
  pdf.destroy();
  setTimeout(() => (invoke ? invoke('print_page') : Promise.resolve(window.print())).catch(e => toast(t('toast.printFail', {e}))), 100);
}

/* ================= Thumbnails ================= */
let thumbQueue = Promise.resolve();
function buildThumbs() {
  const d = cur(); thumbsEl.innerHTML = '';
  if (!d) return;
  d.pages.forEach((pg, i) => {
    const el = document.createElement('div');
    el.className = 'thumb'; el.dataset.i = i; el.draggable = true; el.title = t('ui.dragHint');
    el.innerHTML = `<div class="tbox"></div><span class="thumb-num">${i + 1}</span>`;
    thumbsEl.append(el);
  });
  markThumbs(); renderThumbsVisible();
}
function markThumbs() {
  const d = cur(); if (!d) return;
  for (const el of thumbsEl.children) {
    const pg = d.pages[+el.dataset.i]; if (!pg) continue;
    el.classList.toggle('current', +el.dataset.i === d.current);
    el.classList.toggle('selected', d.selected.has(pg.id));
  }
  const curThumb = thumbsEl.children[d.current];
  if (curThumb && settings.dockTab === 'pages') {
    const r = curThumb.getBoundingClientRect(), box = dockBody.getBoundingClientRect();
    if (r.top < box.top + 40 || r.bottom > box.bottom) dockBody.scrollTop += r.top - box.top - box.height / 3;
  }
}
function renderThumbsVisible() {
  const d = cur(); if (!d || settings.dockTab !== 'pages' || !settings.dock) return;
  const box = dockBody.getBoundingClientRect();
  for (const el of thumbsEl.children) {
    const r = el.getBoundingClientRect();
    if (r.bottom < box.top - 300 || r.top > box.bottom + 300) continue;
    const pg = d.pages[+el.dataset.i], key = pg.id + ':' + pg.rot;
    if (el.dataset.key === key) continue;
    el.dataset.key = key;
    thumbQueue = thumbQueue.then(async () => {
      if (!el.isConnected || el.dataset.key !== key) return;
      const [w, h] = dispSize(pg, 1), s = Math.min(120 / w, 150 / h) * CSS_UNITS;
      const vp = proxyOf(d, pg).getViewport({scale: s * 1.5, rotation: effRot(pg)});
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      c.style.width = vp.width / 1.5 + 'px'; c.style.height = vp.height / 1.5 + 'px';
      try { await proxyOf(d, pg).render({canvasContext: c.getContext('2d'), viewport: vp}).promise; } catch (e) { return; }
      if (el.isConnected) el.querySelector('.tbox').replaceChildren(c);
    });
  }
}
dockBody.addEventListener('scroll', () => requestAnimationFrame(renderThumbsVisible));
let lastClicked = null, dragIds = null;
thumbsEl.addEventListener('click', e => {
  const el = e.target.closest('.thumb'); if (!el) return;
  const d = cur(), i = +el.dataset.i, id = d.pages[i].id;
  if (e.ctrlKey || e.metaKey) { d.selected.has(id) ? d.selected.delete(id) : d.selected.add(id); }
  else if (e.shiftKey && lastClicked != null) {
    const [a, b] = [Math.min(lastClicked, i), Math.max(lastClicked, i)];
    d.selected = new Set(d.pages.slice(a, b + 1).map(p => p.id));
  } else { d.selected = new Set(); goToPage(i); }
  if (!e.shiftKey) lastClicked = i;
  markThumbs(); updateUI();
});
thumbsEl.addEventListener('dragstart', e => {
  const el = e.target.closest('.thumb'); if (!el) return;
  const d = cur(), id = d.pages[+el.dataset.i].id;
  dragIds = d.selected.has(id) ? new Set(d.selected) : new Set([id]);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/x-pd-pages', [...dragIds].join(','));
  requestAnimationFrame(() => $$('.thumb').forEach(t2 => { if (dragIds.has(d.pages[+t2.dataset.i].id)) t2.classList.add('dragging'); }));
});
const clearDrop = () => $$('.thumb.drop-before,.thumb.drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after'));
thumbsEl.addEventListener('dragover', e => {
  if (!dragIds) return;
  const el = e.target.closest('.thumb'); if (!el) return;
  e.preventDefault(); e.stopPropagation();
  const r = el.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
  clearDrop(); el.classList.add(after ? 'drop-after' : 'drop-before');
});
thumbsEl.addEventListener('drop', e => {
  if (!dragIds) return;
  e.preventDefault(); e.stopPropagation();
  const el = e.target.closest('.thumb');
  if (el) {
    const r = el.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
    movePages(dragIds, +el.dataset.i + (after ? 1 : 0));
  }
  clearDrop();
});
thumbsEl.addEventListener('dragend', () => { dragIds = null; clearDrop(); $$('.thumb.dragging').forEach(x => x.classList.remove('dragging')); });

/* ================= Outline & properties ================= */
/* Bookmarks of the base document (from Rust: title, 0-based page or web link, children). */
function buildOutline() {
  const d = cur(), box = $('#outline'), outline = d && d.sources[0].info && d.sources[0].info.outline;
  if (!outline || !outline.length) { box.innerHTML = `<div class="empty">${esc(t('ui.noOutline'))}</div>`; return; }
  box.innerHTML = '';
  const add = (items, depth) => items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'ol-item'; el.textContent = item.title; el.title = item.title;
    el.style.paddingLeft = (8 + depth * 14) + 'px';
    el.onclick = () => outlineGo(item);
    box.append(el);
    if (item.items && item.items.length) add(item.items, depth + 1);
  });
  add(outline, 0);
}
function outlineGo(item) {
  const d = cur();
  if (item.url) return openUrl(item.url);
  // The page may have been moved or deleted since opening.
  const pos = d.pages.findIndex(p => p.src === 0 && p.index === item.page);
  if (pos >= 0) goToPage(pos);
}
/* Dates come from Rust as [year, month, day, hour, minute], or as the text when it isn't a PDF date. */
const pdfDate = v => !v ? '' : typeof v === 'string' ? v
  : new Date(v[0], v[1] - 1, v[2], v[3], v[4]).toLocaleString(lang, {dateStyle: 'medium', timeStyle: 'short'});
function buildProps() {
  const d = cur(), box = $('#props');
  if (!d) { box.innerHTML = ''; return; }
  const info = d.sources[0].info || {}, pg = d.pages[d.current] || d.pages[0];
  const sw = effRot(pg) % 180 !== 0, mm = v => Math.round(v * 25.4 / 72);
  const row = (k, v) => v ? `<div class="kv"><span>${esc(t(k))}</span><b title="${esc(v)}">${esc(v)}</b></div>` : '';
  box.innerHTML = `<div class="psec"><div class="psec-h">${esc(t('ui.file'))}</div>
    ${row('ui.title', d.name)}${row('ui.path', d.path || '')}${row('ui.fileSize', fmtSize(d.size))}
    ${row('ui.pageCount', String(d.pages.length))}${row('ui.pageSize', `${mm(sw ? pg.h : pg.w)} × ${mm(sw ? pg.w : pg.h)} mm`)}
    ${row('ui.version', info.version || '')}${row('ui.encrypted', t(info.encrypted || d.sources[0].encrypted ? 'ui.yes' : 'ui.no'))}</div>
    <div class="psec" style="border:0"><div class="psec-h">${esc(t('ui.document'))}</div>
    ${row('ui.title', info.title || '')}${row('ui.author', info.author || '')}${row('ui.subject', info.subject || '')}
    ${row('ui.creator', info.creator || '')}${row('ui.producer', info.producer || '')}
    ${row('ui.created', pdfDate(info.created))}${row('ui.modified', pdfDate(info.modified))}</div>`;
}

/* ================= Search ================= */
const textCache = new Map();
const find = {q: '', hits: [], i: -1};
async function pageText(d, pg) {
  const k = `${d.id}:${pg.src}:${pg.index}`;
  if (!textCache.has(k)) {
    const tc = await proxyOf(d, pg).getTextContent();
    textCache.set(k, tc.items.map(it => it.str + (it.hasEOL ? '\n' : '')).join('').toLowerCase());
  }
  return textCache.get(k);
}
let findT, findRun = 0;
async function runFind() {
  const d = cur(), q = $('#findIn').value.trim().toLowerCase(), run = ++findRun;
  find.q = q; find.hits = []; find.i = -1;
  if (!d || !q) { $('#fCount').textContent = ''; markAllHits(); return; }
  $('#fCount').textContent = t('find.searching');
  for (let i = 0; i < d.pages.length; i++) {
    const txt = await pageText(d, d.pages[i]);
    if (run !== findRun) return;
    for (let pos = txt.indexOf(q); pos >= 0; pos = txt.indexOf(q, pos + q.length)) find.hits.push(i);
  }
  $('#fCount').textContent = find.hits.length ? t('find.found', {n: find.hits.length}) : t('find.none');
  markAllHits();
}
function findStep(back = false) {
  if (!find.hits.length) return;
  const d = cur();
  if (find.i < 0) {
    const from = d.current;
    find.i = back ? find.hits.map((p, k) => [p, k]).filter(([p]) => p <= from).pop()?.[1] ?? find.hits.length - 1
      : Math.max(0, find.hits.findIndex(p => p >= from));
  } else find.i = (find.i + (back ? -1 : 1) + find.hits.length) % find.hits.length;
  goToPage(find.hits[find.i]);
  $('#fCount').textContent = t('find.count', {i: find.i + 1, n: find.hits.length});
  markAllHits();
}
function markHits(el) {
  const q = find.q, curPage = find.i >= 0 ? find.hits[find.i] : -1;
  el.querySelectorAll('.textLayer span').forEach(s => {
    const hit = !!q && s.textContent.toLowerCase().includes(q);
    s.classList.toggle('hit', hit);
    s.classList.toggle('current', hit && +el.dataset.i === curPage);
  });
}
const markAllHits = () => { for (const el of pagesEl.children) markHits(el); };
function openFind() { $('#findbar').classList.add('show'); $('#findIn').focus(); $('#findIn').select(); }
function closeFind() { $('#findbar').classList.remove('show'); find.q = ''; find.hits = []; markAllHits(); viewer.focus({preventScroll: true}); }
$('#findIn').addEventListener('input', () => { clearTimeout(findT); findT = setTimeout(runFind, 250); });
$('#findIn').addEventListener('keydown', async e => {
  if (e.key === 'Enter') { e.preventDefault(); if (find.q !== $('#findIn').value.trim().toLowerCase()) await runFind(); findStep(e.shiftKey); }
});
$('#fNext').onclick = () => findStep(); $('#fPrev').onclick = () => findStep(true); $('#fClose').onclick = closeFind;

/* ================= UI state ================= */
function updatePageUI() {
  const d = cur(), n = d ? d.pages.length : 0;
  const pin = $('#pageIn');
  if (document.activeElement !== pin) pin.value = d ? d.current + 1 : '';
  $('#pageTotal').textContent = '/ ' + n;
  $('#stPage').textContent = d ? t('ui.pageOf', {p: d.current + 1, n}) : '';
}
function updateUI() {
  const d = cur();
  $('#apptitle').textContent = d ? `${d.name}${d.dirty ? ' ●' : ''}  —  PDF Studio` : 'PDF Studio';
  document.title = d ? `${d.dirty ? '● ' : ''}${d.name} — PDF Studio` : 'PDF Studio';
  const st = $('#stState');
  st.className = 'st-state' + (d && d.dirty ? ' dirty' : '');
  st.textContent = d ? (d.dirty ? t('st.dirty') : t('st.saved')) : '';
  $('#stSel').textContent = d && d.selected.size > 1 ? t('ui.selected', {n: d.selected.size}) : '';
  $('#stSize').textContent = d ? fmtSize(d.size) : '';
  $('#ctaSave').disabled = !d;
  $$('[data-needs-doc]').forEach(b => b.disabled = !d);
  ['zoomSel', 'pageIn', 'zOutBtn', 'zInBtn', 'prevBtn', 'nextBtn'].forEach(id => $('#' + id).disabled = !d);
  updatePageUI(); updateZoomUI();
}
$('#pageIn').addEventListener('keydown', e => {
  if (e.key === 'Enter') { goToPage((parseInt(e.target.value, 10) || 1) - 1); viewer.focus({preventScroll: true}); }
});
$('#pageIn').addEventListener('blur', updatePageUI);

/* ================= Menus, toolbars, shortcuts ================= */
const ICONS = {
  open: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8M7 21v-7h10v7"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
  redo: '<svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  select: '<svg viewBox="0 0 24 24"><path d="M5 3l14 8-6 2-2 6z"/></svg>',
  hand: '<svg viewBox="0 0 24 24"><path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>',
  highlight: '<svg viewBox="0 0 24 24"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/></svg>',
  text: '<svg viewBox="0 0 24 24"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>',
  bold: '<svg viewBox="0 0 24 24"><path d="M7 4h7a4 4 0 0 1 0 8H7zM7 12h8a4 4 0 0 1 0 8H7z"/></svg>',
  sign: '<svg viewBox="0 0 24 24"><path d="M3 17c2-3 3.5-7 5-7s.5 6 2 6 2.5-4 4-4 1 3 2.5 3S19 13 21 12"/><path d="M3 21h18"/></svg>',
  erase: '<svg viewBox="0 0 24 24"><path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 19"/><path d="M22 21H7M5 11l9 9"/></svg>',
  rotL: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  rotR: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
  extract: '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 18v-6M9 15l3 3 3-3"/></svg>',
  blank: '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M17 15v6M14 18h6" stroke-width="2.2"/></svg>',
  insert: '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 12v6M9 15h6"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  print: '<svg viewBox="0 0 24 24"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7"/></svg>',
  panel: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  help: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/></svg>'
};
const needsDoc = fn => () => cur() && fn();
const A = {
  toggleAutoHide: () => { settings.autoHide = !settings.autoHide; applySettings(); },
  openFile: async () => openFiles(await pickFiles()),
  insertPdf: needsDoc(() => insertPdf()), insertBlank: needsDoc(() => blankDialog()), save: needsDoc(() => save(false)), saveAs: needsDoc(() => save(true)),
  exportPng: needsDoc(exportPng), print: needsDoc(printDoc), closeTab: needsDoc(() => closeTab(active)),
  undo: () => undoRedo(false), redo: () => undoRedo(true),
  find: needsDoc(openFind), findNext: needsDoc(() => findStep()),
  selectAllPages: needsDoc(() => { const d = cur(); d.selected = new Set(d.pages.map(p => p.id)); markThumbs(); updateUI(); }),
  rotateLeft: () => rotatePages(-90), rotateRight: () => rotatePages(90), deletePages, extractPages: needsDoc(extractPages),
  firstPage: () => goToPage(0), prevPage: () => cur() && goToPage(cur().current - 1),
  nextPage: () => cur() && goToPage(cur().current + 1), lastPage: () => cur() && goToPage(cur().pages.length - 1),
  toolSelect: () => setTool('select'), toolHand: () => setTool('hand'), toolHighlight: () => {   // with text selected, M highlights it right away
    const r = tool === 'select' && selectionRange();
    if (r) { highlightRange(r); getSelection().removeAllRanges(); } else setTool('highlight');
  },
  highlightSelection: () => {
    const r = selectionRange();
    if (!r) return toast(t('toast.noSelection'));
    highlightRange(r); getSelection().removeAllRanges();
  },
  toolPen: () => setTool('pen'), toolNote: () => setTool('note'), toolText: () => setTool('text'), toolSign: () => setTool('sign'),
  signEdit: () => signaturePad(() => setTool('sign')),
  textBold: () => { settings.textBold = !settings.textBold; syncTextOpts(); saveState(); if (textEd) textEd.style(); }, toolErase: () => setTool('erase'),
  fitWidth: () => setZoom('fit-width'), fitPage: () => setZoom('fit-page'), actualSize: () => setZoom(1),
  zoomIn: () => zoomStep(1), zoomOut: () => zoomStep(-1),
  togglePanels: () => { settings.dock = !settings.dock; applySettings(); },
  toggleInvert: () => { settings.invert = !settings.invert; applySettings(); },
  settings: () => openSettings(),
  langAuto: () => setPref('lang', 'auto'), langEn: () => setPref('lang', 'en'), langDe: () => setPref('lang', 'de'),
  themeDark: () => setPref('theme', 'dark'), themeLight: () => setPref('theme', 'light'),
  themeGithub: () => setPref('theme', 'github'), themeGithubDark: () => setPref('theme', 'github-dark'),
  shortcuts: () => {
    let h = '';
    MENUS.forEach(([m, items]) => {
      const rows = items.filter(it => Array.isArray(it) && it[1]);
      if (rows.length) h += `<h4>${esc(t('menu.' + m))}</h4><table>` +
        rows.map(it => `<tr><td>${esc(t('a.' + it[0]))}</td><td><kbd>${esc(fmtKey(it[1]))}</kbd></td></tr>`).join('') + '</table>';
    });
    h += `<h4>${esc(t('a.shortcuts'))}</h4><table>
      <tr><td>${t('sc.wheel')}</td><td>${t('sc.wheelKey')}</td></tr>
      <tr><td>${t('sc.drag')}</td><td>${t('sc.dragKey')}</td></tr>
      <tr><td>${t('sc.multi')}</td><td>${t('sc.multiKey')}</td></tr></table>`;
    modal(t('a.shortcuts'), h);
  },
  about: async () => {
    const v = invoke ? await window.__TAURI__.app.getVersion().catch(() => '') : '';
    modal(t('a.about'), `${v ? `<p><b>${t('about.version', {v: esc(v)})}</b></p>` : ''}<p>${t('about.p1')}</p><p>${t('about.p2')}</p><p>${t('about.p3')}</p>`);
  }
};
// [action, shortcut, checked(), letterKey]; '-' separator, '#key' section label.
const MENUS = [
  ['file', [['openFile', 'Ctrl+O'], ['insertPdf', 'Ctrl+Shift+O'], '-', ['save', 'Ctrl+S'], ['saveAs', 'Ctrl+Shift+S'], '-',
    ['exportPng', 'Ctrl+E'], ['print', 'Ctrl+P'], '-', ['closeTab', 'Alt+W']]],
  ['edit', [['undo', 'Ctrl+Z'], ['redo', 'Ctrl+Y'], '-', ['find', 'Ctrl+F'], ['findNext', 'F3'], '-', ['selectAllPages']]],
  ['pages', [['rotateLeft', 'Ctrl+Shift+R'], ['rotateRight', 'Ctrl+R'], ['deletePages', 'Delete', null, true], ['extractPages', 'Ctrl+Shift+E'], ['insertBlank', 'Ctrl+Shift+N'], '-',
    ['firstPage', 'Ctrl+Home'], ['prevPage', 'Ctrl+PageUp'], ['nextPage', 'Ctrl+PageDown'], ['lastPage', 'Ctrl+End']]],
  ['tools', [['toolSelect', 'V', () => tool === 'select', true], ['toolHand', 'H', () => tool === 'hand', true], '-',
    ['toolHighlight', 'M', () => tool === 'highlight', true], ['toolPen', 'P', () => tool === 'pen', true],
    ['toolText', 'T', () => tool === 'text', true], ['toolNote', 'N', () => tool === 'note', true], ['toolSign', 'S', () => tool === 'sign', true], ['signEdit'],
    ['toolErase', 'E', () => tool === 'erase', true], '-',
    ['textBold', 'Ctrl+B', () => settings.textBold], ['highlightSelection', 'Ctrl+Shift+H']]],
  ['view', [['fitWidth', 'Ctrl+1', () => cur() && cur().zoomMode === 'fit-width'], ['fitPage', 'Ctrl+2', () => cur() && cur().zoomMode === 'fit-page'],
    ['actualSize', 'Ctrl+0'], ['zoomIn', 'Ctrl+='], ['zoomOut', 'Ctrl+-'], '-',
    ['togglePanels', 'Ctrl+\\', () => settings.dock], ['toggleAutoHide', null, () => settings.autoHide], ['toggleInvert', 'Ctrl+Shift+I', () => settings.invert]]],
  ['settings', [['settings', 'Ctrl+,'], '-', '#menu.language',
    ['langAuto', null, () => settings.lang === 'auto'], ['langEn', null, () => settings.lang === 'en'], ['langDe', null, () => settings.lang === 'de'],
    '-', '#menu.theme',
    ['themeDark', null, () => settings.theme === 'dark'], ['themeLight', null, () => settings.theme === 'light'],
    ['themeGithub', null, () => settings.theme === 'github'], ['themeGithubDark', null, () => settings.theme === 'github-dark']]],
  ['help', [['shortcuts'], '-', ['about']]]
];
const KEYMAP = {}, LETTERS = {};
/* Built from the menu entries — again whenever a shortcut is changed in Settings (shortcuts.js). */
function buildKeymap() {
  for (const m of [KEYMAP, LETTERS]) for (const k in m) delete m[k];
  MENUS.forEach(([, items]) => items.forEach(it => { if (Array.isArray(it) && it[1]) (it[3] ? LETTERS : KEYMAP)[it[1]] = it[0]; }));
}
buildKeymap();

let menuOpen = null;
function openMenu(m, items) {
  closeMenus();
  const dd = m.querySelector('.dropdown'); dd.innerHTML = '';
  items.forEach(it => {
    if (it === '-') return dd.append(document.createElement('hr'));
    if (typeof it === 'string') { const l = document.createElement('div'); l.className = 'dd-label'; l.textContent = t(it.slice(1)); return dd.append(l); }
    const [act, key, check] = it, b = document.createElement('button');
    b.innerHTML = `<span class="chk">${check && check() ? '&#10003;' : ''}</span><span>${esc(t('a.' + act))}</span><kbd>${esc(key ? fmtKey(key) : '')}</kbd>`;
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => { closeMenus(); A[act](); };
    dd.append(b);
  });
  m.classList.add('open'); menuOpen = m;
}
function closeMenus() { $$('.menu.open').forEach(x => x.classList.remove('open')); menuOpen = null; }
function buildMenubar() {
  const nav = $('#menus'); nav.innerHTML = ''; menuOpen = null;
  MENUS.forEach(([name, items]) => {
    const m = document.createElement('div'), b = document.createElement('button'), dd = document.createElement('div');
    m.className = 'menu'; dd.className = 'dropdown'; b.textContent = t('menu.' + name);
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => menuOpen === m ? closeMenus() : openMenu(m, items);
    b.onmouseenter = () => { if (menuOpen && menuOpen !== m) openMenu(m, items); };
    m.append(b, dd); nav.append(m);
  });
}
document.addEventListener('mousedown', e => { if (menuOpen && !e.target.closest('.menu')) closeMenus(); });
const keyOf = act => { for (const [, items] of MENUS) for (const it of items) if (Array.isArray(it) && it[0] === act && it[1]) return it[1]; return ''; };
const tip = act => t('a.' + act) + (keyOf(act) ? ` (${fmtKey(keyOf(act))})` : '');
function makeBtn(act, html, extra = {}) {
  const b = document.createElement('button');
  b.className = 'ibtn'; b.innerHTML = html; b.title = tip(act); b.dataset.act = act;
  Object.entries(extra).forEach(([k, v]) => b.dataset[k] = v);
  return b;
}
function buildToolbars() {
  const fill = (id, list) => { const box = $(id); box.innerHTML = ''; list.forEach(([a, i, x]) => box.append(makeBtn(a, i, x))); };
  fill('#fileBtns', [['openFile', ICONS.open], ['save', ICONS.save, {needsDoc: 1}], ['undo', ICONS.undo, {needsDoc: 1}],
    ['redo', ICONS.redo, {needsDoc: 1}], ['find', ICONS.search, {needsDoc: 1}]]);
  fill('#viewBtns', [['toggleInvert', ICONS.moon], ['print', ICONS.print, {needsDoc: 1}], ['togglePanels', ICONS.panel], ['settings', ICONS.gear], ['shortcuts', ICONS.help]]);
  fill('#pageTools', [['rotateLeft', ICONS.rotL, {needsDoc: 1}], ['rotateRight', ICONS.rotR, {needsDoc: 1}], ['deletePages', ICONS.trash, {needsDoc: 1}],
    ['extractPages', ICONS.extract, {needsDoc: 1}], ['insertPdf', ICONS.insert, {needsDoc: 1}], ['insertBlank', ICONS.blank, {needsDoc: 1}]]);
  const tools = $('#tools'); tools.innerHTML = '';
  [['toolSelect', 'select'], ['toolHand', 'hand'], '-', ['toolHighlight', 'highlight'], ['toolPen', 'pen'], ['toolText', 'text'], ['toolNote', 'note'], ['toolSign', 'sign'], ['toolErase', 'erase'], '-']
    .forEach(r => {
      if (r === '-') { const s = document.createElement('div'); s.className = 'sep'; return tools.append(s); }
      tools.append(makeBtn(r[0], ICONS[r[1]], {tool: r[1]}));
    });
  tools.append(makeBtn('rotateLeft', ICONS.rotL, {needsDoc: 1}), makeBtn('rotateRight', ICONS.rotR, {needsDoc: 1}), makeBtn('deletePages', ICONS.trash, {needsDoc: 1}));
  $$('[data-needs-doc]').forEach(b => b.setAttribute('data-needs-doc', ''));
  $('#swatches').innerHTML = COLORS.map(c => `<button class="swatch${c === settings.color ? ' active' : ''}" data-color="${c}" style="background:${c}" title="${esc(t('ui.color'))} ${c}"></button>`).join('');
  $('#textOpts').innerHTML = `<select id="textFont" title="${esc(t('ui.font'))}">${Object.keys(TEXT_FONTS).map(f => `<option value="${f}">${FONT_NAMES[f]}</option>`).join('')}</select>` +
    `<select id="textSize" title="${esc(t('ui.fontSize'))}">${TEXT_SIZES.map(s => `<option value="${s}">${s} pt</option>`).join('')}</select>`;
  $('#textOpts').append(makeBtn('textBold', ICONS.bold));
  syncTextOpts();
  $('#zOutBtn').title = tip('zoomOut'); $('#zInBtn').title = tip('zoomIn');
  $('#prevBtn').title = tip('prevPage'); $('#nextBtn').title = tip('nextPage');
}
document.addEventListener('mousedown', e => { if (e.target.closest('.ibtn,.cta,.swatch')) e.preventDefault(); });
document.addEventListener('click', e => {
  const sw = e.target.closest('[data-color]');
  if (sw) { settings[colorKey()] = sw.dataset.color; syncTextOpts(); saveState(); if (textEd) textEd.style(); return; }
  const b = e.target.closest('[data-act]'); if (b && !b.disabled) A[b.dataset.act]();
});
$$('#dockTabs button').forEach(b => b.onclick = () => { settings.dock = true; settings.dockTab = b.dataset.tab; applySettings(); });

function comboOf(e) {
  let k = e.key;
  if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  else if (e.code === 'Minus') k = '-';
  else if (e.code === 'Equal' || e.code === 'NumpadAdd' || k === '+') k = '=';
  else if (e.code === 'NumpadSubtract') k = '-';
  else if (e.code === 'Comma') k = ',';
  else if (e.code === 'Backslash' || e.code === 'IntlBackslash') k = '\\';
  else if (k.length === 1) k = k.toUpperCase();
  return (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.altKey ? 'Alt+' : '') + k;
}
const typing = () => { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable); };
window.addEventListener('keydown', e => {
  if (window.Shortcuts && Shortcuts.recording) return;   // Settings → Shortcuts is taking a key
  if (e.key === 'Escape') {
    if (textEd) return textEd.commit(false);   // cancels the text being written
    if ($('#modal').classList.contains('show')) $('#modalClose').click();   // also cancels a password prompt
    else if (menuOpen) closeMenus();
    else if ($('#findbar').classList.contains('show')) closeFind();
    else if (tool !== 'select') setTool('select');
    return;
  }
  if (e.key === 'F5' || (e.ctrlKey && e.key.toLowerCase() === 'r' && !KEYMAP[comboOf(e)])) { e.preventDefault(); return; }  // no accidental reload
  if (e.ctrlKey && e.altKey) return; // AltGr on international keyboards types characters
  const combo = comboOf(e);
  if (!typing() && LETTERS[combo]) { e.preventDefault(); return A[LETTERS[combo]](); }
  const act = KEYMAP[combo];
  if (act && !(typing() && ['undo', 'redo'].includes(act))) { e.preventDefault(); e.stopPropagation(); A[act](); }
}, true);

/* ================= Modal, toast, settings ================= */
function modal(title, html, buttons = null) {
  $('.modal').classList.remove('wide'); settingsOpen = false;
  $('#modalTitle').textContent = title; $('#modalBody').innerHTML = html;
  const foot = $('#modalFoot');
  foot.hidden = !buttons; foot.innerHTML = '';
  if (buttons) {
    foot.append(Object.assign(document.createElement('span'), {className: 'flex'}));
    buttons.forEach(b => { const el = document.createElement('button'); el.className = 'btn-sm' + (b.primary ? ' primary' : ''); el.textContent = b.label; el.onclick = b.onClick; foot.append(el); });
  }
  $('#modal').classList.add('show');
}
function closeModal() { $('#modal').classList.remove('show'); settingsOpen = false; }
$('#modalClose').onclick = () => { const cancel = $('#modalFoot').querySelector('.btn-sm:not(.primary)'); cancel && !settingsOpen ? cancel.click() : closeModal(); };
let toastT;
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2600); }
async function ask(message, okLabel) {
  return invoke ? invoke('confirm', {title: t('confirm.title'), message, okLabel, cancelLabel: t('confirm.cancel')}) : confirm(message);
}
function openUrl(url) {
  if (invoke) invoke('open_url', {url}).catch(e => toast(t('toast.linkFail', {e})));
  else window.open(url, '_blank', 'noopener');
}
document.addEventListener('click', e => {
  const a = e.target.closest('.modal-body a[href^="http"]'); if (!a) return;
  e.preventDefault(); openUrl(a.href);
});

let settingsOpen = false, prefsSection = 'general';
function setPref(k, v) { settings[k] = v; applySettings(); }
function openSettings() {
  $('#modalFoot').hidden = false;
  renderSettings();
  $('.modal').classList.add('wide'); settingsOpen = true;
  $('#modal').classList.add('show');
}
function renderSettings() {
  const opt = (v, label, curV) => `<option value="${v}"${v === curV ? ' selected' : ''}>${esc(label)}</option>`;
  const sw = (name, label) => `<label class="switch"><input type="checkbox" data-sw="${name}"${settings[name] ? ' checked' : ''}><span></span>${esc(label)}</label>`;
  const mock = th => `<div class="tc-mock" data-theme="${th}"><div class="tc-bar"><i></i><i></i><i></i><b></b></div>
    <div class="tc-body"><div class="tc-rail"></div><div class="tc-pv"><div class="tc-paper"><i></i><i></i><i style="width:80%"></i><i style="width:60%"></i><i style="width:90%"></i></div></div>
    <div class="tc-dock"><i></i><i></i><i></i></div></div></div>`;
  const body = {
    keys: `<div id="keysBox"></div>`,
    general: `<h3>${t('set.language')}</h3><p class="hint">${t('set.languageHint')}</p>
      <select class="wide-sel" data-sel="lang">${opt('auto', t('a.langAuto'), settings.lang)}${opt('en', 'English', settings.lang)}${opt('de', 'Deutsch', settings.lang)}</select>
      <h3>${t('set.layout')}</h3>${sw('dock', t('set.panels'))}${sw('autoHide', t('set.autoHide'))}${sw('reopen', t('set.reopen'))}`,
    appearance: `<h3>${t('set.theme')}</h3><div class="theme-grid">` + THEMES.map(th =>
        `<button class="theme-card${settings.theme === th ? ' active' : ''}" data-theme-pick="${th}">${mock(th)}
         <div class="theme-name">${esc(t('theme.' + th))}<span>${settings.theme === th ? '&#10003;' : ''}</span></div></button>`).join('') +
      `</div><h3>${t('set.reading')}</h3>${sw('invert', t('set.invert'))}`,
    viewer: `<h3>${t('set.defaultZoom')}</h3><select class="wide-sel" data-sel="zoomMode">${opt('fit-width', t('ui.fitWidthOpt'), settings.zoomMode)}${opt('fit-page', t('ui.fitPageOpt'), settings.zoomMode)}${opt('actual', '100 %', settings.zoomMode)}</select>
      <h3>${t('set.spell')}</h3><p class="hint">${t('set.spellHint')}</p><select class="wide-sel" data-sel="spell">${opt('auto', t('set.spellAuto'), settings.spell)}${opt('de', 'Deutsch', settings.spell)}${opt('en', 'English', settings.spell)}${opt('off', t('set.spellOff'), settings.spell)}</select>`
  };
  $('#modalTitle').textContent = t('set.title');
  $('#modalBody').innerHTML = `<div class="prefs"><nav>${['general', 'appearance', 'viewer', 'keys'].map(k =>
    `<button data-sec="${k}" class="${k === prefsSection ? 'active' : ''}">${esc(t('set.' + k))}</button>`).join('')}</nav><section>${body[prefsSection]}</section></div>`;
  if (prefsSection === 'keys') mountKeys();
  $('#modalFoot').innerHTML = `<button class="btn-sm" data-pref="reset">${esc(t('set.reset'))}</button><span class="flex"></span>
    <button class="btn-sm primary" data-pref="done">${esc(t('set.done'))}</button>`;
}
$('#modal').addEventListener('click', e => {
  if (!settingsOpen) return;
  const el = e.target.closest('[data-sec],[data-theme-pick],[data-pref]'); if (!el) return;
  if (el.dataset.sec) prefsSection = el.dataset.sec;
  else if (el.dataset.themePick) settings.theme = el.dataset.themePick;
  else if (el.dataset.pref === 'done') return closeModal();
  else if (el.dataset.pref === 'reset') { settings = {...DEF}; toast(t('set.resetDone')); }
  applySettings(); renderSettings();
});
$('#modal').addEventListener('change', e => {
  if (!settingsOpen) return;
  const d = e.target.dataset;
  if (d.sel) { settings[d.sel] = e.target.value; applySettings(); renderSettings(); }
  if (d.sw) { settings[d.sw] = e.target.checked; applySettings(); }
});
$('#modal').onmousedown = e => { if (e.target.id === 'modal' && settingsOpen) closeModal(); };

function applyLanguage() {
  document.documentElement.lang = lang;
  $$('[data-i18n]').forEach(el => el.textContent = t(el.dataset.i18n));
  $$('[data-i18n-ph]').forEach(el => el.placeholder = t(el.dataset.i18nPh));
  $$('[data-i18n-title]').forEach(el => el.title = t(el.dataset.i18nTitle));
  buildMenubar(); buildToolbars();
  if (booted) { renderTabs(); buildThumbs(); buildOutline(); buildProps(); renderRecent(); updateUI(); setTool(tool); }
}
let appliedKeys = '{}';
/* Settings → Shortcuts: change a key by pressing it (shortcuts.js). */
function mountKeys() {
  Shortcuts.editor($('#keysBox'), {MENUS, keys: settings.keys || {}, t, fmtKey, comboOf, label: a => t('a.' + a),
    onChange: keys => { settings.keys = keys; applySettings(); }});
}
function applySettings() {
  if (window.AutoHide) AutoHide.set(settings.autoHide);
  if (window.Shortcuts && JSON.stringify(settings.keys || {}) !== appliedKeys) {
    appliedKeys = JSON.stringify(settings.keys || {});
    Shortcuts.apply(MENUS, settings.keys || {}); buildKeymap();
    if (typeof buildToolbars === 'function' && document.querySelector('#menus')) buildToolbars();
  }
  if (!THEMES.includes(settings.theme)) settings.theme = 'dark';
  const nl = effectiveLang();
  if (nl !== lang) { lang = nl; applyLanguage(); }
  document.documentElement.dataset.theme = settings.theme;
  document.body.classList.toggle('invert', settings.invert);
  $('#dock').classList.toggle('hidden', !settings.dock);
  $$('#dockTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === settings.dockTab));
  $$('.dpanel').forEach(p => p.classList.toggle('active', p.dataset.panel === settings.dockTab));
  $$('[data-act="toggleInvert"]').forEach(b => b.classList.toggle('active', settings.invert));
  if (booted && cur() && cur().zoomMode !== 'custom') requestAnimationFrame(() => setZoom(cur().zoomMode));
  requestAnimationFrame(renderThumbsVisible);
  saveState();
}

/* ================= Drag & drop files ================= */
let dragDepth = 0;
const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; $('#drop').classList.add('show'); } });
window.addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#drop').classList.remove('show'); } });
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', async e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('#drop').classList.remove('show');
  const list = [];
  for (const f of e.dataTransfer.files) {
    if (/\.pdf$/i.test(f.name)) list.push({name: f.name, size: f.size, path: null, bytes: new Uint8Array(await f.arrayBuffer())});
    else toast(t('toast.skipped', {name: f.name}));
  }
  openFiles(list);
});

/* ================= Native right-click menus (see native.js) ================= */
if (window.Native) {
  const item = (act, extra = {}) => ({id: act, label: t('a.' + act), accel: keyOf(act) || null, enabled: !!cur(), ...extra});
  const ctx = {tab: -1, ann: null};
  Native.setProvider(e => {
    if (e.target.classList && e.target.classList.contains('note-edit')) {
      const sp = window.SpellField && SpellField.menu(e, t);
      if (sp) return sp.then(items => [...items, null, ...Native.fieldItems(e.target)]);
      return null;
    }
    const tab = e.target.closest('.tab');
    if (tab) {
      ctx.tab = [...$('#tabs').children].indexOf(tab);
      return [{id: 'tab:close', label: t('a.closeTab'), accel: 'Alt+W'}, {id: 'tab:others', label: t('ctx.closeOthers'), enabled: docs.length > 1}];
    }
    const d = cur(); if (!d) return null;
    const th = e.target.closest('.thumb');
    if (th) {
      const i = +th.dataset.i, id = d.pages[i].id;
      if (!d.selected.has(id)) d.selected = new Set([id]);
      d.current = i; markThumbs(); updateUI();
      return [item('rotateLeft'), item('rotateRight'), item('deletePages'), null, item('extractPages'), item('insertPdf'), item('insertBlank')];
    }
    const pg = e.target.closest('.page');
    if (pg) {
      const i = +pg.dataset.i;
      if (!d.selected.has(d.pages[i].id)) d.selected = new Set();
      d.current = i; markThumbs(); updatePageUI();
      const k = annotAt(pg, e.clientX, e.clientY), ann = k >= 0;
      ctx.ann = ann ? {pg: pg._pg, k} : null;
      return [Native.copyTextItem(), ...(selectionRange() ? [item('highlightSelection')] : []), ...(ann ? [null, {id: 'ctx:delAnn', label: t('ctx.deleteAnnot')}] : []), null,
        item('rotateLeft'), item('rotateRight'), item('deletePages'), item('exportPng'), null,
        ...['select', 'hand', 'highlight', 'pen', 'text', 'note', 'sign'].map(n => item(TOOL_ACT[n], {checked: tool === n}))];
    }
    return null;
  });
  Native.setHandler(async id => {
    if (id.startsWith('spf:')) return SpellField.action(id);
    if (id === 'tab:close') return closeTab(ctx.tab);
    if (id === 'tab:others') { const keep = docs[ctx.tab]; for (const x of [...docs]) if (x !== keep) await closeTab(docs.indexOf(x)); return; }
    if (id === 'ctx:delAnn' && ctx.ann) { const d = cur(); pushHistory(d); d.annots[ctx.ann.pg.id].splice(ctx.ann.k, 1); changed(); return; }
    if (A[id]) A[id]();
  });
}

/* ================= Boot ================= */
(async function boot() {
  if (invoke) I18N = await invoke('texts');
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE)); } catch (e) {}
  if (saved) { settings = {...DEF, ...saved.settings}; recent = saved.recent || []; }
  lang = effectiveLang();
  applyLanguage();
  booted = true;
  applySettings(); setTool('select'); renderTabs(); renderRecent(); updateUI();
  if (invoke) {
    window.__TAURI__.window.getCurrentWindow().onCloseRequested(async ev => {
      finishEditors(); saveState();
      if (docs.some(d => d.dirty) && !await ask(t('confirm.quit'), t('confirm.quitOk'))) ev.preventDefault();
    });
    window.__TAURI__.event.listen('open-files', e => openFiles(e.payload));
    const reopen = settings.reopen && saved && saved.open ? saved.open : [];
    for (const path of reopen) {
      const name = path.split(/[\\/]/).pop();
      try { await openFileInfo({path, name, bytes: await readPath(path)}); } catch (e) {}
    }
    if (saved && saved.active) { const i = docs.findIndex(d => d.path === saved.active); if (i >= 0) activate(i); }
    openFiles(await invoke('initial_files'));
  }
})();

// Exposed for automated UI tests in a browser.
window.__pd = {insertBlank, blankDialog, highlightRange, selectionRange, openNoteEditor, openTextEditor, textDown, getTextEd: () => textEd, settings: () => settings, openFiles, A, cur, buildPdf, setZoom, goToPage, addAnnot, annotAt, movePages, deletePages, rotatePages, insertPdf, undoRedo,
  find, runFind, findStep, settings: () => settings, pdfjsLib, PDF_OPTS};
