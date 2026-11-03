//! What PDF Studio offers over MCP (mcp.rs): properties and text of a PDF, new PDFs from pages of others. The originals
//! stay untouched; the result is a new file (an existing one is only replaced with `overwrite`).

use crate::{mcp, pdfbuild, pdfinfo};
use lopdf::Document;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn run() { mcp::serve("pdf-studio", env!("CARGO_PKG_VERSION"), &tools(), &call) }

fn tools() -> Vec<Value> {
    let path = json!({"type": "string", "description": "Full path of the PDF"});
    let password = json!({"type": "string", "description": "Only for a PDF with an open password"});
    let output = json!({"type": "string", "description": "Full path of the new PDF"});
    vec![
        mcp::tool("pdf_info", "Number of pages, properties and bookmarks of a PDF.", json!({"path": path, "password": password}), &["path"]),
        mcp::tool("pdf_text", "The text of a PDF, page by page (from and to: first page is 1; default: all). Scans have no text.",
            json!({"path": path, "password": password, "from": {"type": "integer"}, "to": {"type": "integer"}}), &["path"]),
        mcp::tool("pdf_extract_pages", "Makes a new PDF from pages of a PDF, in the given order (first page is 1).",
            json!({"path": path, "pages": {"type": "array", "items": {"type": "integer"}}, "output": output, "overwrite": {"type": "boolean"}}), &["path", "pages", "output"]),
        mcp::tool("pdf_merge", "Makes a new PDF from all pages of several PDFs, in the given order.",
            json!({"inputs": {"type": "array", "items": {"type": "string"}}, "output": output, "overwrite": {"type": "boolean"}}), &["inputs", "output"]),
    ]
}

fn read(p: &Path) -> Result<Vec<u8>, String> { std::fs::read(p).map_err(|e| format!("{}: {e}", p.display())) }

fn open(bytes: &[u8], password: &str) -> Result<Document, String> {
    let mut doc = Document::load_mem(bytes).map_err(|e| e.to_string())?;
    if doc.is_encrypted() { doc.decrypt(password).map_err(|_| "encrypted: the password is missing or wrong".to_string())?; }
    Ok(doc)
}

fn output(args: &Value) -> Result<PathBuf, String> {
    let p = mcp::path(args, "output")?;
    if mcp::has_ext(&p, &["pdf"]) { Ok(p) } else { Err(format!("{}: not a .pdf file", p.display())) }
}

fn page(src: usize, index: usize) -> Result<pdfbuild::PageReq, String> {
    serde_json::from_value(json!({"src": src, "index": index, "rot": 0})).map_err(|e| e.to_string())
}

fn save(args: &Value, sources: &[Vec<u8>], pages: &[pdfbuild::PageReq]) -> Result<Value, String> {
    let out = output(args)?;
    let bytes = pdfbuild::build(sources, pages)?;
    mcp::put(&out, &bytes, mcp::flag(args, "overwrite"))?;
    Ok(json!({"path": out, "pages": pages.len()}))
}

fn call(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "pdf_info" => {
            let bytes = read(&mcp::path(args, "path")?)?;
            let password = mcp::opt_text(args, "password");
            let pages = open(&bytes, &password)?.get_pages().len();
            Ok(json!({"pages": pages, "info": serde_json::to_value(pdfinfo::info(&bytes, &password)?).map_err(|e| e.to_string())?}))
        }
        "pdf_text" => {
            let doc = open(&read(&mcp::path(args, "path")?)?, &mcp::opt_text(args, "password"))?;
            let count = doc.get_pages().len() as u32;
            let number = |k: &str, or: u32| args.get(k).and_then(Value::as_u64).map_or(or, |n| n.min(u32::MAX as u64) as u32);
            let (from, to) = (number("from", 1).max(1), number("to", count).min(count));
            let pages: Vec<Value> = (from..=to).map(|p| json!({"page": p, "text": doc.extract_text(&[p]).unwrap_or_default()})).collect();
            Ok(json!({"pages": count, "text": pages}))
        }
        "pdf_extract_pages" => {
            let bytes = read(&mcp::path(args, "path")?)?;
            let count = open(&bytes, "")?.get_pages().len();
            let list = args.get("pages").and_then(Value::as_array).ok_or("pages is needed")?;
            if list.is_empty() { return Err("pages is empty".into()); }
            let pages = list.iter().map(|n| match n.as_u64() {
                Some(n) if n >= 1 && n as usize <= count => page(0, n as usize - 1),
                _ => Err(format!("page {n}: the PDF has {count} pages")),
            }).collect::<Result<Vec<_>, _>>()?;
            save(args, &[bytes], &pages)
        }
        "pdf_merge" => {
            let list = args.get("inputs").and_then(Value::as_array).filter(|l| !l.is_empty()).ok_or("inputs is needed")?;
            let (mut sources, mut pages) = (Vec::new(), Vec::new());
            for (src, input) in list.iter().enumerate() {
                let p = PathBuf::from(input.as_str().ok_or("inputs: expected paths")?);
                if !p.is_absolute() { return Err(format!("inputs must be full paths: {}", p.display())); }
                let bytes = read(&p)?;
                for index in 0..open(&bytes, "")?.get_pages().len() { pages.push(page(src, index)?); }
                sources.push(bytes);
            }
            save(args, &sources, &pages)
        }
        _ => Err(format!("unknown tool: {name}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn new_pdfs_from_pages() {
        let d = std::env::temp_dir().join(format!("pdf-mcp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        let a = d.join("a.pdf");
        fs::write(&a, pdfbuild::blank_pdf(595.0, 842.0, 3).unwrap()).unwrap();
        assert_eq!(call("pdf_info", &json!({"path": a})).unwrap()["pages"], 3);
        assert_eq!(call("pdf_text", &json!({"path": a, "from": 2})).unwrap()["text"].as_array().unwrap().len(), 2);

        let part = d.join("part.pdf");
        call("pdf_extract_pages", &json!({"path": a, "pages": [3, 1], "output": part})).unwrap();
        assert_eq!(call("pdf_info", &json!({"path": part})).unwrap()["pages"], 2);
        assert!(call("pdf_extract_pages", &json!({"path": a, "pages": [3, 1], "output": part})).is_err(), "nothing is overwritten unless asked");
        assert!(call("pdf_extract_pages", &json!({"path": a, "pages": [4], "output": d.join("x.pdf")})).is_err());
        assert!(call("pdf_extract_pages", &json!({"path": a, "pages": [1], "output": d.join("x.sh")})).is_err(), "only PDF files");

        let all = d.join("all.pdf");
        call("pdf_merge", &json!({"inputs": [a, part], "output": all})).unwrap();
        assert_eq!(call("pdf_info", &json!({"path": all})).unwrap()["pages"], 5);
        assert!(call("pdf_info", &json!({"path": d.join("none.pdf")})).is_err());
        let _ = fs::remove_dir_all(d);
    }
}
