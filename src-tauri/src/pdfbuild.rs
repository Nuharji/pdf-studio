//! Building the saved PDF in Rust (lopdf): pages from one or more source PDFs in any order, page rotation,
//! and the annotations drawn into the pages (highlights, ink, notes).
//!
//! The first source is the base document, so its bookmarks, form fields and metadata stay; pages of other
//! sources are imported. The UI sends source files once (`pdf_cache`) and then only the page list.

use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
use serde::Deserialize;
use std::{collections::HashMap, sync::Mutex};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    State,
};

/// Source PDFs the UI has opened, by id.
#[derive(Default)]
pub struct Sources(Mutex<HashMap<u64, Vec<u8>>>);

impl Sources {
    /// A copy of a cached source file.
    pub fn get(&self, id: u64) -> Option<Vec<u8>> { self.0.lock().unwrap().get(&id).cloned() }
}

#[tauri::command]
pub fn pdf_cache(sources: State<Sources>, request: Request) -> Result<u64, String> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err("expected a binary body".into()) };
    let mut map = sources.0.lock().unwrap();
    let id = map.keys().max().copied().unwrap_or(0) + 1;
    map.insert(id, bytes.to_vec());
    Ok(id)
}

#[tauri::command]
pub fn pdf_forget(sources: State<Sources>, ids: Vec<u64>) {
    let mut map = sources.0.lock().unwrap();
    for id in ids {
        map.remove(&id);
    }
}

#[derive(Deserialize)]
pub struct BuildReq {
    /// Cached source ids; index 0 is the base document.
    sources: Vec<u64>,
    pages: Vec<PageReq>,
    /// Filled-in form fields of the base document: full field name → value (text, true/false, or a choice).
    #[serde(default)]
    form: Vec<FieldVal>,
}

#[derive(Deserialize)]
pub struct FieldVal {
    name: String,
    value: serde_json::Value,
}

#[derive(Deserialize)]
pub struct PageReq {
    src: usize,
    index: usize,
    /// Page rotation in degrees (0, 90, 180, 270).
    rot: i64,
    #[serde(default)]
    annots: Vec<Annot>,
}

/// Annotations in PDF user space (the UI lays notes out, Rust draws them).
#[derive(Deserialize)]
#[serde(tag = "t")]
pub enum Annot {
    /// Highlight: rectangle [x0, y0, x1, y1], color "#rrggbb".
    #[serde(rename = "hl")]
    Highlight { r: [f64; 4], c: String },
    /// Ink stroke: points, width, color.
    #[serde(rename = "ink")]
    Ink { p: Vec<[f64; 2]>, w: f64, c: String },
    /// Note box at (x, y) with size w×h, rotated by `rot` degrees (so it reads upright), text lines at offsets.
    #[serde(rename = "note")]
    Note { x: f64, y: f64, w: f64, h: f64, rot: f64, c: String, size: f64, lines: Vec<NoteLine> },
    /// Text written onto the page (text tool): lines at their positions, in a standard font
    /// ("helv", "times" or "cour", optionally bold), rotated by `rot` degrees so it reads upright.
    #[serde(rename = "text")]
    Text { rot: f64, c: String, size: f64, font: String, #[serde(default)] bold: bool, lines: Vec<NoteLine> },
    /// Text recognized on a scanned page (OCR): invisible words over the picture, so the PDF can be searched and
    /// its text selected in any reader. Each word sits at its baseline, rotated by `rot` and stretched (`tz` %) to its width.
    #[serde(rename = "ocr")]
    Ocr { rot: f64, words: Vec<OcrWord> },
}

/// Standard fonts every PDF reader has, by the UI's names: (key, resource name, base font).
const FONTS: [(&str, &str, &str); 6] = [("helv", "CSF_helv", "Helvetica"), ("helvB", "CSF_helvB", "Helvetica-Bold"),
    ("times", "CSF_times", "Times-Roman"), ("timesB", "CSF_timesB", "Times-Bold"), ("cour", "CSF_cour", "Courier"), ("courB", "CSF_courB", "Courier-Bold")];
fn font_res(font: &str, bold: bool) -> &'static str {
    let key = format!("{font}{}", if bold { "B" } else { "" });
    FONTS.iter().find(|f| f.0 == key).map_or("CSF_helv", |f| f.1)
}

#[derive(Deserialize)]
pub struct OcrWord { x: f64, y: f64, size: f64, tz: f64, text: String }

#[derive(Deserialize)]
pub struct NoteLine {
    x: f64,
    y: f64,
    text: String,
}

fn rgb(hex: &str) -> (f64, f64, f64) {
    let h = hex.trim_start_matches('#');
    let p = |i: usize| u8::from_str_radix(h.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0) as f64 / 255.0;
    (p(0), p(2), p(4))
}

fn n(v: f64) -> String {
    let s = format!("{v:.3}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// PDF string literal in WinAnsi (characters outside it become "?").
fn pdf_text(s: &str) -> String {
    const EXTRA: &[(char, u8)] = &[('€', 0x80), ('‚', 0x82), ('ƒ', 0x83), ('„', 0x84), ('…', 0x85), ('†', 0x86), ('‡', 0x87), ('ˆ', 0x88), ('‰', 0x89),
        ('Š', 0x8A), ('‹', 0x8B), ('Œ', 0x8C), ('Ž', 0x8E), ('‘', 0x91), ('’', 0x92), ('“', 0x93), ('”', 0x94), ('•', 0x95), ('–', 0x96), ('—', 0x97),
        ('˜', 0x98), ('™', 0x99), ('š', 0x9A), ('›', 0x9B), ('œ', 0x9C), ('ž', 0x9E), ('Ÿ', 0x9F)];
    let mut out = String::from("(");
    for ch in s.chars() {
        let b = match ch as u32 {
            0x20..=0x7E | 0xA0..=0xFF => ch as u32 as u8,
            _ => EXTRA.iter().find(|(c, _)| *c == ch).map(|(_, b)| *b).unwrap_or(b'?'),
        };
        match b {
            b'(' | b')' | b'\\' => { out.push('\\'); out.push(b as char); }
            0x20..=0x7E => out.push(b as char),
            _ => out.push_str(&format!("\\{b:03o}")),
        }
    }
    out.push(')');
    out
}

fn annot_ops(list: &[Annot]) -> String {
    let mut s = String::from("q\n");
    for a in list {
        match a {
            Annot::Highlight { r, c } => {
                let (cr, cg, cb) = rgb(c);
                s += &format!("q /CSHl gs {} {} {} rg {} {} {} {} re f Q\n", n(cr), n(cg), n(cb), n(r[0]), n(r[1]), n(r[2] - r[0]), n(r[3] - r[1]));
            }
            Annot::Ink { p, w, c } => {
                if p.len() < 2 { continue; }
                let (cr, cg, cb) = rgb(c);
                s += &format!("q {} {} {} RG {} w 1 J 1 j {} {} m", n(cr), n(cg), n(cb), n(*w), n(p[0][0]), n(p[0][1]));
                for pt in &p[1..] { s += &format!(" {} {} l", n(pt[0]), n(pt[1])); }
                s += " S Q\n";
            }
            Annot::Note { x, y, w, h, rot, c, size, lines } => {
                let (cr, cg, cb) = rgb(c);
                let (sin, cos) = rot.to_radians().sin_cos();
                s += &format!("q {} {} {} {} {} {} cm 1 0.97 0.7 rg {} {} {} RG 1 w 0 0 {} {} re B Q\n",
                    n(cos), n(sin), n(-sin), n(cos), n(*x), n(*y), n(cr), n(cg), n(cb), n(*w), n(*h));
                for l in lines {
                    s += &format!("BT /CSHelv {} Tf 0.13 0.13 0.13 rg {} {} {} {} {} {} Tm {} Tj ET\n",
                        n(*size), n(cos), n(sin), n(-sin), n(cos), n(l.x), n(l.y), pdf_text(&l.text));
                }
            }
            Annot::Ocr { rot, words } => {
                // q … Q keeps render mode 3 (invisible) and the stretching away from later annotations.
                let (sin, cos) = rot.to_radians().sin_cos();
                s += "q BT 3 Tr\n";
                for w in words.iter().filter(|w| !w.text.trim().is_empty() && w.size > 0.0) {
                    s += &format!("/CSF_helv {} Tf {} Tz {} {} {} {} {} {} Tm {} Tj\n",
                        n(w.size), n(w.tz.clamp(1.0, 1000.0)), n(cos), n(sin), n(-sin), n(cos), n(w.x), n(w.y), pdf_text(&w.text));
                }
                s += "ET Q\n";
            }
            Annot::Text { rot, c, size, font, bold, lines } => {
                let (cr, cg, cb) = rgb(c);
                let (sin, cos) = rot.to_radians().sin_cos();
                for l in lines.iter().filter(|l| !l.text.is_empty()) {
                    s += &format!("BT /{} {} Tf {} {} {} rg {} {} {} {} {} {} Tm {} Tj ET\n",
                        font_res(font, *bold), n(*size), n(cr), n(cg), n(cb), n(cos), n(sin), n(-sin), n(cos), n(l.x), n(l.y), pdf_text(&l.text));
                }
            }
        }
    }
    s + "Q\n"
}

/// Attributes a page may inherit from its parents in the page tree; set on the page itself before re-parenting.
fn flatten_inherited(doc: &mut Document, page: ObjectId) {
    let mut found: Vec<(&'static [u8], Object)> = Vec::new();
    let Ok(dict) = doc.get_dictionary(page) else { return };
    let mut parent = dict.get(b"Parent").and_then(Object::as_reference).ok();
    let mut missing: Vec<&'static [u8]> = [&b"Resources"[..], b"MediaBox", b"CropBox", b"Rotate"].into_iter().filter(|k| !dict.has(k)).collect();
    while let (Some(pid), false) = (parent, missing.is_empty()) {
        let Ok(pd) = doc.get_dictionary(pid) else { break };
        missing.retain(|k| match pd.get(k) { Ok(v) => { found.push((*k, v.clone())); false } Err(_) => true });
        parent = pd.get(b"Parent").and_then(Object::as_reference).ok();
    }
    if let Ok(d) = doc.get_dictionary_mut(page) {
        for (k, v) in found { d.set(k, v); }
    }
}

#[cfg(test)]
pub fn build(sources: &[Vec<u8>], pages: &[PageReq]) -> Result<Vec<u8>, String> { build_form(sources, pages, &[]) }

pub fn build_form(sources: &[Vec<u8>], pages: &[PageReq], form: &[FieldVal]) -> Result<Vec<u8>, String> {
    let load = |b: &Vec<u8>| -> Result<Document, String> {
        let mut d = Document::load_mem(b).map_err(|e| e.to_string())?;
        if d.is_encrypted() {
            d.decrypt("").map_err(|_| "encrypted".to_string())?;
        }
        Ok(d)
    };
    let mut base = load(sources.first().ok_or("no source")?)?;
    // Page ids per source, after importing them into the base document.
    let mut page_ids: Vec<Vec<ObjectId>> = vec![base.get_pages().values().copied().collect()];
    for p in &page_ids[0].clone() { flatten_inherited(&mut base, *p); }
    for (i, bytes) in sources.iter().enumerate().skip(1) {
        if !pages.iter().any(|p| p.src == i) { page_ids.push(Vec::new()); continue; }
        let mut other = load(bytes)?;
        other.renumber_objects_with(base.max_id + 1);
        let ids: Vec<ObjectId> = other.get_pages().values().copied().collect();
        for p in &ids { flatten_inherited(&mut other, *p); }
        base.max_id = base.max_id.max(other.max_id);
        // Everything but the other file's catalog and page-tree nodes comes along (pruned later if unused).
        for (id, obj) in other.objects {
            let skip = obj.as_dict().ok().and_then(|d| d.get(b"Type").ok()).is_some_and(|t| matches!(t.as_name(), Ok(b"Catalog") | Ok(b"Pages")));
            if !skip { base.objects.insert(id, obj); }
        }
        page_ids.push(ids);
    }

    let root_pages = base.catalog().map_err(|e| e.to_string())?.get(b"Pages").and_then(Object::as_reference).map_err(|e| e.to_string())?;
    let mut kids = Vec::new();
    let mut used = std::collections::HashSet::new();
    let helv = base.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding" });
    let hl_gs = base.add_object(dictionary! { "Type" => "ExtGState", "ca" => 0.4, "BM" => "Multiply" });
    let fonts: Vec<(&str, ObjectId)> = FONTS.iter().map(|(_, res, name)| (*res, base.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => *name, "Encoding" => "WinAnsiEncoding" }))).collect();
    for p in pages {
        let src_id = *page_ids.get(p.src).and_then(|v| v.get(p.index)).ok_or("page missing")?;
        // A page used twice gets its own copy (each can have its own rotation and annotations).
        let id = if used.insert(src_id) { src_id } else {
            let copy = base.get_object(src_id).map_err(|e| e.to_string())?.clone();
            base.add_object(copy)
        };
        let mut contents_extra = None;
        if !p.annots.is_empty() {
            let pre = base.add_object(Stream::new(Dictionary::new(), b"q\n".to_vec()));
            let post = base.add_object(Stream::new(Dictionary::new(), format!("Q\n{}", annot_ops(&p.annots)).into_bytes()));
            contents_extra = Some((pre, post));
        }
        // Resources may be shared with other pages: give this page its own dictionary before adding font / state.
        let resources = match base.get_dictionary(id).ok().and_then(|d| d.get(b"Resources").ok()).cloned() {
            Some(Object::Reference(r)) => base.get_dictionary(r).cloned().unwrap_or_default(),
            Some(Object::Dictionary(d)) => d,
            _ => Dictionary::new(),
        };
        let mut resources = resources;
        if contents_extra.is_some() {
            let text_fonts = fonts.iter().map(|(res, id)| (&b"Font"[..], res.as_bytes(), *id));
            for (key, name, obj) in [(&b"Font"[..], &b"CSHelv"[..], helv), (b"ExtGState", b"CSHl", hl_gs)].into_iter().chain(text_fonts) {
                let mut sub = match resources.get(key).cloned() {
                    Ok(Object::Reference(r)) => base.get_dictionary(r).cloned().unwrap_or_default(),
                    Ok(Object::Dictionary(d)) => d,
                    _ => Dictionary::new(),
                };
                sub.set(name, Object::Reference(obj));
                resources.set(key, Object::Dictionary(sub));
            }
        }
        let page = base.get_dictionary_mut(id).map_err(|e| e.to_string())?;
        page.set("Parent", Object::Reference(root_pages));
        page.set("Rotate", Object::Integer(p.rot.rem_euclid(360)));
        if contents_extra.is_some() { page.set("Resources", Object::Dictionary(resources)); }
        if let Some((pre, post)) = contents_extra {
            let mut list = vec![Object::Reference(pre)];
            match page.get(b"Contents").cloned() {
                Ok(Object::Array(a)) => list.extend(a),
                Ok(other) => list.push(other),
                Err(_) => {}
            }
            list.push(Object::Reference(post));
            page.set("Contents", Object::Array(list));
        }
        kids.push(Object::Reference(id));
    }
    let count = kids.len() as i64;
    let root = base.get_dictionary_mut(root_pages).map_err(|e| e.to_string())?;
    root.set("Kids", Object::Array(kids));
    root.set("Count", Object::Integer(count));
    root.remove(b"Parent");
    if !form.is_empty() { fill_form(&mut base, form)?; }
    base.prune_objects();
    let mut out = Vec::new();
    base.save_to(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

#[tauri::command]
pub async fn pdf_build(sources: State<'_, Sources>, req: BuildReq) -> Result<Response, String> {
    let bytes: Vec<Vec<u8>> = {
        let map = sources.0.lock().unwrap();
        req.sources.iter().map(|id| map.get(id).cloned().ok_or("source closed".to_string())).collect::<Result<_, _>>()?
    };
    build_form(&bytes, &req.pages, &req.form).map(Response::new)
}

/* ================= Forms ================= */

/// A PDF text string: PDFDocEncoding (Latin-1 here) when it fits, else UTF-16BE with BOM.
fn text_obj(s: &str) -> Object {
    let bytes = if s.chars().all(|c| (c as u32) < 0x100 && !matches!(c as u32, 0x7F..=0x9F)) { s.chars().map(|c| c as u32 as u8).collect() }
        else { let mut b = vec![0xFE, 0xFF]; for u in s.encode_utf16() { b.extend(u.to_be_bytes()); } b };
    Object::String(bytes, lopdf::StringFormat::Literal)
}
fn text_of_obj(o: &Object) -> String {
    match o {
        Object::String(b, _) if b.starts_with(&[0xFE, 0xFF]) => String::from_utf16_lossy(&b[2..].chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect::<Vec<_>>()),
        Object::String(b, _) => b.iter().map(|&c| c as char).collect(),
        _ => String::new(),
    }
}
fn deref<'a>(doc: &'a Document, o: &'a Object) -> Option<&'a Dictionary> {
    match o { Object::Reference(r) => doc.get_dictionary(*r).ok(), Object::Dictionary(d) => Some(d), _ => None }
}
/// A field entry, looked up through the parents (FT, Ff, DA are inherited).
fn inherited(doc: &Document, id: ObjectId, key: &[u8]) -> Option<Object> {
    let mut cur = Some(id);
    for _ in 0..32 {
        let d = doc.get_dictionary(cur?).ok()?;
        if let Ok(v) = d.get(key) { return Some(v.clone()); }
        cur = d.get(b"Parent").and_then(Object::as_reference).ok();
    }
    None
}
/// The full name "parent.child" of a field.
fn full_name(doc: &Document, id: ObjectId) -> String {
    let (mut parts, mut cur) = (Vec::new(), Some(id));
    for _ in 0..32 {
        let Some(c) = cur else { break };
        let Ok(d) = doc.get_dictionary(c) else { break };
        if let Ok(t) = d.get(b"T") { parts.push(text_of_obj(t)); }
        cur = d.get(b"Parent").and_then(Object::as_reference).ok();
    }
    parts.reverse();
    parts.join(".")
}
/// All terminal fields of the form (fields whose kids are only widgets) with their widget annotations.
fn form_fields(doc: &Document) -> Vec<(ObjectId, Vec<ObjectId>)> {
    let Ok(cat) = doc.catalog() else { return vec![] };
    let Some(af) = cat.get(b"AcroForm").ok().and_then(|o| deref(doc, o)) else { return vec![] };
    let Ok(fields) = af.get(b"Fields").and_then(Object::as_array) else { return vec![] };
    let mut out = Vec::new();
    let mut stack: Vec<ObjectId> = fields.iter().filter_map(|o| o.as_reference().ok()).collect();
    while let Some(id) = stack.pop() {
        let Ok(d) = doc.get_dictionary(id) else { continue };
        let kids: Vec<ObjectId> = d.get(b"Kids").and_then(Object::as_array).map(|a| a.iter().filter_map(|o| o.as_reference().ok()).collect()).unwrap_or_default();
        let sub: Vec<ObjectId> = kids.iter().copied().filter(|k| doc.get_dictionary(*k).is_ok_and(|kd| kd.has(b"T"))).collect();
        if !sub.is_empty() { stack.extend(sub); continue; }
        let widgets = if kids.is_empty() { vec![id] } else { kids };
        out.push((id, widgets));
    }
    out
}
/// The "on" state of a checkbox or radio widget: the appearance name that isn't Off.
fn on_state(doc: &Document, widget: ObjectId) -> Option<Vec<u8>> {
    let d = doc.get_dictionary(widget).ok()?;
    let n = d.get(b"AP").ok().and_then(|o| deref(doc, o))?.get(b"N").ok().and_then(|o| deref(doc, o))?;
    n.iter().map(|(k, _)| k.clone()).find(|k| k != b"Off")
}
/// A plain appearance for a filled text field: the text in Helvetica, sized by the field's DA (auto: fits the height).
fn text_appearance(doc: &mut Document, widget: ObjectId, da: &str, text: &str, multiline: bool, helv: ObjectId) -> Option<ObjectId> {
    let r = doc.get_dictionary(widget).ok()?.get(b"Rect").and_then(Object::as_array).ok()?.iter().filter_map(|o| o.as_float().ok()).collect::<Vec<_>>();
    if r.len() != 4 { return None; }
    let (w, h) = ((r[2] - r[0]).abs() as f64, (r[3] - r[1]).abs() as f64);
    // "/Helv 0 Tf 0 g": size 0 means automatic; the color operators after Tf are kept.
    let toks: Vec<&str> = da.split_whitespace().collect();
    let tf = toks.iter().position(|t| *t == "Tf");
    let given = tf.and_then(|i| toks.get(i - 1)).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
    let color = tf.map(|i| toks[i + 1..].join(" ")).filter(|c| !c.is_empty()).unwrap_or_else(|| "0 g".into());
    let lines: Vec<&str> = if multiline { text.split('\n').collect() } else { vec![text.lines().next().unwrap_or("")] };
    let size = if given > 0.0 { given } else if multiline { 10.0 } else { (h * 0.65).clamp(4.0, 14.0) };
    let mut ops = format!("/Tx BMC\nq 1 1 {} {} re W n BT /Helv {} Tf {}\n", n(w - 2.0), n(h - 2.0), n(size), color);
    for (i, l) in lines.iter().enumerate() {
        let y = if multiline { h - 2.0 - size * (i as f64 + 1.0) } else { (h - size * 0.72) / 2.0 };
        ops += &format!("1 0 0 1 2 {} Tm {} Tj\n", n(y), pdf_text(l));
    }
    ops += "ET Q\nEMC\n";
    let res = dictionary! { "Font" => dictionary! { "Helv" => helv } };
    Some(doc.add_object(Stream::new(dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), (w as f32).into(), (h as f32).into()], "Resources" => res }, ops.into_bytes())))
}

/// Writes the filled-in values into the form fields of the document: value (/V), the checked state of check boxes and
/// radio buttons (/AS) and a fresh appearance for text fields; viewers are asked to redraw the rest (NeedAppearances).
pub fn fill_form(doc: &mut Document, form: &[FieldVal]) -> Result<(), String> {
    let fields = form_fields(doc);
    if fields.is_empty() { return Ok(()); }
    let helv = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding" });
    let af_default_da = doc.catalog().ok().and_then(|c| c.get(b"AcroForm").ok().and_then(|o| deref(doc, o)).and_then(|a| a.get(b"DA").ok().map(text_of_obj)));
    for fv in form {
        let Some((id, widgets)) = fields.iter().find(|(id, _)| full_name(doc, *id) == fv.name).cloned() else { continue };
        let ft = inherited(doc, id, b"FT").and_then(|o| o.as_name().ok().map(|n| n.to_vec())).unwrap_or_default();
        let ff = inherited(doc, id, b"Ff").and_then(|o| o.as_i64().ok()).unwrap_or(0);
        match ft.as_slice() {
            b"Tx" => {
                let text = fv.value.as_str().map(str::to_string).unwrap_or_else(|| fv.value.to_string());
                let da = inherited(doc, id, b"DA").map(|o| text_of_obj(&o)).or(af_default_da.clone()).unwrap_or_else(|| "/Helv 0 Tf 0 g".into());
                doc.get_dictionary_mut(id).map_err(|e| e.to_string())?.set("V", text_obj(&text));
                for w in &widgets {
                    if let Some(ap) = text_appearance(doc, *w, &da, &text, ff & (1 << 12) != 0, helv) {
                        doc.get_dictionary_mut(*w).map_err(|e| e.to_string())?.set("AP", dictionary! { "N" => ap });
                    }
                }
            }
            b"Btn" if ff & (1 << 16) != 0 => {} // push button
            b"Btn" => {
                let radio = ff & (1 << 15) != 0;
                let want: Option<Vec<u8>> = match &fv.value {
                    serde_json::Value::Bool(true) => None,
                    serde_json::Value::Bool(false) | serde_json::Value::Null => Some(b"Off".to_vec()),
                    serde_json::Value::String(s) if s == "Off" || s.is_empty() => Some(b"Off".to_vec()),
                    serde_json::Value::String(s) => Some(s.as_bytes().to_vec()),
                    _ => None,
                };
                let mut value = b"Off".to_vec();
                for w in &widgets {
                    let on = on_state(doc, *w).unwrap_or_else(|| b"Yes".to_vec());
                    // A check box is on with `true` (or its own state name); a radio button when its state is the value.
                    let set = match &want { None => !radio, Some(v) => v != b"Off" && *v == on };
                    if set { value = on.clone(); }
                    doc.get_dictionary_mut(*w).map_err(|e| e.to_string())?.set("AS", Object::Name(if set { on } else { b"Off".to_vec() }));
                }
                doc.get_dictionary_mut(id).map_err(|e| e.to_string())?.set("V", Object::Name(value));
            }
            b"Ch" => {
                let text = fv.value.as_str().unwrap_or_default().to_string();
                doc.get_dictionary_mut(id).map_err(|e| e.to_string())?.set("V", text_obj(&text));
                for w in &widgets { if let Ok(d) = doc.get_dictionary_mut(*w) { d.remove(b"AP"); } }
            }
            _ => {}
        }
    }
    // Other viewers redraw fields whose appearance we left to them (choice fields).
    let af_ref = doc.catalog().map_err(|e| e.to_string())?.get(b"AcroForm").cloned().map_err(|e| e.to_string())?;
    match af_ref {
        Object::Reference(r) => { doc.get_dictionary_mut(r).map_err(|e| e.to_string())?.set("NeedAppearances", true); }
        Object::Dictionary(mut d) => {
            d.set("NeedAppearances", true);
            let root = doc.trailer.get(b"Root").and_then(Object::as_reference).map_err(|e| e.to_string())?;
            doc.get_dictionary_mut(root).map_err(|e| e.to_string())?.set("AcroForm", Object::Dictionary(d));
        }
        _ => {}
    }
    Ok(())
}

/// A PDF of `n` blank pages of w×h points (1–500 pages). The UI opens it as one more source and inserts its pages.
pub fn blank_pdf(w: f64, h: f64, n: usize) -> Result<Vec<u8>, String> {
    if !(w.is_finite() && h.is_finite() && (36.0..=14400.0).contains(&w) && (36.0..=14400.0).contains(&h)) {
        return Err("page size out of range".into());
    }
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let content = doc.add_object(Stream::new(Dictionary::new(), Vec::new()));
    let kids: Vec<Object> = (0..n.clamp(1, 500)).map(|_| Object::Reference(doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), (w as f32).into(), (h as f32).into()],
        "Contents" => content, "Resources" => Dictionary::new() }))).collect();
    let count = kids.len() as i64;
    doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => count }));
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

#[tauri::command]
pub fn pdf_blank(w: f64, h: f64, n: usize) -> Result<Response, String> {
    blank_pdf(w, h, n).map(Response::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::content::{Content, Operation};

    #[test]
    fn blank_pages_insert_and_annotate() {
        let blank = blank_pdf(595.28, 841.89, 3).unwrap();
        let doc = Document::load_mem(&blank).unwrap();
        assert_eq!(doc.get_pages().len(), 3);
        let first = *doc.get_pages().values().next().unwrap();
        let mb = doc.get_dictionary(first).unwrap().get(b"MediaBox").unwrap().as_array().unwrap().clone();
        assert!((mb[3].as_float().unwrap() - 841.89).abs() < 0.01);
        assert!(blank_pdf(10.0, 10.0, 1).is_err());
        // Two blank pages between pages of another file; one of them gets text.
        let a = blank_pdf(612.0, 792.0, 1).unwrap();
        let pages = vec![
            PageReq { src: 0, index: 0, rot: 0, annots: vec![] },
            PageReq { src: 1, index: 0, rot: 0, annots: vec![Annot::Text { rot: 0.0, c: "#000000".into(), size: 12.0, font: "helv".into(), bold: false,
                lines: vec![NoteLine { x: 72.0, y: 700.0, text: "Neu".into() }] }] },
            PageReq { src: 1, index: 1, rot: 0, annots: vec![] },
        ];
        let out = build(&[a, blank], &pages).unwrap();
        let doc = Document::load_mem(&out).unwrap();
        let ids: Vec<ObjectId> = doc.get_pages().values().copied().collect();
        assert_eq!(ids.len(), 3);
        assert!(text_of(&doc, ids[1]).contains("(Neu)"));
        assert!(!text_of(&doc, ids[2]).contains("(Neu)"));
    }

    /// A small PDF with `count` pages, each showing its number.
    fn sample(count: usize, label: &str) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Courier" });
        let resources = doc.add_object(dictionary! { "Font" => dictionary! { "F1" => font } });
        let mut kids = vec![];
        for i in 0..count {
            let content = Content { operations: vec![
                Operation::new("BT", vec![]), Operation::new("Tf", vec!["F1".into(), 24.into()]),
                Operation::new("Td", vec![100.into(), 600.into()]), Operation::new("Tj", vec![Object::string_literal(format!("{label}{}", i + 1))]),
                Operation::new("ET", vec![]) ] };
            let cid = doc.add_object(Stream::new(Dictionary::new(), content.encode().unwrap()));
            kids.push(doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "Contents" => cid }).into());
        }
        // Resources and MediaBox are inherited from the page tree (a common case).
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => count as i64,
            "Resources" => resources, "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()] }));
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    fn text_of(doc: &Document, page: ObjectId) -> String {
        String::from_utf8_lossy(&doc.get_page_content(page).unwrap()).into_owned()
    }

    #[test]
    fn reorder_merge_rotate_annotate() {
        let (a, b) = (sample(3, "A"), sample(2, "B"));
        let pages = vec![
            PageReq { src: 0, index: 2, rot: 90, annots: vec![] },
            PageReq { src: 1, index: 0, rot: 0, annots: vec![
                Annot::Highlight { r: [10.0, 10.0, 110.0, 40.0], c: "#ffd400".into() },
                Annot::Ink { p: vec![[0.0, 0.0], [50.0, 50.0], [80.0, 20.0]], w: 2.0, c: "#e5384f".into() },
                Annot::Note { x: 200.0, y: 300.0, w: 120.0, h: 40.0, rot: 0.0, c: "#ffd400".into(), size: 11.0,
                    lines: vec![NoteLine { x: 206.0, y: 320.0, text: "Grüße (1) €".into() }] },
                Annot::Ocr { rot: 0.0, words: vec![OcrWord { x: 72.0, y: 600.0, size: 11.0, tz: 92.5, text: "Übung".into() }] },
                Annot::Text { rot: 0.0, c: "#1e5bd6".into(), size: 18.0, font: "times".into(), bold: true,
                    lines: vec![NoteLine { x: 50.0, y: 700.0, text: "Hallo".into() }, NoteLine { x: 50.0, y: 678.0, text: String::new() }] } ] },
            PageReq { src: 0, index: 0, rot: 0, annots: vec![] },
            PageReq { src: 0, index: 0, rot: 180, annots: vec![] },
        ];
        let out = build(&[a, b], &pages).unwrap();
        let doc = Document::load_mem(&out).unwrap();
        let ids: Vec<ObjectId> = doc.get_pages().values().copied().collect();
        assert_eq!(ids.len(), 4);
        assert!(text_of(&doc, ids[0]).contains("(A3)"));
        assert!(text_of(&doc, ids[1]).contains("(B1)"));
        assert!(text_of(&doc, ids[2]).contains("(A1)"));
        assert!(text_of(&doc, ids[3]).contains("(A1)"));
        let rot = |i: usize| doc.get_dictionary(ids[i]).unwrap().get(b"Rotate").unwrap().as_i64().unwrap();
        assert_eq!((rot(0), rot(1), rot(2), rot(3)), (90, 0, 0, 180));
        let annotated = text_of(&doc, ids[1]);
        assert!(annotated.contains("/CSHl gs") && annotated.contains(" re f") && annotated.contains(" l S") && annotated.contains("/CSHelv"));
        assert!(annotated.contains("(Gr\\374\\337e \\(1\\) \\200)"), "{annotated}");
        assert!(annotated.contains("q BT 3 Tr\n/CSF_helv 11 Tf 92.5 Tz 1 0 -0 1 72 600 Tm (\\334bung) Tj\nET Q\n"), "{annotated}");
        assert!(annotated.find("ET Q\n").unwrap() < annotated.find("BT /CSF_timesB").unwrap(), "visible text after the OCR block");
        assert!(annotated.contains("BT /CSF_timesB 18 Tf 0.118 0.357 0.839 rg 1 0 -0 1 50 700 Tm (Hallo) Tj ET"), "{annotated}");
        let res = doc.get_dictionary(ids[1]).unwrap().get(b"Resources").unwrap().as_dict().unwrap();
        let fonts = res.get(b"Font").unwrap().as_dict().unwrap();
        assert!(fonts.has(b"CSF_timesB") && fonts.has(b"CSF_cour"));
        // Inherited MediaBox/Resources survive re-parenting.
        let p0 = doc.get_dictionary(ids[0]).unwrap();
        assert!(p0.has(b"MediaBox") && p0.has(b"Resources"));
    }

    /// A one-page PDF with a form: text field "name", check box "ok", radio group "class" (states "a" and "b").
    fn form_pdf() -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let page_id = doc.new_object_id();
        let ap = |doc: &mut Document, name: &str| { let on = doc.add_object(Stream::new(Dictionary::new(), vec![])); let off = doc.add_object(Stream::new(Dictionary::new(), vec![]));
            dictionary! { "N" => dictionary! { name => on, "Off" => off } } };
        let name = doc.add_object(dictionary! { "Type" => "Annot", "Subtype" => "Widget", "FT" => "Tx", "T" => Object::string_literal("name"), "Rect" => vec![50.into(), 700.into(), 250.into(), 720.into()], "P" => page_id, "DA" => Object::string_literal("/Helv 0 Tf 0 0 1 rg") });
        let ok_ap = ap(&mut doc, "Yes");
        let ok = doc.add_object(dictionary! { "Type" => "Annot", "Subtype" => "Widget", "FT" => "Btn", "T" => Object::string_literal("ok"), "Rect" => vec![50.into(), 650.into(), 62.into(), 662.into()], "AS" => "Off", "AP" => ok_ap, "P" => page_id });
        let group = doc.new_object_id();
        let (ra, rb) = (ap(&mut doc, "a"), ap(&mut doc, "b"));
        let wa = doc.add_object(dictionary! { "Type" => "Annot", "Subtype" => "Widget", "Parent" => group, "Rect" => vec![50.into(), 600.into(), 62.into(), 612.into()], "AS" => "Off", "AP" => ra, "P" => page_id });
        let wb = doc.add_object(dictionary! { "Type" => "Annot", "Subtype" => "Widget", "Parent" => group, "Rect" => vec![80.into(), 600.into(), 92.into(), 612.into()], "AS" => "Off", "AP" => rb, "P" => page_id });
        doc.objects.insert(group, Object::Dictionary(dictionary! { "FT" => "Btn", "Ff" => 1 << 15, "T" => Object::string_literal("class"), "Kids" => vec![wa.into(), wb.into()] }));
        let content = doc.add_object(Stream::new(Dictionary::new(), vec![]));
        doc.objects.insert(page_id, Object::Dictionary(dictionary! { "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Contents" => content, "Annots" => vec![name.into(), ok.into(), wa.into(), wb.into()] }));
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1 }));
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id, "AcroForm" => dictionary! { "Fields" => vec![name.into(), ok.into(), group.into()] } });
        doc.trailer.set("Root", catalog);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    #[test]
    fn fill_form_fields() {
        let src = form_pdf();
        let form = vec![FieldVal { name: "name".into(), value: serde_json::json!("Jamie Groß") }, FieldVal { name: "ok".into(), value: serde_json::json!(true) },
            FieldVal { name: "class".into(), value: serde_json::json!("b") }, FieldVal { name: "missing".into(), value: serde_json::json!("x") }];
        let out = build_form(&[src], &[PageReq { src: 0, index: 0, rot: 0, annots: vec![] }], &form).unwrap();
        let doc = Document::load_mem(&out).unwrap();
        let fields = form_fields(&doc);
        let get = |n: &str| fields.iter().find(|(id, _)| full_name(&doc, *id) == n).cloned().unwrap();
        let (name, _) = get("name");
        assert_eq!(text_of_obj(doc.get_dictionary(name).unwrap().get(b"V").unwrap()), "Jamie Groß");
        let ap = doc.get_dictionary(name).unwrap().get(b"AP").unwrap().as_dict().unwrap().get(b"N").unwrap().as_reference().unwrap();
        let stream = String::from_utf8_lossy(&doc.get_object(ap).unwrap().as_stream().unwrap().content).to_string();
        assert!(stream.contains("(Jamie Gro\\337) Tj") && stream.contains("0 0 1 rg"), "{stream}");
        let (ok, _) = get("ok");
        let okd = doc.get_dictionary(ok).unwrap();
        assert_eq!((okd.get(b"V").unwrap().as_name().unwrap(), okd.get(b"AS").unwrap().as_name().unwrap()), (&b"Yes"[..], &b"Yes"[..]));
        let (group, widgets) = get("class");
        assert_eq!(doc.get_dictionary(group).unwrap().get(b"V").unwrap().as_name().unwrap(), b"b");
        let states: Vec<Vec<u8>> = widgets.iter().map(|w| doc.get_dictionary(*w).unwrap().get(b"AS").unwrap().as_name().unwrap().to_vec()).collect();
        assert_eq!(states, vec![b"Off".to_vec(), b"b".to_vec()]);
        let af = doc.catalog().unwrap().get(b"AcroForm").unwrap().as_dict().unwrap();
        assert_eq!(af.get(b"NeedAppearances").unwrap().as_bool().unwrap(), true);
    }

    /// `PDF_FORM_SAMPLE=/path/form.pdf cargo test form_sample` writes the test form to look at.
    #[test]
    fn form_sample() {
        if let Ok(p) = std::env::var("PDF_FORM_SAMPLE") { std::fs::write(p, form_pdf()).unwrap(); }
    }
}
