# PDF Studio

PDF viewer and editor of the Studio family (Rust / Tauri 2). View, search, annotate, reorder, merge, split, export and print PDFs.

- UI: `ui/` (pdf.js 4.10 for rendering, pdf-lib for editing)
- Native backend: `src-tauri/src/main.rs` (binary file IO, dialogs, native context menus, clipboard)

## MCP
PDF Studio is also an MCP server, so Claude (Desktop or Code), ChatGPT and other MCP clients can use what it can do:
started with `--mcp`, the program opens no window and speaks MCP on stdin / stdout until the client closes it.

- `pdf_info` — Number of pages, properties and bookmarks of a PDF.
- `pdf_text` — The text of a PDF, page by page (from and to: first page is 1; default: all). Scans have no text.
- `pdf_extract_pages` — Makes a new PDF from pages of a PDF, in the given order (first page is 1).
- `pdf_merge` — Makes a new PDF from all pages of several PDFs, in the given order.

The originals stay untouched; a result is a new file (an existing one is only replaced with `overwrite`). Files are given as full paths.

Claude Code: `claude mcp add pdf-studio -- "/Applications/PDF Studio.app/Contents/MacOS/pdf-studio" --mcp`.
Claude Desktop (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "pdf-studio": {
      "command": "/Applications/PDF Studio.app/Contents/MacOS/pdf-studio",
      "args": [
        "--mcp"
      ]
    }
  }
}
```
The program is `/Applications/PDF Studio.app/Contents/MacOS/pdf-studio` on macOS, `pdf-studio.exe` in the install folder on
Windows, and `pdf-studio` (or the AppImage) on Linux.

## Build (Windows x64)

```powershell
.\build-windows.ps1          # installers + portable exe in .\dist
```
