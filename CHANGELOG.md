# Changelog

## 1.5.0 — 2026-10-11
- New: Settings → Shortcuts. Every menu command can get its own key: click it and press the new combination (with Ctrl or Alt, or a function key); Backspace removes a shortcut, ↺ or “Reset all” brings the defaults back. A key that another command used is moved (you get a note); system keys like Copy stay fixed. Menus, tooltips and Help → Keyboard Shortcuts show your keys.

## 1.4.0 — 2026-10-11
- New: Auto-hide bars (View menu, or Settings → General). The menu bar, toolbar, tool rail and status bar leave the window and slide in when the mouse touches their edge; they stay while a menu is open or you type in them. Alt alone shows the top bars (Escape or a click elsewhere hides them).

## 1.3.0 — 2026-10-11
- Spelling & grammar check while typing a note, German and English, entirely on your PC: misspelled words get a red wavy underline, grammar hints a blue one. Right-click for suggestions, “Add to dictionary” (a personal dictionary shared by all Studio apps) or “Ignore”.
- Settings → Viewer → Spelling & grammar: Automatic (German + English), German, English or Off.
- Fixed: right-clicking in a note being typed closed it (the context menu took the focus).
- The portable .zip now includes the dictionaries (separate files with their own licenses, see dictionaries/README.md); the bare portable .exe has no spell check.

## 1.2.3 — 2026-10-11
- Fixed: PDFs protected only by an owner password (they open without asking) are now shown as protected in the Properties panel.
- Password-protected PDFs: properties and bookmarks are read with the password you entered.

## 1.2.2 — 2026-10-11
- Document properties (version, encryption, title, author, subject, creator, producer, dates) and bookmarks are now read by the Rust core. Bookmarks keep working for links by name, nested bookmarks and web links.

## 1.2.1 — 2026-10-11
- The English and German texts are now language files (src-tauri/i18n) delivered by the app's Rust core instead of being part of the JavaScript.

## 1.2.0 — 2026-10-10
- Saving is now done by the app's Rust core: page order, rotation, pages from other PDFs and your highlights, ink and notes are written into the file there (much faster — a 15-page document builds in a few milliseconds).
- PDFs that only carry an owner password (e.g. "printing not allowed") can now be saved with your changes; files that need a password to open keep their protection and aren't re-saved without it.
- Notes keep umlauts and special characters like € when saved.
- About 500 KB less JavaScript (the pdf-lib library is no longer needed).
## 1.1.5 — 2026-10-10
- Icon fades swapped: dark themes now show the dark fade and light themes the light fade — in the menu bar, on the start screen and in the taskbar.

## 1.1.4 — 2026-10-10
- The app icon follows the theme: a light fade in dark themes, a dark fade in light themes — in the menu bar, on the start screen and in the window/taskbar icon.
- All Studio icons now have exactly the same rounded corners.

## 1.1.3 — 2026-10-10
- New app icon with a dark-to-bright red fade, matching the Studio family look (also in the title bar and start screen).

## 1.1.2 — 2026-10-10
- Right-click an annotation to delete it — now also with the normal select tool.

## 1.1.1 — 2026-10-10
- The Windows taskbar and Alt+Tab now show the open document's name.

## 1.1.0 — 2026-10-10
- Right-click opens native Windows menus for pages, thumbnails and tabs.
- Browser shortcuts (reload, back, print preview) are switched off.

## 1.0.0 — 2026-10-10
- First release: view, search, bookmarks, thumbnails, dark reading mode.
- Reorder, rotate, delete, insert (merge) and extract pages.
- Highlighter, pen, text notes and eraser with undo; export pages as PNG; print.
- English and German, themes Dark, Light, GitHub and GitHub Dark.