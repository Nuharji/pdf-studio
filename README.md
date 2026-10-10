# PDF Studio

PDF viewer and editor of the Studio family (Rust / Tauri 2). View, search, annotate, reorder, merge, split, export and print PDFs.

- UI: `ui/` (pdf.js 4.10 for rendering, pdf-lib for editing)
- Native backend: `src-tauri/src/main.rs` (binary file IO, dialogs, native context menus, clipboard)

## Build (Windows x64)

```powershell
.\build-windows.ps1          # installers + portable exe in .\dist
```
