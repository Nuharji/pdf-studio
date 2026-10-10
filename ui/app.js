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
const I18N = {
  en: {
    'menu.file': 'File', 'menu.edit': 'Edit', 'menu.pages': 'Pages', 'menu.tools': 'Tools', 'menu.view': 'View',
    'menu.settings': 'Settings', 'menu.help': 'Help', 'menu.language': 'Language', 'menu.theme': 'Theme',
    'a.openFile': 'Open…', 'a.insertPdf': 'Insert PDF…', 'a.save': 'Save', 'a.saveAs': 'Save As…',
    'a.exportPng': 'Export Page as PNG…', 'a.print': 'Print…', 'a.closeTab': 'Close Tab',
    'a.undo': 'Undo', 'a.redo': 'Redo', 'a.find': 'Find', 'a.findNext': 'Find Next', 'a.selectAllPages': 'Select All Pages',
    'a.rotateLeft': 'Rotate Left', 'a.rotateRight': 'Rotate Right', 'a.deletePages': 'Delete Pages', 'a.extractPages': 'Extract Pages…',
    'a.firstPage': 'First Page', 'a.prevPage': 'Previous Page', 'a.nextPage': 'Next Page', 'a.lastPage': 'Last Page',
    'a.toolSelect': 'Select Text', 'a.toolHand': 'Hand', 'a.toolHighlight': 'Highlighter', 'a.toolPen': 'Pen',
    'a.toolNote': 'Text Note', 'a.toolErase': 'Eraser',
    'a.fitWidth': 'Fit Width', 'a.fitPage': 'Fit Page', 'a.actualSize': 'Actual Size', 'a.zoomIn': 'Zoom In', 'a.zoomOut': 'Zoom Out',
    'a.togglePanels': 'Panels', 'a.toggleInvert': 'Dark Pages', 'a.settings': 'Preferences…',
    'a.langAuto': 'System language', 'a.langEn': 'English', 'a.langDe': 'Deutsch',
    'a.themeDark': 'Dark', 'a.themeLight': 'Light', 'a.themeGithub': 'GitHub', 'a.themeGithubDark': 'GitHub Dark',
    'a.shortcuts': 'Keyboard Shortcuts', 'a.about': 'About PDF Studio',
    'theme.dark': 'Dark', 'theme.light': 'Light', 'theme.github': 'GitHub', 'theme.github-dark': 'GitHub Dark',
    'ui.save': 'Save', 'ui.pages': 'Pages', 'ui.bookmarks': 'Bookmarks', 'ui.properties': 'Properties',
    'ui.searchPdf': 'Search in document…', 'ui.prev': 'Previous (Shift+Enter)', 'ui.next': 'Next (Enter / F3)', 'ui.closeEsc': 'Close (Esc)',
    'ui.emptyTitle': 'Open a PDF to get started', 'ui.emptyHint': 'Drop PDF files here, or use File → Open (Ctrl+O).',
    'ui.recent': 'Recent files', 'ui.drop': 'Drop PDF files to open them', 'ui.noOutline': 'This PDF has no bookmarks.',
    'ui.pageOf': 'Page {p} of {n}', 'ui.selected': '{n} pages selected', 'ui.fitWidthOpt': 'Fit width', 'ui.fitPageOpt': 'Fit page',
    'ui.notSaved': 'Unsaved changes', 'ui.openTip': 'Open PDF', 'ui.dragHint': 'Drag to reorder',
    'ui.document': 'Document', 'ui.file': 'File', 'ui.title': 'Title', 'ui.author': 'Author', 'ui.subject': 'Subject',
    'ui.creator': 'Created with', 'ui.producer': 'PDF producer', 'ui.created': 'Created', 'ui.modified': 'Modified',
    'ui.version': 'PDF version', 'ui.pageCount': 'Pages', 'ui.pageSize': 'Page size', 'ui.fileSize': 'File size',
    'ui.encrypted': 'Protected', 'ui.yes': 'Yes', 'ui.no': 'No', 'ui.path': 'Location', 'ui.color': 'Color',
    'ui.password': 'Password required', 'ui.passwordPrompt': '“{name}” is protected. Enter its password:',
    'ui.passwordWrong': 'Wrong password. Try again:', 'ui.open': 'Open', 'ui.cancel': 'Cancel', 'ui.notePh': 'Type a note…',
    'st.dirty': 'Unsaved changes', 'st.saved': 'Saved', 'st.zoom': '{n} %',
    'find.count': '{i} of {n}', 'find.found': '{n} found', 'find.none': 'No results', 'find.searching': 'Searching…',
    'toast.saved': 'Saved {name}', 'toast.exported': 'Exported {name}', 'toast.openFail': 'Could not open {name}: {e}',
    'toast.saveFail': 'Save failed: {e}', 'toast.encrypted': 'This PDF is protected, so changes can’t be saved.',
    'toast.printFail': 'Print failed: {e}', 'toast.preparing': 'Preparing {n} pages for printing…', 'toast.linkFail': 'Could not open link: {e}',
    'toast.skipped': 'Skipped {name} (not a PDF)', 'toast.lastPage': 'A document needs at least one page.',
    'toast.extracted': 'Extracted {n} pages to {name}', 'toast.inserted': 'Inserted {n} pages', 'toast.missing': 'File not found: {name}',
    'confirm.title': 'Unsaved changes', 'confirm.close': '“{name}” has unsaved changes. Close it anyway?',
    'confirm.quit': 'Some documents have unsaved changes. Quit anyway?', 'confirm.ok': 'Close anyway', 'confirm.quitOk': 'Quit anyway',
    'confirm.cancel': 'Cancel',
    'set.title': 'Settings', 'set.general': 'General', 'set.appearance': 'Appearance', 'set.viewer': 'Viewer',
    'set.language': 'Language', 'set.languageHint': 'Language of menus, panels and messages.', 'set.layout': 'Layout',
    'set.panels': 'Show panels on the right', 'set.reopen': 'Reopen the documents from last time on start',
    'set.theme': 'Theme', 'set.reading': 'Reading', 'set.invert': 'Dark pages — invert page colors for reading at night',
    'set.defaultZoom': 'Default zoom for new documents', 'set.reset': 'Reset to defaults', 'set.done': 'Done',
    'set.resetDone': 'Settings reset to defaults',
    'about.p1': '<b>PDF Studio</b> is part of the Studio family: view, search, annotate, reorder, merge and split PDFs.',
    'about.p2': 'Built with Rust (Tauri, lopdf for saving) and Mozilla <a href="https://mozilla.github.io/pdf.js/">pdf.js</a> for display.',
    'about.p3': 'Annotations are drawn into the page when you save, so they show in every PDF viewer.',
    'about.version': 'Version {v}',
    'sc.tools': 'Tools (when not typing)', 'sc.wheel': 'Zoom', 'sc.wheelKey': 'Ctrl + mouse wheel', 'sc.drag': 'Reorder pages',
    'sc.dragKey': 'Drag thumbnails', 'sc.multi': 'Select several pages', 'sc.multiKey': 'Ctrl / Shift + click',
    'tool.status': 'Tool: {name}', 'ctx.closeOthers': 'Close Other Tabs', 'ctx.deleteAnnot': 'Delete Annotation'
  },
  de: {
    'menu.file': 'Datei', 'menu.edit': 'Bearbeiten', 'menu.pages': 'Seiten', 'menu.tools': 'Werkzeuge', 'menu.view': 'Ansicht',
    'menu.settings': 'Einstellungen', 'menu.help': 'Hilfe', 'menu.language': 'Sprache', 'menu.theme': 'Design',
    'a.openFile': 'Öffnen…', 'a.insertPdf': 'PDF einfügen…', 'a.save': 'Speichern', 'a.saveAs': 'Speichern unter…',
    'a.exportPng': 'Seite als PNG exportieren…', 'a.print': 'Drucken…', 'a.closeTab': 'Tab schließen',
    'a.undo': 'Rückgängig', 'a.redo': 'Wiederholen', 'a.find': 'Suchen', 'a.findNext': 'Weitersuchen', 'a.selectAllPages': 'Alle Seiten auswählen',
    'a.rotateLeft': 'Nach links drehen', 'a.rotateRight': 'Nach rechts drehen', 'a.deletePages': 'Seiten löschen',
    'a.extractPages': 'Seiten extrahieren…', 'a.firstPage': 'Erste Seite', 'a.prevPage': 'Vorherige Seite',
    'a.nextPage': 'Nächste Seite', 'a.lastPage': 'Letzte Seite',
    'a.toolSelect': 'Text auswählen', 'a.toolHand': 'Hand', 'a.toolHighlight': 'Textmarker', 'a.toolPen': 'Stift',
    'a.toolNote': 'Textnotiz', 'a.toolErase': 'Radierer',
    'a.fitWidth': 'Seitenbreite', 'a.fitPage': 'Ganze Seite', 'a.actualSize': 'Originalgröße', 'a.zoomIn': 'Vergrößern',
    'a.zoomOut': 'Verkleinern', 'a.togglePanels': 'Bedienfelder', 'a.toggleInvert': 'Dunkle Seiten', 'a.settings': 'Einstellungen…',
    'a.langAuto': 'Systemsprache', 'a.langEn': 'English', 'a.langDe': 'Deutsch',
    'a.themeDark': 'Dunkel', 'a.themeLight': 'Hell', 'a.themeGithub': 'GitHub', 'a.themeGithubDark': 'GitHub Dunkel',
    'a.shortcuts': 'Tastenkürzel', 'a.about': 'Über PDF Studio',
    'theme.dark': 'Dunkel', 'theme.light': 'Hell', 'theme.github': 'GitHub', 'theme.github-dark': 'GitHub Dunkel',
    'ui.save': 'Speichern', 'ui.pages': 'Seiten', 'ui.bookmarks': 'Lesezeichen', 'ui.properties': 'Eigenschaften',
    'ui.searchPdf': 'Im Dokument suchen…', 'ui.prev': 'Vorheriger (Umschalt+Eingabe)', 'ui.next': 'Nächster (Eingabe / F3)',
    'ui.closeEsc': 'Schließen (Esc)', 'ui.emptyTitle': 'Öffne ein PDF, um loszulegen',
    'ui.emptyHint': 'PDF-Dateien hier ablegen oder Datei → Öffnen (Strg+O) verwenden.', 'ui.recent': 'Zuletzt geöffnet',
    'ui.drop': 'PDF-Dateien hier ablegen, um sie zu öffnen', 'ui.noOutline': 'Dieses PDF hat keine Lesezeichen.',
    'ui.pageOf': 'Seite {p} von {n}', 'ui.selected': '{n} Seiten ausgewählt', 'ui.fitWidthOpt': 'Seitenbreite',
    'ui.fitPageOpt': 'Ganze Seite', 'ui.notSaved': 'Ungespeicherte Änderungen', 'ui.openTip': 'PDF öffnen',
    'ui.dragHint': 'Ziehen zum Sortieren', 'ui.document': 'Dokument', 'ui.file': 'Datei', 'ui.title': 'Titel', 'ui.author': 'Autor',
    'ui.subject': 'Thema', 'ui.creator': 'Erstellt mit', 'ui.producer': 'PDF-Erzeuger', 'ui.created': 'Erstellt',
    'ui.modified': 'Geändert', 'ui.version': 'PDF-Version', 'ui.pageCount': 'Seiten', 'ui.pageSize': 'Seitengröße',
    'ui.fileSize': 'Dateigröße', 'ui.encrypted': 'Geschützt', 'ui.yes': 'Ja', 'ui.no': 'Nein', 'ui.path': 'Speicherort',
    'ui.color': 'Farbe', 'ui.password': 'Passwort erforderlich', 'ui.passwordPrompt': '„{name}“ ist geschützt. Gib das Passwort ein:',
    'ui.passwordWrong': 'Falsches Passwort. Versuche es erneut:', 'ui.open': 'Öffnen', 'ui.cancel': 'Abbrechen',
    'ui.notePh': 'Notiz eingeben…',
    'st.dirty': 'Ungespeicherte Änderungen', 'st.saved': 'Gespeichert', 'st.zoom': '{n} %',
    'find.count': '{i} von {n}', 'find.found': '{n} gefunden', 'find.none': 'Keine Treffer', 'find.searching': 'Suche läuft…',
    'toast.saved': '{name} gespeichert', 'toast.exported': '{name} exportiert', 'toast.openFail': '{name} konnte nicht geöffnet werden: {e}',
    'toast.saveFail': 'Speichern fehlgeschlagen: {e}', 'toast.encrypted': 'Dieses PDF ist geschützt, Änderungen können nicht gespeichert werden.',
    'toast.printFail': 'Drucken fehlgeschlagen: {e}', 'toast.preparing': '{n} Seiten werden für den Druck vorbereitet…',
    'toast.linkFail': 'Link konnte nicht geöffnet werden: {e}', 'toast.skipped': '{name} übersprungen (kein PDF)',
    'toast.lastPage': 'Ein Dokument braucht mindestens eine Seite.', 'toast.extracted': '{n} Seiten nach {name} extrahiert',
    'toast.inserted': '{n} Seiten eingefügt', 'toast.missing': 'Datei nicht gefunden: {name}',
    'confirm.title': 'Ungespeicherte Änderungen', 'confirm.close': '„{name}“ hat ungespeicherte Änderungen. Trotzdem schließen?',
    'confirm.quit': 'Einige Dokumente haben ungespeicherte Änderungen. Trotzdem beenden?', 'confirm.ok': 'Trotzdem schließen',
    'confirm.quitOk': 'Trotzdem beenden', 'confirm.cancel': 'Abbrechen',
    'set.title': 'Einstellungen', 'set.general': 'Allgemein', 'set.appearance': 'Darstellung', 'set.viewer': 'Anzeige',
    'set.language': 'Sprache', 'set.languageHint': 'Sprache der Menüs, Bedienfelder und Meldungen.', 'set.layout': 'Layout',
    'set.panels': 'Bedienfelder rechts anzeigen', 'set.reopen': 'Beim Start die zuletzt geöffneten Dokumente wieder öffnen',
    'set.theme': 'Design', 'set.reading': 'Lesen', 'set.invert': 'Dunkle Seiten – Seitenfarben umkehren, zum Lesen bei Nacht',
    'set.defaultZoom': 'Standard-Zoom für neue Dokumente', 'set.reset': 'Auf Standard zurücksetzen', 'set.done': 'Fertig',
    'set.resetDone': 'Einstellungen zurückgesetzt',
    'about.p1': '<b>PDF Studio</b> gehört zur Studio-Familie: PDFs ansehen, durchsuchen, kommentieren, sortieren, zusammenführen und teilen.',
    'about.p2': 'Gebaut mit Rust (Tauri, lopdf zum Speichern) und Mozilla <a href="https://mozilla.github.io/pdf.js/">pdf.js</a> für die Anzeige.',
    'about.p3': 'Anmerkungen werden beim Speichern in die Seite gezeichnet und sind so in jedem PDF-Programm sichtbar.',
    'about.version': 'Version {v}',
    'sc.tools': 'Werkzeuge (außerhalb von Eingabefeldern)', 'sc.wheel': 'Zoomen', 'sc.wheelKey': 'Strg + Mausrad',
    'sc.drag': 'Seiten sortieren', 'sc.dragKey': 'Miniaturen ziehen', 'sc.multi': 'Mehrere Seiten auswählen',
    'sc.multiKey': 'Strg / Umschalt + Klick', 'tool.status': 'Werkzeug: {name}',
    'ctx.closeOthers': 'Andere Tabs schließen', 'ctx.deleteAnnot': 'Anmerkung löschen'
  }
};
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
const DEF = {lang: 'auto', theme: 'dark', zoomMode: 'fit-width', invert: false, dock: true, dockTab: 'pages', reopen: true, color: '#FFD400'};
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
async function readPath(path) { return new Uint8Array(await invoke('read_file', {path})); }
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
const bytesOf = async f => f.bytes || readPath(f.path);

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
async function loadPdf(bytes, name) {
  const task = pdfjsLib.getDocument({...PDF_OPTS, data: bytes.slice()});
  let password = null;
  task.onPassword = async (update, reason) => {
    const pw = await askPassword(name, reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
    if (pw == null) task.destroy(); else { password = pw; update(pw); }
  };
  const pdf = await task.promise;
  const proxies = [];
  for (let i = 1; i <= pdf.numPages; i++) proxies.push(await pdf.getPage(i));
  // Rust keeps a copy for building the saved file (pdfbuild.rs); the UI then only sends page lists.
  const rid = invoke ? await invoke('pdf_cache', bytes) : null;
  return {bytes, pdf, proxies, encrypted: password != null, rid};
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
  let bytes;
  try { bytes = await bytesOf(f); } catch (e) { return toast(t('toast.missing', {name: f.name})); }
  let src;
  try { src = await loadPdf(bytes, f.name); }
  catch (e) { if (!/destroy|abort/i.test(String(e && (e.name + e.message)))) toast(t('toast.openFail', {name: f.name, e: e.message || e})); return; }
  const d = {id: ++docSeq, name: f.name, path: f.path, size: f.size || bytes.length, sources: [src], pages: pagesOf(src, 0),
    annots: {}, dirty: false, history: [], future: [], cleanDepth: 0, selected: new Set(), current: 0, zoom: 1,
    zoomMode: settings.zoomMode, scroll: 0, meta: await src.pdf.getMetadata().catch(() => null),
    outline: await src.pdf.getOutline().catch(() => null)};
  docs.push(d);
  if (f.path) { recent = [{path: f.path, name: f.name}, ...recent.filter(r => r.path !== f.path)].slice(0, 10); }
  activate(docs.length - 1, true);
}
async function openFiles(list) { for (const f of list) await openFileInfo(f); }

/* ================= Tabs ================= */
function activate(i, fresh = false) {
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
  const task = proxyOf(d, pg).render({canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null});
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
}
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
    if (a.t === 'ink') {
      const pts = a.p.map(p => vp.convertToViewportPoint(p[0], p[1]).map(v => v.toFixed(1)).join(',')).join(' ');
      return `<polyline class="ann" data-k="${k}" points="${pts}" fill="none" stroke="${a.c}" stroke-width="${a.w * vp.scale}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    if (a.t === 'note') {
      const [x, y] = vp.convertToViewportPoint(a.x, a.y), s = vp.scale, box = noteBox(a.text, s);
      const tsp = box.lines.map((l, i) => `<tspan x="${x + NOTE.pad * s}" y="${y + (NOTE.pad + (i + 1) * NOTE.line - 3.5) * s}">${esc(l) || ' '}</tspan>`).join('');
      return `<g class="ann" data-k="${k}"><rect x="${x}" y="${y}" width="${box.w}" height="${box.h}" fill="#FFF7B3" stroke="${a.c}" stroke-width="${s}"/>` +
        `<text font-family="Helvetica, Arial, sans-serif" font-size="${NOTE.size * s}" fill="#222">${tsp}</text></g>`;
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
    } else if (a.t === 'ink') {
      for (const p of a.p) { const [px, py] = vp.convertToViewportPoint(p[0], p[1]); if (Math.hypot(px - x, py - y) < 8) return k; }
    } else if (a.t === 'note') {
      const [nx, ny] = vp.convertToViewportPoint(a.x, a.y), b = noteBox(a.text, vp.scale);
      if (x >= nx && x <= nx + b.w && y >= ny && y <= ny + b.h) return k;
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
  if (tool === 'note') return openNoteEditor(el, local(e));
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
function openNoteEditor(el, [x, y]) {
  const ta = document.createElement('textarea');
  ta.className = 'note-edit'; ta.placeholder = t('ui.notePh');
  ta.style.left = x + 'px'; ta.style.top = y + 'px';
  el.append(ta); ta.focus();
  let done = false;
  const commit = keep => {
    if (done) return; done = true;
    const text = ta.value.replace(/\s+$/, '');
    ta.remove();
    if (keep && text) { const [px, py] = el._vp.convertToPdfPoint(x, y); addAnnot(el._pg, {t: 'note', x: px, y: py, text, c: settings.color}); }
  };
  ta.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') commit(false);
    if (e.key === 'Enter' && (e.ctrlKey || !e.shiftKey)) { e.preventDefault(); commit(true); }
  });
  ta.addEventListener('blur', () => commit(true));
  ta.addEventListener('pointerdown', e => e.stopPropagation());
}
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
  tool = name;
  document.body.className = document.body.className.replace(/\btool-\S+/g, '').trim() + ' tool-' + name;
  document.body.classList.toggle('invert', settings.invert);
  $$('#tools .ibtn[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === name));
  $('#swatches').style.display = ['highlight', 'pen', 'note'].includes(name) ? '' : 'none';
  $('#stTool').textContent = t('tool.status', {name: t('a.' + TOOL_ACT[name])});
}
const TOOL_ACT = {select: 'toolSelect', hand: 'toolHand', highlight: 'toolHighlight', pen: 'toolPen', note: 'toolNote', erase: 'toolErase'};

/* ================= History & page operations ================= */
const snapshot = d => ({pages: d.pages.map(p => ({...p})), annots: JSON.parse(JSON.stringify(d.annots))});
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
  d.pages = s.pages; d.annots = s.annots;
  changed(structure);
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

/* ================= Building the output PDF ================= */
/* The PDF is assembled in Rust (pdfbuild.rs): page order and rotation, pages from other files, and the annotations.
   The UI only lays out the notes (display geometry); Rust writes everything into the file. */
const forgetSources = list => { list.forEach(s => s.pdf.destroy()); if (invoke) invoke('pdf_forget', {ids: list.map(s => s.rid).filter(Boolean)}).catch(() => {}); };
let helvCtx = null;
/* Width of text in Helvetica (Arial has the same widths and is always available). */
const helvWidth = (s, size) => { helvCtx = helvCtx || document.createElement('canvas').getContext('2d'); helvCtx.font = `${size}px Helvetica, Arial, sans-serif`; return helvCtx.measureText(s).width; };
function annotsPdf(d, p) {
  const R = effRot(p), vp1 = proxyOf(d, p).getViewport({scale: 1, rotation: R});
  return (d.annots[p.id] || []).map(a => {
    if (a.t === 'hl') return {t: 'hl', r: a.r, c: a.c};
    if (a.t === 'ink') return {t: 'ink', p: a.p, w: a.w, c: a.c};
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
  // Files that needed a password to open keep their protection: they aren't re-saved unencrypted.
  if (d.sources.some(s => s.encrypted)) throw new Error('encrypted');
  const list = onlyIds ? d.pages.filter(p => onlyIds.has(p.id)) : d.pages;
  const pages = list.map(p => ({src: p.src, index: p.index, rot: effRot(p), annots: annotsPdf(d, p)}));
  return new Uint8Array(await invoke('pdf_build', {req: {sources: d.sources.map(s => s.rid), pages}}));
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
    size: bytes.length, selected: new Set(), meta: await src.pdf.getMetadata().catch(() => null), outline: await src.pdf.getOutline().catch(() => null)});
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
function buildOutline() {
  const d = cur(), box = $('#outline');
  if (!d || !d.outline || !d.outline.length) { box.innerHTML = `<div class="empty">${esc(t('ui.noOutline'))}</div>`; return; }
  box.innerHTML = '';
  const add = (items, depth) => items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'ol-item'; el.textContent = item.title; el.title = item.title;
    el.style.paddingLeft = (8 + depth * 14) + 'px';
    el.onclick = () => outlineGo(item);
    box.append(el);
    if (item.items && item.items.length) add(item.items, depth + 1);
  });
  add(d.outline, 0);
}
async function outlineGo(item) {
  const d = cur(), pdf = d.sources[0].pdf;
  if (item.url) return openUrl(item.url);
  let dest = item.dest;
  if (typeof dest === 'string') dest = await pdf.getDestination(dest);
  if (!Array.isArray(dest)) return;
  const idx = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]).catch(() => -1);
  const pos = d.pages.findIndex(p => p.src === 0 && p.index === idx);
  if (pos >= 0) goToPage(pos);
}
function pdfDate(s) {
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s || '');
  if (!m) return s || '';
  const dt = new Date(+m[1], (+m[2] || 1) - 1, +m[3] || 1, +m[4] || 0, +m[5] || 0);
  return dt.toLocaleString(lang, {dateStyle: 'medium', timeStyle: 'short'});
}
function buildProps() {
  const d = cur(), box = $('#props');
  if (!d) { box.innerHTML = ''; return; }
  const info = (d.meta && d.meta.info) || {}, pg = d.pages[d.current] || d.pages[0];
  const sw = effRot(pg) % 180 !== 0, mm = v => Math.round(v * 25.4 / 72);
  const row = (k, v) => v ? `<div class="kv"><span>${esc(t(k))}</span><b title="${esc(v)}">${esc(v)}</b></div>` : '';
  box.innerHTML = `<div class="psec"><div class="psec-h">${esc(t('ui.file'))}</div>
    ${row('ui.title', d.name)}${row('ui.path', d.path || '')}${row('ui.fileSize', fmtSize(d.size))}
    ${row('ui.pageCount', String(d.pages.length))}${row('ui.pageSize', `${mm(sw ? pg.h : pg.w)} × ${mm(sw ? pg.w : pg.h)} mm`)}
    ${row('ui.version', info.PDFFormatVersion || '')}${row('ui.encrypted', t(d.sources[0].encrypted ? 'ui.yes' : 'ui.no'))}</div>
    <div class="psec" style="border:0"><div class="psec-h">${esc(t('ui.document'))}</div>
    ${row('ui.title', info.Title || '')}${row('ui.author', info.Author || '')}${row('ui.subject', info.Subject || '')}
    ${row('ui.creator', info.Creator || '')}${row('ui.producer', info.Producer || '')}
    ${row('ui.created', pdfDate(info.CreationDate))}${row('ui.modified', pdfDate(info.ModDate))}</div>`;
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
  erase: '<svg viewBox="0 0 24 24"><path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 19"/><path d="M22 21H7M5 11l9 9"/></svg>',
  rotL: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  rotR: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
  extract: '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 18v-6M9 15l3 3 3-3"/></svg>',
  insert: '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 12v6M9 15h6"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  print: '<svg viewBox="0 0 24 24"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7"/></svg>',
  panel: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  help: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/></svg>'
};
const needsDoc = fn => () => cur() && fn();
const A = {
  openFile: async () => openFiles(await pickFiles()),
  insertPdf: needsDoc(() => insertPdf()), save: needsDoc(() => save(false)), saveAs: needsDoc(() => save(true)),
  exportPng: needsDoc(exportPng), print: needsDoc(printDoc), closeTab: needsDoc(() => closeTab(active)),
  undo: () => undoRedo(false), redo: () => undoRedo(true),
  find: needsDoc(openFind), findNext: needsDoc(() => findStep()),
  selectAllPages: needsDoc(() => { const d = cur(); d.selected = new Set(d.pages.map(p => p.id)); markThumbs(); updateUI(); }),
  rotateLeft: () => rotatePages(-90), rotateRight: () => rotatePages(90), deletePages, extractPages: needsDoc(extractPages),
  firstPage: () => goToPage(0), prevPage: () => cur() && goToPage(cur().current - 1),
  nextPage: () => cur() && goToPage(cur().current + 1), lastPage: () => cur() && goToPage(cur().pages.length - 1),
  toolSelect: () => setTool('select'), toolHand: () => setTool('hand'), toolHighlight: () => setTool('highlight'),
  toolPen: () => setTool('pen'), toolNote: () => setTool('note'), toolErase: () => setTool('erase'),
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
  ['pages', [['rotateLeft', 'Ctrl+Shift+R'], ['rotateRight', 'Ctrl+R'], ['deletePages', 'Delete', null, true], ['extractPages', 'Ctrl+Shift+E'], '-',
    ['firstPage', 'Ctrl+Home'], ['prevPage', 'Ctrl+PageUp'], ['nextPage', 'Ctrl+PageDown'], ['lastPage', 'Ctrl+End']]],
  ['tools', [['toolSelect', 'V', () => tool === 'select', true], ['toolHand', 'H', () => tool === 'hand', true], '-',
    ['toolHighlight', 'M', () => tool === 'highlight', true], ['toolPen', 'P', () => tool === 'pen', true],
    ['toolNote', 'T', () => tool === 'note', true], ['toolErase', 'E', () => tool === 'erase', true]]],
  ['view', [['fitWidth', 'Ctrl+1', () => cur() && cur().zoomMode === 'fit-width'], ['fitPage', 'Ctrl+2', () => cur() && cur().zoomMode === 'fit-page'],
    ['actualSize', 'Ctrl+0'], ['zoomIn', 'Ctrl+='], ['zoomOut', 'Ctrl+-'], '-',
    ['togglePanels', 'Ctrl+\\', () => settings.dock], ['toggleInvert', 'Ctrl+Shift+I', () => settings.invert]]],
  ['settings', [['settings', 'Ctrl+,'], '-', '#menu.language',
    ['langAuto', null, () => settings.lang === 'auto'], ['langEn', null, () => settings.lang === 'en'], ['langDe', null, () => settings.lang === 'de'],
    '-', '#menu.theme',
    ['themeDark', null, () => settings.theme === 'dark'], ['themeLight', null, () => settings.theme === 'light'],
    ['themeGithub', null, () => settings.theme === 'github'], ['themeGithubDark', null, () => settings.theme === 'github-dark']]],
  ['help', [['shortcuts'], '-', ['about']]]
];
const KEYMAP = {}, LETTERS = {};
MENUS.forEach(([, items]) => items.forEach(it => { if (Array.isArray(it) && it[1]) (it[3] ? LETTERS : KEYMAP)[it[1]] = it[0]; }));

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
    ['extractPages', ICONS.extract, {needsDoc: 1}], ['insertPdf', ICONS.insert, {needsDoc: 1}]]);
  const tools = $('#tools'); tools.innerHTML = '';
  [['toolSelect', 'select'], ['toolHand', 'hand'], '-', ['toolHighlight', 'highlight'], ['toolPen', 'pen'], ['toolNote', 'note'], ['toolErase', 'erase'], '-']
    .forEach(r => {
      if (r === '-') { const s = document.createElement('div'); s.className = 'sep'; return tools.append(s); }
      tools.append(makeBtn(r[0], ICONS[r[1]], {tool: r[1]}));
    });
  tools.append(makeBtn('rotateLeft', ICONS.rotL, {needsDoc: 1}), makeBtn('rotateRight', ICONS.rotR, {needsDoc: 1}), makeBtn('deletePages', ICONS.trash, {needsDoc: 1}));
  $$('[data-needs-doc]').forEach(b => b.setAttribute('data-needs-doc', ''));
  $('#swatches').innerHTML = COLORS.map(c => `<button class="swatch${c === settings.color ? ' active' : ''}" data-color="${c}" style="background:${c}" title="${esc(t('ui.color'))} ${c}"></button>`).join('');
  $('#zOutBtn').title = tip('zoomOut'); $('#zInBtn').title = tip('zoomIn');
  $('#prevBtn').title = tip('prevPage'); $('#nextBtn').title = tip('nextPage');
}
document.addEventListener('mousedown', e => { if (e.target.closest('.ibtn,.cta,.swatch')) e.preventDefault(); });
document.addEventListener('click', e => {
  const sw = e.target.closest('[data-color]');
  if (sw) { settings.color = sw.dataset.color; $$('.swatch').forEach(s => s.classList.toggle('active', s === sw)); saveState(); return; }
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
  if (e.key === 'Escape') {
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
    general: `<h3>${t('set.language')}</h3><p class="hint">${t('set.languageHint')}</p>
      <select class="wide-sel" data-sel="lang">${opt('auto', t('a.langAuto'), settings.lang)}${opt('en', 'English', settings.lang)}${opt('de', 'Deutsch', settings.lang)}</select>
      <h3>${t('set.layout')}</h3>${sw('dock', t('set.panels'))}${sw('reopen', t('set.reopen'))}`,
    appearance: `<h3>${t('set.theme')}</h3><div class="theme-grid">` + THEMES.map(th =>
        `<button class="theme-card${settings.theme === th ? ' active' : ''}" data-theme-pick="${th}">${mock(th)}
         <div class="theme-name">${esc(t('theme.' + th))}<span>${settings.theme === th ? '&#10003;' : ''}</span></div></button>`).join('') +
      `</div><h3>${t('set.reading')}</h3>${sw('invert', t('set.invert'))}`,
    viewer: `<h3>${t('set.defaultZoom')}</h3><select class="wide-sel" data-sel="zoomMode">${opt('fit-width', t('ui.fitWidthOpt'), settings.zoomMode)}${opt('fit-page', t('ui.fitPageOpt'), settings.zoomMode)}${opt('actual', '100 %', settings.zoomMode)}</select>`
  };
  $('#modalTitle').textContent = t('set.title');
  $('#modalBody').innerHTML = `<div class="prefs"><nav>${['general', 'appearance', 'viewer'].map(k =>
    `<button data-sec="${k}" class="${k === prefsSection ? 'active' : ''}">${esc(t('set.' + k))}</button>`).join('')}</nav><section>${body[prefsSection]}</section></div>`;
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
function applySettings() {
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
      return [item('rotateLeft'), item('rotateRight'), item('deletePages'), null, item('extractPages'), item('insertPdf')];
    }
    const pg = e.target.closest('.page');
    if (pg) {
      const i = +pg.dataset.i;
      if (!d.selected.has(d.pages[i].id)) d.selected = new Set();
      d.current = i; markThumbs(); updatePageUI();
      const k = annotAt(pg, e.clientX, e.clientY), ann = k >= 0;
      ctx.ann = ann ? {pg: pg._pg, k} : null;
      return [Native.copyTextItem(), ...(ann ? [null, {id: 'ctx:delAnn', label: t('ctx.deleteAnnot')}] : []), null,
        item('rotateLeft'), item('rotateRight'), item('deletePages'), item('exportPng'), null,
        ...['select', 'hand', 'highlight', 'pen', 'note'].map(n => item(TOOL_ACT[n], {checked: tool === n}))];
    }
    return null;
  });
  Native.setHandler(async id => {
    if (id === 'tab:close') return closeTab(ctx.tab);
    if (id === 'tab:others') { const keep = docs[ctx.tab]; for (const x of [...docs]) if (x !== keep) await closeTab(docs.indexOf(x)); return; }
    if (id === 'ctx:delAnn' && ctx.ann) { const d = cur(); pushHistory(d); d.annots[ctx.ann.pg.id].splice(ctx.ann.k, 1); changed(); return; }
    if (A[id]) A[id]();
  });
}

/* ================= Boot ================= */
(async function boot() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE)); } catch (e) {}
  if (saved) { settings = {...DEF, ...saved.settings}; recent = saved.recent || []; }
  lang = effectiveLang();
  applyLanguage();
  booted = true;
  applySettings(); setTool('select'); renderTabs(); renderRecent(); updateUI();
  if (invoke) {
    window.__TAURI__.window.getCurrentWindow().onCloseRequested(async ev => {
      saveState();
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
window.__pd = {openFiles, A, cur, buildPdf, setZoom, goToPage, addAnnot, annotAt, movePages, deletePages, rotatePages, insertPdf, undoRedo,
  find, runFind, findStep, settings: () => settings, pdfjsLib, PDF_OPTS};
