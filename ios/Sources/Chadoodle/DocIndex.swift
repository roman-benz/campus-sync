// Lokaler Volltextindex über alle synchronisierten Dokumente (seitengenau), wie src/main/docindex.js.
// PDFs liest PDFKit, Textdateien werden in „Seiten“ von ~3500 Zeichen geteilt.
import Foundation
import PDFKit

// Kleinschreibung + Umlaute/Akzente vereinheitlichen, damit „Größe“ auch „Grosse“ trifft
func norm(_ s: String) -> String {
    s.lowercased()
        .replacingOccurrences(of: "ß", with: "ss")
        .replacingOccurrences(of: "ä", with: "a").replacingOccurrences(of: "ö", with: "o").replacingOccurrences(of: "ü", with: "u")
        .folding(options: .diacriticInsensitive, locale: nil)
}

func parseQuery(_ q: String) -> [String] {
    let re = try! NSRegularExpression(pattern: "\"([^\"]+)\"|(\\S+)")
    var terms: [String] = []
    for m in re.matches(in: q, range: NSRange(q.startIndex..., in: q)) {
        let r = Range(m.range(at: 1), in: q) ?? Range(m.range(at: 2), in: q)!
        let t = norm(String(q[r])).trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        if t.count >= 2, !terms.contains(t) { terms.append(t) }
    }
    return terms
}

private let textExt: Set<String> = ["txt", "md", "csv", "tsv", "json", "xml", "html", "htm", "tex", "py", "java", "c", "h", "cpp", "hpp", "cs", "js", "ts",
                                    "m", "r", "sql", "vhd", "vhdl", "v", "sv", "asm", "s", "ino", "yaml", "yml", "ini", "log", "sh", "kt", "go", "rs", "php", "rb", "css"]

func canExtract(_ filename: String) -> Bool {
    let ext = (filename as NSString).pathExtension.lowercased()
    return ext == "pdf" || textExt.contains(ext)
}

struct SearchHit: Identifiable, Hashable {
    var fileId: String
    var page: Int
    var score: Int
    var snippet: String
    var id: String { "\(fileId)#\(page)" }
}

struct SearchResult {
    var terms: [String] = []
    var hits: [SearchHit] = []
    var totalPages = 0
    var totalFiles = 0
}

private struct StoredDoc: Codable {
    var id: String
    var tm: Int
    var pages: [String]
}

@MainActor
final class DocIndex: ObservableObject {
    struct Doc {
        var tm: Int
        var pages: [String]
        var normPages: [String]
    }

    @Published private(set) var docs: [String: Doc] = [:]
    @Published private(set) var running: String?
    private var dir = AppPaths.file("text/none")
    private var queue: [LocalFile] = []
    private var errors: [String: Int] = [:]
    private var worker: Task<Void, Never>?

    func attach(site: String) {
        dir = AppPaths.file("text/\(sha1(site).prefix(12))")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let d = dir
        Task.detached(priority: .utility) {
            var loaded: [String: Doc] = [:]
            for f in (try? FileManager.default.contentsOfDirectory(at: d, includingPropertiesForKeys: nil)) ?? [] where f.pathExtension == "json" {
                if let s = readJSON(f, as: StoredDoc.self) { loaded[s.id] = Doc(tm: s.tm, pages: s.pages, normPages: s.pages.map(norm)) }
            }
            await MainActor.run { self.docs = loaded }
        }
    }

    func clear() {
        try? FileManager.default.removeItem(at: dir)
        docs = [:]
    }

    func isIndexed(_ f: LocalFile) -> Bool { docs[f.id]?.tm == f.timemodified }

    func progress(_ files: [String: LocalFile]) -> (indexed: Int, total: Int) {
        let list = files.values.filter { canExtract($0.filename) }
        return (list.filter(isIndexed).count, list.count)
    }

    // Alle heruntergeladenen, noch nicht (aktuell) indexierten Dokumente einreihen
    func indexPending(_ files: [String: LocalFile]) {
        for f in files.values where f.downloaded && canExtract(f.filename) && !isIndexed(f) && errors[f.id] != f.timemodified {
            if f.filesize > 80 * 1024 * 1024 { continue }
            if !queue.contains(where: { $0.id == f.id }) { queue.append(f) }
        }
        pump()
    }

    private func pump() {
        guard worker == nil, !queue.isEmpty else { return }
        let f = queue.removeFirst()
        running = f.filename
        worker = Task {
            let pages = await Task.detached(priority: .utility) { extractPages(f.localURL, f.filename) }.value
            self.store(f, pages)
            self.worker = nil
            self.running = nil
            self.pump()
        }
    }

    private func store(_ f: LocalFile, _ pages: [String]?) {
        guard let pages else {
            errors[f.id] = f.timemodified
            return
        }
        writeJSON(dir.appendingPathComponent(f.id + ".json"), StoredDoc(id: f.id, tm: f.timemodified, pages: pages))
        docs[f.id] = Doc(tm: f.timemodified, pages: pages, normPages: pages.map(norm))
    }

    // Für die KI: Seiten eines Dokuments, bei Bedarf sofort indexieren
    func pages(of f: LocalFile) async -> [String]? {
        if isIndexed(f), let d = docs[f.id] { return d.pages }
        let pages = await Task.detached(priority: .userInitiated) { extractPages(f.localURL, f.filename) }.value
        store(f, pages)
        return pages
    }

    // Seitengenaue Volltextsuche. Treffer mit allen Begriffen zuerst, sonst die beste Teilübereinstimmung.
    func search(_ query: String, files: [String: LocalFile], courseId: Int? = nil, fileId: String? = nil, limit: Int = 40, perFile: Int = 4) -> SearchResult {
        let terms = parseQuery(query)
        guard !terms.isEmpty else { return SearchResult(terms: terms) }
        struct Raw { var fileId: String; var page: Int; var matched: Int; var score: Double }
        var hits: [Raw] = []
        for (id, d) in docs {
            guard let f = files[id], courseId == nil || f.courseId == courseId, fileId == nil || id == fileId else { continue }
            let nameNorm = norm(f.filename + " " + f.moduleName)
            for (i, t) in d.normPages.enumerated() {
                var matched = 0
                var score = 0.0
                for term in terms {
                    var c = 0
                    var from = t.startIndex
                    while c < 25, let r = t.range(of: term, range: from..<t.endIndex) {
                        c += 1
                        from = r.upperBound
                    }
                    if c > 0 { matched += 1; score += 3 + log2(Double(1 + c)) * 2 }
                    if nameNorm.contains(term) { score += 2 }
                }
                if matched > 0 { hits.append(Raw(fileId: id, page: i + 1, matched: matched, score: score + (matched == terms.count ? 50 : 0))) }
            }
        }
        hits.sort { $0.score > $1.score }
        let best = hits.first.map { $0.matched == terms.count } == true ? hits.filter { $0.matched == terms.count } : hits
        var counts: [String: Int] = [:]
        var out: [SearchHit] = []
        for h in best {
            counts[h.fileId, default: 0] += 1
            if counts[h.fileId]! > perFile { continue }
            let d = docs[h.fileId]!
            out.append(SearchHit(fileId: h.fileId, page: h.page, score: Int(h.score), snippet: snippet(d.pages[h.page - 1], d.normPages[h.page - 1], terms)))
            if out.count >= limit { break }
        }
        return SearchResult(terms: terms, hits: out, totalPages: best.count, totalFiles: Set(best.map(\.fileId)).count)
    }
}

private func snippet(_ text: String, _ normText: String, _ terms: [String], len: Int = 260) -> String {
    var pos: Int?
    for t in terms {
        if let r = normText.range(of: t) {
            let p = normText.distance(from: normText.startIndex, to: r.lowerBound)
            if pos == nil || p < pos! { pos = p }
        }
    }
    let start = max(0, (pos ?? 0) - len / 3)
    let chars = Array(text)
    guard start < chars.count else { return String(text.prefix(len)) }
    var s = String(chars[start..<min(chars.count, start + len)])
        .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespaces)
    if start > 0 { s = "… " + s }
    if start + len < chars.count { s += " …" }
    return s
}

private func chunk(_ text: String, size: Int = 3500) -> [String] {
    var out: [String] = []
    var rest = Substring(text)
    while rest.count > size {
        let limit = rest.index(rest.startIndex, offsetBy: size)
        var cut = rest[..<limit].lastIndex(of: "\n") ?? limit
        if rest.distance(from: rest.startIndex, to: cut) < size / 2 { cut = limit }
        out.append(String(rest[..<cut]))
        rest = rest[cut...]
    }
    if !rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || out.isEmpty { out.append(String(rest)) }
    return out
}

func extractPages(_ url: URL, _ filename: String) -> [String]? {
    let ext = (filename as NSString).pathExtension.lowercased()
    if ext == "pdf" {
        guard let doc = PDFDocument(url: url) else { return nil }
        return (0..<doc.pageCount).map { i in
            (doc.page(at: i)?.string ?? "")
                .replacingOccurrences(of: "[ \\t]+", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }
    guard textExt.contains(ext), let data = try? Data(contentsOf: url) else { return nil }
    var t = String(decoding: data, as: UTF8.self)
    if ext == "html" || ext == "htm" { t = stripHtml(t) }
    return chunk(t)
}
