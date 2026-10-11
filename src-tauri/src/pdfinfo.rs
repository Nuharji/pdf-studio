//! Document properties and bookmarks (outline) of an opened PDF, read with lopdf from the cached source (pdfbuild.rs).
//! The UI shows them; dates come as [year, month, day, hour, minute] so the UI can format them for the user's language.

use crate::pdfbuild::Sources;
use lopdf::{decode_text_string, Dictionary, Document, Object, ObjectId};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use tauri::State;

#[derive(Serialize, Default, Debug, PartialEq)]
pub struct Info {
    version: String,
    encrypted: bool,
    title: String,
    author: String,
    subject: String,
    keywords: String,
    creator: String,
    producer: String,
    /// [year, month, day, hour, minute], or the text as written when it isn't a PDF date
    created: Option<DateOrText>,
    modified: Option<DateOrText>,
    outline: Vec<Item>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(untagged)]
pub enum DateOrText { Date([u32; 5]), Text(String) }

#[derive(Serialize, Debug, PartialEq)]
pub struct Item {
    title: String,
    /// 0-based page in this document
    page: Option<usize>,
    url: Option<String>,
    items: Vec<Item>,
}

/// A text string (PDFDocEncoding, UTF-16 or UTF-8), following a reference.
fn text(doc: &Document, obj: &Object) -> Option<String> {
    let obj = match obj { Object::Reference(id) => doc.get_object(*id).ok()?, o => o };
    decode_text_string(obj).ok().map(|s| s.trim_start_matches('\u{feff}').trim_end_matches('\0').to_string())
}

fn deref<'a>(doc: &'a Document, obj: &'a Object) -> &'a Object {
    match obj { Object::Reference(id) => doc.get_object(*id).unwrap_or(obj), o => o }
}

fn dict<'a>(doc: &'a Document, obj: &'a Object) -> Option<&'a Dictionary> { deref(doc, obj).as_dict().ok() }

/// "D:20240501143000+02'00'" -> [2024, 5, 1, 14, 30] (time as written, like other PDF viewers show it).
pub fn pdf_date(s: &str) -> Option<[u32; 5]> {
    let s = s.trim().trim_start_matches("D:");
    let digits: String = s.chars().take_while(char::is_ascii_digit).take(12).collect();
    if digits.len() < 4 { return None; }
    let part = |a: usize, b: usize, def: u32| digits.get(a..b).and_then(|x| x.parse().ok()).unwrap_or(def);
    Some([part(0, 4, 0), part(4, 6, 1).max(1), part(6, 8, 1).max(1), part(8, 10, 0), part(10, 12, 0)])
}

/// A destination by name: the catalog's /Dests dictionary, or the /Names → /Dests name tree.
fn named_dest<'a>(doc: &'a Document, name: &[u8]) -> Option<&'a Object> {
    let catalog = doc.catalog().ok()?;
    if let Some(d) = catalog.get(b"Dests").ok().and_then(|o| dict(doc, o)) {
        if let Ok(v) = d.get(name) { return Some(deref(doc, v)); }
    }
    let tree = catalog.get(b"Names").ok().and_then(|o| dict(doc, o))?.get(b"Dests").ok().and_then(|o| dict(doc, o))?;
    fn search<'a>(doc: &'a Document, node: &'a Dictionary, name: &[u8], depth: usize) -> Option<&'a Object> {
        if depth > 32 { return None; }
        if let Ok(names) = node.get(b"Names").map(|o| deref(doc, o)).and_then(Object::as_array) {
            for pair in names.chunks(2) {
                if let [k, v] = pair { if deref(doc, k).as_str().ok() == Some(name) { return Some(deref(doc, v)); } }
            }
        }
        let kids = node.get(b"Kids").map(|o| deref(doc, o)).and_then(Object::as_array).ok()?;
        kids.iter().filter_map(|k| dict(doc, k)).find_map(|k| search(doc, k, name, depth + 1))
    }
    search(doc, tree, name, 0)
}

/// The page a destination points to: [page ref or index, /XYZ …], a name, or a dictionary with /D.
fn dest_page(doc: &Document, dest: &Object, pages: &HashMap<ObjectId, usize>, depth: usize) -> Option<usize> {
    if depth > 4 { return None; }
    match deref(doc, dest) {
        Object::Array(a) => match a.first()? {
            Object::Reference(id) => pages.get(id).copied(),
            Object::Integer(i) => usize::try_from(*i).ok(),
            _ => None,
        },
        Object::Name(n) => dest_page(doc, named_dest(doc, n)?, pages, depth + 1),
        Object::String(s, _) => dest_page(doc, named_dest(doc, s)?, pages, depth + 1),
        Object::Dictionary(d) => dest_page(doc, d.get(b"D").ok()?, pages, depth + 1),
        _ => None,
    }
}

fn outline_items(doc: &Document, first: Option<&Object>, pages: &HashMap<ObjectId, usize>, seen: &mut HashSet<ObjectId>, depth: usize) -> Vec<Item> {
    let mut out = Vec::new();
    let mut next = first.and_then(|o| o.as_reference().ok());
    while let Some(id) = next {
        if depth > 64 || !seen.insert(id) || out.len() > 10_000 { break; }
        let Ok(node) = doc.get_dictionary(id) else { break };
        let action = node.get(b"A").ok().and_then(|o| dict(doc, o));
        let kind = action.and_then(|a| a.get(b"S").ok()).and_then(|s| s.as_name().ok());
        let url = if kind == Some(b"URI") { action.and_then(|a| a.get(b"URI").ok()).and_then(|u| text(doc, u)) } else { None };
        let dest = node.get(b"Dest").ok().or_else(|| if kind == Some(b"GoTo") { action.and_then(|a| a.get(b"D").ok()) } else { None });
        out.push(Item {
            title: node.get(b"Title").ok().and_then(|t| text(doc, t)).unwrap_or_default(),
            page: dest.and_then(|d| dest_page(doc, d, pages, 0)),
            url,
            items: outline_items(doc, node.get(b"First").ok(), pages, seen, depth + 1),
        });
        next = node.get(b"Next").ok().and_then(|o| o.as_reference().ok());
    }
    out
}

pub fn info(bytes: &[u8], password: &str) -> Result<Info, String> {
    let mut doc = Document::load_mem(bytes).map_err(|e| e.to_string())?;
    let encrypted = doc.is_encrypted();
    if encrypted { doc.decrypt(password).map_err(|_| "encrypted".to_string())?; }
    let pages: HashMap<ObjectId, usize> = doc.get_pages().values().enumerate().map(|(i, id)| (*id, i)).collect();
    let mut out = Info { version: doc.version.clone(), encrypted, ..Default::default() };
    if let Some(d) = doc.trailer.get(b"Info").ok().and_then(|o| dict(&doc, o)) {
        let field = |k: &[u8]| d.get(k).ok().and_then(|v| text(&doc, v)).unwrap_or_default();
        let date = |k: &[u8]| { let s = field(k); if s.is_empty() { None } else { Some(pdf_date(&s).map_or(DateOrText::Text(s), DateOrText::Date)) } };
        (out.title, out.author, out.subject, out.keywords) = (field(b"Title"), field(b"Author"), field(b"Subject"), field(b"Keywords"));
        (out.creator, out.producer) = (field(b"Creator"), field(b"Producer"));
        (out.created, out.modified) = (date(b"CreationDate"), date(b"ModDate"));
    }
    let first = doc.catalog().ok().and_then(|c| c.get(b"Outlines").ok()).and_then(|o| dict(&doc, o)).and_then(|o| o.get(b"First").ok());
    out.outline = outline_items(&doc, first, &pages, &mut HashSet::new(), 0);
    Ok(out)
}

/// Properties and bookmarks of a cached source; `password` is the one the user typed when opening it (if any).
#[tauri::command]
pub async fn pdf_info(sources: State<'_, Sources>, id: u64, password: Option<String>) -> Result<Info, String> {
    let bytes = sources.get(id).ok_or("unknown source")?;
    info(&bytes, password.as_deref().unwrap_or(""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, text_string, Stream};

    #[test]
    fn dates() {
        assert_eq!(pdf_date("D:20240501143000+02'00'"), Some([2024, 5, 1, 14, 30]));
        assert_eq!(pdf_date("D:2023"), Some([2023, 1, 1, 0, 0]));
        assert_eq!(pdf_date("Monday"), None);
    }

    /// Three pages; bookmarks: a page link, a named destination with a child, and a web link.
    fn sample() -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let page_ids: Vec<ObjectId> = (0..3).map(|_| {
            let c = doc.add_object(Stream::new(dictionary! {}, vec![]));
            doc.add_object(dictionary! {"Type" => "Page", "Parent" => pages_id, "Contents" => c, "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()]})
        }).collect();
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! {"Type" => "Pages", "Count" => 3,
            "Kids" => page_ids.iter().map(|id| Object::Reference(*id)).collect::<Vec<_>>()}));
        let (o, a, b, b1, c) = (doc.new_object_id(), doc.new_object_id(), doc.new_object_id(), doc.new_object_id(), doc.new_object_id());
        doc.objects.insert(a, Object::Dictionary(dictionary! {"Title" => text_string("Einführung"), "Parent" => o, "Next" => b,
            "Dest" => vec![Object::Reference(page_ids[1]), "Fit".into()]}));
        doc.objects.insert(b, Object::Dictionary(dictionary! {"Title" => Object::string_literal("Named"), "Parent" => o, "Prev" => a, "Next" => c, "First" => b1, "Last" => b1,
            "A" => dictionary! {"S" => "GoTo", "D" => Object::string_literal("chap3")}}));
        doc.objects.insert(b1, Object::Dictionary(dictionary! {"Title" => Object::string_literal("Child"), "Parent" => b, "Dest" => vec![Object::Integer(0), "Fit".into()]}));
        doc.objects.insert(c, Object::Dictionary(dictionary! {"Title" => Object::string_literal("Web"), "Parent" => o, "Prev" => b, "Next" => a, // loop: must stop
            "A" => dictionary! {"S" => "URI", "URI" => Object::string_literal("https://example.com")}}));
        doc.objects.insert(o, Object::Dictionary(dictionary! {"Type" => "Outlines", "First" => a, "Last" => c}));
        let names = doc.add_object(dictionary! {"Names" => vec![Object::string_literal("chap3"), vec![Object::Reference(page_ids[2]), "Fit".into()].into()]});
        let cat = doc.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id, "Outlines" => o, "Names" => dictionary! {"Dests" => names}});
        let info = doc.add_object(dictionary! {"Title" => text_string("Bericht – 2024"), "Author" => Object::string_literal("Jamie"), "CreationDate" => Object::string_literal("D:20240501143000Z"), "ModDate" => Object::string_literal("gestern")});
        doc.trailer.set("Root", cat);
        doc.trailer.set("Info", info);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    #[test]
    fn properties_and_outline() {
        let i = info(&sample(), "").unwrap();
        assert_eq!((i.version.as_str(), i.encrypted, i.title.as_str(), i.author.as_str()), ("1.7", false, "Bericht – 2024", "Jamie"));
        assert_eq!(i.created, Some(DateOrText::Date([2024, 5, 1, 14, 30])));
        assert_eq!(i.modified, Some(DateOrText::Text("gestern".into())));
        let titles: Vec<(&str, Option<usize>, Option<&str>, usize)> = i.outline.iter().map(|x| (x.title.as_str(), x.page, x.url.as_deref(), x.items.len())).collect();
        assert_eq!(titles, [("Einführung", Some(1), None, 0), ("Named", Some(2), None, 1), ("Web", None, Some("https://example.com"), 0)]);
        assert_eq!((i.outline[1].items[0].title.as_str(), i.outline[1].items[0].page), ("Child", Some(0)));
    }

    /// Writes the sample to PD_SAMPLE (for trying it in the app).
    #[test]
    #[ignore]
    fn write_sample() { std::fs::write(std::env::var("PD_SAMPLE").unwrap(), sample()).unwrap(); }
}
