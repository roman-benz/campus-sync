// Seitengenauer Volltextindex in Rust (vorher src/main/docindex.js im Speicher der Oberfläche).
// Im Speicher stehen nur die normalisierten Seitentexte; Originaltexte für Ausschnitte und
// read_pages kommen bei Bedarf von der Platte. Dateiformat bleibt gleich
// (cache/text/<site>/<id>.json = { id, tm, pages }), Suche und Bewertung sind 1:1 die der JS-Version.
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use unicode_normalization::UnicodeNormalization;

// Alle normalisierten Seiten liegen hintereinander in einem einzigen String (ein großer
// Speicherblock statt Tausender kleiner) – so geht der Speicher beim Freigeben wirklich ans System zurück.
struct DocMeta {
    id: String,
    first: usize,
    n: usize,
}

#[derive(Default)]
struct Inner {
    dir: Option<PathBuf>,
    loaded: bool,
    text: String,
    spans: Vec<(usize, usize)>,
    docs: Vec<DocMeta>,
    by_id: HashMap<String, usize>,
    last_used: Option<Instant>,
}

impl Inner {
    fn page(&self, d: &DocMeta, i: usize) -> &str {
        let (a, b) = self.spans[d.first + i];
        &self.text[a..b]
    }

    fn add(&mut self, id: &str, pages: &[String]) {
        let first = self.spans.len();
        for p in pages {
            let a = self.text.len();
            self.text.push_str(&norm(p));
            self.spans.push((a, self.text.len()));
        }
        let meta = DocMeta { id: id.to_string(), first, n: pages.len() };
        // Wie Map.set in JS: ein neu indexiertes Dokument behält seinen Platz in der Reihenfolge
        match self.by_id.get(id) {
            Some(&i) => self.docs[i] = meta,
            None => {
                self.by_id.insert(id.to_string(), self.docs.len());
                self.docs.push(meta);
            }
        }
    }

    // Alle Dokumente des Ordners einlesen; liefert [id, tm, Seitenzahl]
    fn read_all(&mut self, dir: &Path) -> Vec<Value> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".json")).collect())
            .unwrap_or_default();
        names.sort();
        *self = Inner { dir: Some(dir.to_path_buf()), loaded: true, last_used: Some(Instant::now()), ..Default::default() };
        let mut list = Vec::with_capacity(names.len());
        for n in names {
            let Some(d) = std::fs::read(dir.join(&n)).ok().and_then(|b| serde_json::from_slice::<DocFile>(&b).ok()) else { continue };
            list.push(json!([d.id, d.tm, d.pages.len()]));
            self.add(&d.id, &d.pages);
        }
        self.text.shrink_to_fit();
        self.spans.shrink_to_fit();
        list
    }

    fn ensure_loaded(&mut self) {
        if !self.loaded {
            if let Some(dir) = self.dir.clone() {
                self.read_all(&dir);
            }
        }
        self.last_used = Some(Instant::now());
    }
}

#[derive(Default)]
pub struct TextIndex {
    inner: Mutex<Inner>,
}

#[derive(Deserialize)]
struct DocFile {
    id: String,
    tm: Value,
    pages: Vec<String>,
}

// Wie norm() in docindex.js: Kleinschreibung, ß→ss, Umlaute→Grundbuchstabe, Akzente entfernen
pub fn norm(s: &str) -> String {
    let l = s.to_lowercase().replace('ß', "ss").replace('ä', "a").replace('ö', "o").replace('ü', "u");
    l.nfd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect()
}

// Leerraum wie /\s/ in JavaScript
fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

// Wie snippet() in docindex.js (Positionen in UTF-16-Einheiten wie bei JS-Strings)
fn snippet(text: &str, norm_text: &str, terms: &[String]) -> String {
    const LEN: usize = 260;
    let mut pos: Option<usize> = None;
    for t in terms {
        if let Some(b) = norm_text.find(t.as_str()) {
            let p = utf16_len(&norm_text[..b]);
            if pos.map_or(true, |x| p < x) {
                pos = Some(p);
            }
        }
    }
    let pos = pos.unwrap_or(0);
    let units: Vec<u16> = text.encode_utf16().collect();
    let start = pos.saturating_sub(LEN / 3).min(units.len());
    let end = (start + LEN).min(units.len());
    let raw = String::from_utf16_lossy(&units[start..end]);
    let mut s = String::with_capacity(raw.len());
    let mut in_space = false;
    for c in raw.chars() {
        if js_space(c) {
            if !in_space {
                s.push(' ');
            }
            in_space = true;
        } else {
            s.push(c);
            in_space = false;
        }
    }
    let mut s = s.trim_matches(js_space).to_string();
    if start > 0 {
        s = format!("… {s}");
    }
    if start + LEN < units.len() {
        s.push_str(" …");
    }
    s
}

fn read_doc(dir: &Path, id: &str) -> Option<DocFile> {
    let bytes = std::fs::read(dir.join(format!("{id}.json"))).ok()?;
    serde_json::from_slice(&bytes).ok()
}

struct Hit {
    file: usize,
    page: usize,
    matched: usize,
    score: f64,
}

impl TextIndex {
    // Alle Dokumente eines Index-Ordners laden; liefert [id, tm, Seitenzahl] für die Statusanzeige
    pub fn load(&self, dir: &str) -> Value {
        let list = self.inner.lock().unwrap().read_all(Path::new(dir));
        json!({ "docs": list })
    }

    // Länger keine Suche → Texte freigeben (beim nächsten Zugriff in ~0,2 s neu geladen)
    pub fn unload_if_idle(&self, idle: Duration) {
        let mut inner = self.inner.lock().unwrap();
        if inner.loaded && inner.last_used.map_or(true, |t| t.elapsed() > idle) {
            let dir = inner.dir.take();
            *inner = Inner { dir, ..Default::default() };
        }
    }

    // Ergebnis der Textextraktion speichern (Datei + Speicher)
    pub fn put(&self, dir: &str, id: &str, tm: Value, pages: Vec<String>) -> Result<Value, String> {
        let dirp = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dirp);
        let body = serde_json::to_vec(&json!({ "id": id, "tm": tm, "pages": pages })).map_err(|e| e.to_string())?;
        std::fs::write(dirp.join(format!("{id}.json")), body).map_err(|e| e.to_string())?;
        let mut inner = self.inner.lock().unwrap();
        if inner.loaded && inner.dir.as_deref() == Some(dirp.as_path()) {
            inner.add(id, &pages);
        }
        Ok(json!({ "n": pages.len() }))
    }

    // Seiten from..to (1-basiert, schon begrenzt) eines Dokuments
    pub fn pages(&self, dir: &str, id: &str, from: usize, to: usize) -> Result<Value, String> {
        let d = read_doc(Path::new(dir), id).ok_or("Dokument ist nicht indexiert")?;
        let total = d.pages.len();
        let a = from.clamp(1, total.max(1));
        let b = to.clamp(a, total.max(a));
        let pages: Vec<Value> = d.pages.iter().enumerate().skip(a - 1).take(b + 1 - a).map(|(i, t)| json!({ "n": i + 1, "text": t })).collect();
        Ok(json!({ "total": total, "pages": pages }))
    }

    // files: [[id, norm(Dateiname + Modulname)], …] – schon nach Kurs/Datei gefiltert, aus dem Sync-Cache
    pub fn search(&self, terms: &[String], files: &[(String, String)], limit: usize, per_file: usize) -> Value {
        if terms.is_empty() {
            return json!({ "terms": terms, "hits": [] });
        }
        let mut guard = self.inner.lock().unwrap();
        guard.ensure_loaded();
        let inner = &*guard;
        let names: HashMap<&str, &str> = files.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let mut ids: Vec<&str> = Vec::new();
        let mut hits: Vec<Hit> = Vec::new();
        let mut metas: Vec<&DocMeta> = Vec::new();
        for d in &inner.docs {
            let Some(name) = names.get(d.id.as_str()) else { continue };
            let fi = ids.len();
            ids.push(d.id.as_str());
            metas.push(d);
            for i in 0..d.n {
                let t = inner.page(d, i);
                let mut matched = 0;
                let mut score = 0.0f64;
                for term in terms {
                    let mut c = 0u32;
                    let mut from = 0usize;
                    while c < 25 {
                        match t[from..].find(term.as_str()) {
                            Some(p) => {
                                c += 1;
                                from += p + term.len();
                            }
                            None => break,
                        }
                    }
                    if c > 0 {
                        matched += 1;
                        score += 3.0 + (1.0 + c as f64).log2() * 2.0;
                    }
                    if name.contains(term.as_str()) {
                        score += 2.0;
                    }
                }
                if matched == 0 {
                    continue;
                }
                let bonus = if matched == terms.len() { 50.0 } else { 0.0 };
                hits.push(Hit { file: fi, page: i + 1, matched, score: score + bonus });
            }
        }
        // Stabil sortieren wie Array.prototype.sort
        hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        let all = !hits.is_empty() && hits[0].matched == terms.len();
        let best: Vec<&Hit> = hits.iter().filter(|h| !all || h.matched == terms.len()).collect();
        let mut counts: HashMap<usize, usize> = HashMap::new();
        let mut chosen: Vec<&Hit> = Vec::new();
        for h in &best {
            let c = counts.entry(h.file).or_insert(0);
            *c += 1;
            if *c > per_file {
                continue;
            }
            chosen.push(h);
            if chosen.len() >= limit {
                break;
            }
        }
        // Originaltexte nur für die ausgegebenen Treffer von der Platte lesen
        let mut originals: HashMap<usize, Option<DocFile>> = HashMap::new();
        let dir = inner.dir.clone().unwrap_or_default();
        let out: Vec<Value> = chosen
            .iter()
            .map(|h| {
                let id = ids[h.file];
                let doc = originals.entry(h.file).or_insert_with(|| read_doc(&dir, id));
                let norm_text = inner.page(metas[h.file], h.page - 1);
                let text = doc.as_ref().and_then(|d| d.pages.get(h.page - 1)).map(|s| s.as_str()).unwrap_or(norm_text);
                json!({ "fileId": id, "page": h.page, "score": h.score.round() as i64, "snippet": snippet(text, norm_text, terms) })
            })
            .collect();
        let total_files = best.iter().map(|h| h.file).collect::<std::collections::HashSet<_>>().len();
        json!({ "terms": terms, "hits": out, "totalPages": best.len(), "totalFiles": total_files })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn norm_wie_js() {
        assert_eq!(norm("Größe Übung ÄRGER"), "grosse ubung arger");
        assert_eq!(norm("élève Café naïve"), "eleve cafe naive");
        assert_eq!(norm("STRASSE Straße"), "strasse strasse");
    }

    #[test]
    fn snippet_wie_js() {
        let text = "a".repeat(300) + " Laplace   Transformation " + &"b".repeat(300);
        let n = norm(&text);
        let s = snippet(&text, &n, &["laplace".into()]);
        assert!(s.starts_with("… "));
        assert!(s.ends_with(" …"));
        assert!(s.contains("Laplace Transformation"));
        assert_eq!(snippet("kurz", "kurz", &["x".into()]), "kurz");
    }
}

#[cfg(test)]
mod bench {
    // cargo test --release --bin chadoodle bench_load -- --ignored --nocapture  (INDEX_DIR=<cache/text/…>)
    #[test]
    #[ignore]
    fn bench_load() {
        let dir = std::env::var("INDEX_DIR").expect("INDEX_DIR");
        let idx = super::TextIndex::default();
        let t = std::time::Instant::now();
        let r = idx.load(&dir);
        println!("{} Dokumente in {:?}", r["docs"].as_array().unwrap().len(), t.elapsed());
        let t = std::time::Instant::now();
        let files: Vec<(String, String)> = r["docs"].as_array().unwrap().iter().map(|d| (d[0].as_str().unwrap().to_string(), String::new())).collect();
        let s = idx.search(&["laplace".into(), "transformation".into()], &files, 40, 4);
        println!("Suche: {} Treffer in {:?}", s["hits"].as_array().unwrap().len(), t.elapsed());
    }
}
