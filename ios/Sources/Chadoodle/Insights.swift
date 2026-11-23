// Abgeleitete Infos wie src/renderer/insights.js: laufende Vorlesung, passender Moodle-Kurs und der
// genaue Notenschnitt aus Dualis. Reine Logik ohne Oberfläche.
import Foundation

// ---------- Laufende und nächste Vorlesung ----------
func lectureNow(_ events: [TTEvent], at now: Date = Date()) -> (running: TTEvent?, next: TTEvent?) {
    let timed = events.filter { !$0.allDay }
    let running = timed.filter { $0.start <= now && $0.end > now }.min { $0.end < $1.end }
    let next = timed.filter { $0.start > now }.min { $0.start < $1.start }
    return (running, next)
}

// ---------- Vorlesung → Moodle-Kurs ----------
private let stopWords: Set<String> = ["und", "der", "die", "das", "des", "den", "dem", "fuer", "mit", "von", "zur", "zum", "im", "in", "an", "auf", "am",
                                      "the", "and", "of", "for", "to", "teil", "vorlesung", "uebung", "labor", "seminar", "tutorium", "klausur", "pruefung", "kurs", "grundlagen"]
private let roman: [String: Int] = ["i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7, "viii": 8, "ix": 9, "x": 10]

private func normalized(_ s: String) -> String {
    var t = s.lowercased()
    for (a, b) in [("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")] { t = t.replacingOccurrences(of: a, with: b) }
    t = t.folding(options: .diacriticInsensitive, locale: nil)
    return t.replacingOccurrences(of: "[^a-z0-9]+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
}

private func tokens(_ s: String) -> (words: [String], nums: Set<Int>) {
    var words: [String] = []
    var nums = Set<Int>()
    for t in normalized(s).split(separator: " ").map(String.init) {
        if let n = roman[t] { nums.insert(n) }
        else if t.count <= 2, let n = Int(t) { nums.insert(n) }
        else if t.count >= 4, t.range(of: "^[a-z]+[0-9]$", options: .regularExpression) != nil, let n = Int(String(t.last!)) {
            words.append(String(t.dropLast()))
            nums.insert(n)
        } else if t.count >= 2, !stopWords.contains(t), t.range(of: "[0-9]{3,}", options: .regularExpression) == nil {
            words.append(t)
        }
    }
    return (words, nums)
}

// Titel ohne Dozentenkürzel und Zusätze in Klammern
func cleanLectureTitle(_ t: String) -> String {
    t.replacingOccurrences(of: "\\([^)]*\\)", with: " ", options: .regularExpression)
        .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
}

func courseMatchScore(_ title: String, _ course: Course) -> Double {
    let a = tokens(cleanLectureTitle(title))
    guard !a.words.isEmpty else { return 0 }
    let b = tokens("\(course.fullname) \(course.shortname)")
    let set = Set(b.words)
    var hit = 0.0
    for w in a.words {
        if set.contains(w) { hit += 1 }
        else if w.count >= 5, b.words.contains(where: { c in c.count >= 5 && (c.hasPrefix(String(w.prefix(6))) || w.hasPrefix(String(c.prefix(6)))) }) { hit += 0.6 }
    }
    var s = hit / Double(a.words.count)
    if !a.nums.isEmpty && !b.nums.isEmpty { s += a.nums.isDisjoint(with: b.nums) ? -0.6 : 0.15 }
    return s
}

// Bester Kurs für einen Vorlesungstitel oder nil; bei Gleichstand gewinnt der zuletzt geöffnete
func courseFor(_ title: String, in courses: [Course]) -> Course? {
    var best: (Course, Int, Int)?
    for k in courses where !k.hidden {
        let s = courseMatchScore(title, k)
        guard s >= 0.6 else { continue }
        let key = (Int((s * 100).rounded()), k.lastaccess ?? 0)
        if best == nil || key.0 > best!.1 || (key.0 == best!.1 && key.1 > best!.2) { best = (k, key.0, key.1) }
    }
    return best?.0
}

// ---------- Dualis: genauer Notenschnitt ----------
// Dualis zeigt den GPA nur mit einer Nachkommastelle. Gerechnet wird der nach Credits gewichtete
// Schnitt aller bestandenen Module; übernommen wird er nur, wenn er gerundet oder abgeschnitten zur
// Anzeige von Dualis passt.
func gradeNumber(_ s: String?) -> Double? {
    guard let s, let n = Double(s.replacingOccurrences(of: ",", with: ".").trimmingCharacters(in: .whitespaces)) else { return nil }
    return n
}

private func weightedGrade(_ mods: [DualisModule]) -> Double? {
    var sum = 0.0, cr = 0.0
    for m in mods {
        guard let g = gradeNumber(m.grade), g >= 1, g <= 4, let c = m.credits, c > 0 else { continue }
        sum += g * c
        cr += c
    }
    return cr > 0 ? sum / cr : nil
}

private func fits(_ exact: Double?, _ shown: Double?) -> Bool {
    guard let exact else { return false }
    guard let shown else { return true }
    let r = (exact * 10).rounded() / 10
    let t = floor(exact * 10 + 1e-9) / 10
    return abs(r - shown) < 1e-6 || abs(t - shown) < 1e-6
}

func gpaExact(_ data: DualisData) -> (total: Double?, major: Double?) {
    let all = data.groups.flatMap { g in g.modules.map { (g.title, $0) } }
    let shownTotal = gradeNumber(data.gpa.total)
    let shownMajor = gradeNumber(data.gpa.major)
    let t = weightedGrade(all.map(\.1))
    let total = fits(t, shownTotal) ? t : nil
    var major: Double?
    if shownMajor != nil {
        for pattern in ["schl[uü]ssel", "schl[uü]ssel|wahl|zusatz|studium generale"] {
            let m = weightedGrade(all.filter { $0.0.range(of: pattern, options: [.regularExpression, .caseInsensitive]) == nil }.map(\.1))
            if fits(m, shownMajor) { major = m; break }
        }
        if major == nil, fits(t, shownMajor) { major = t }
    }
    return (total, major)
}

func fmtGrade(_ n: Double?, digits: Int = 2) -> String? {
    guard let n else { return nil }
    return String(format: "%.\(digits)f", n).replacingOccurrences(of: ".", with: ",")
}
