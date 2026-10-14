// Lokale Kopie der Moodle-Daten (wie der Cache in src/main/sync.js). Die Oberfläche liest nur diese Kopie.
import Foundation

struct SiteInfo: Codable, Hashable {
    var url: String
    var sitename: String
    var fullname: String
    var firstname: String
    var lastname: String
    var userid: Int
}

struct Course: Codable, Identifiable, Hashable {
    var id: Int
    var fullname: String
    var shortname: String
    var summary: String
    var categoryname: String?
    var progress: Double?
    var lastaccess: Int?
    var isfavourite: Bool
    var hidden: Bool

    var title: String { shortname.isEmpty ? fullname : shortname }
}

struct CourseSection: Codable, Identifiable, Hashable {
    var id: Int
    var section: Int
    var name: String
    var summary: String
    var uservisible: Bool
    var modules: [Module]
}

struct ModDate: Codable, Hashable {
    var label: String
    var timestamp: Int
}

struct ModFile: Codable, Hashable {
    var type: String
    var filename: String
    var filepath: String
    var filesize: Int
    var fileurl: String
    var timemodified: Int
    var mimetype: String?
    var fileId: String?
}

struct Module: Codable, Identifiable, Hashable {
    var id: Int
    var instance: Int?
    var name: String
    var modname: String
    var url: String?
    var description: String
    var uservisible: Bool
    var completion: Int?
    var dates: [ModDate]
    var contents: [ModFile]
}

struct Assignment: Codable, Hashable {
    var id: Int
    var courseid: Int
    var name: String
    var duedate: Int
    var cutoffdate: Int
    var intro: String
    var attachments: [ModFile]
}

struct PageContent: Codable, Hashable {
    var name: String
    var content: String
    var timemodified: Int
}

struct Discussion: Codable, Hashable, Identifiable {
    var id: Int
    var subject: String
    var message: String
    var author: String
    var created: Int
    var modified: Int
    var replies: Int
    var pinned: Bool
}

struct Forum: Codable, Hashable {
    var name: String
    var courseid: Int
    var discussions: [Discussion]
}

struct CalEvent: Codable, Hashable, Identifiable {
    var id: Int
    var name: String
    var activityname: String?
    var timesort: Int
    var modulename: String?
    var cmid: Int?
    var courseid: Int?
    var coursename: String
    var url: String?
    var overdue: Bool

    var title: String { activityname ?? name }
}

struct GradeItem: Codable, Hashable {
    var name: String
    var grade: String?
    var range: String?
    var percentage: String?
    var feedback: String?
    var itemtype: String?
}

struct LocalFile: Codable, Hashable, Identifiable {
    var id: String
    var courseId: Int
    var cmid: Int
    var modname: String
    var moduleName: String
    var section: String
    var filename: String
    var filesize: Int
    var mimetype: String?
    var timemodified: Int
    var url: String
    var relPath: String // relativ zum Dokumente-Ordner der App
    var downloaded: Bool
    var updated: Bool
    var error: String?

    var localURL: URL { AppPaths.documents.appendingPathComponent(relPath) }
    var ext: String { (filename as NSString).pathExtension.lowercased() }
}

struct NewItem: Codable, Hashable {
    var fileId: String
    var courseId: Int
    var time: Double
}

struct MoodleCache: Codable {
    var site: SiteInfo?
    var courses: [Course] = []
    var contents: [Int: [CourseSection]] = [:]
    var pages: [Int: PageContent] = [:]
    var assignments: [Int: Assignment] = [:]
    var forums: [Int: Forum] = [:]
    var events: [CalEvent] = []
    var grades: [Int: [GradeItem]] = [:]
    var files: [String: LocalFile] = [:]
    var newItems: [NewItem] = []
    var lastSync: Double = 0
    var lastError: String?

    func course(_ id: Int?) -> Course? { courses.first { $0.id == id } }

    func findModule(_ cmid: Int) -> (courseId: Int, section: CourseSection, module: Module)? {
        for (cid, sections) in contents {
            for s in sections { for m in s.modules where m.id == cmid { return (cid, s, m) } }
        }
        return nil
    }
}

enum AppPaths {
    static let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    static let support: URL = {
        let u = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Chadoodle")
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }()

    static func file(_ name: String) -> URL {
        let u = support.appendingPathComponent(name)
        try? FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
        return u
    }
}

func readJSON<T: Decodable>(_ url: URL, as: T.Type) -> T? {
    guard let d = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(T.self, from: d)
}

func writeJSON<T: Encodable>(_ url: URL, _ value: T) {
    if let d = try? JSONEncoder().encode(value) { try? d.write(to: url, options: .atomic) }
}

let modLabel: [String: String] = [
    "resource": "Datei", "folder": "Verzeichnis", "assign": "Aufgabe", "quiz": "Test", "forum": "Forum", "page": "Textseite",
    "url": "Link", "label": "Textfeld", "book": "Buch", "lesson": "Lektion", "choice": "Abstimmung", "feedback": "Feedback",
    "glossary": "Glossar", "wiki": "Wiki", "workshop": "Gegenseitige Beurteilung", "h5pactivity": "H5P", "scorm": "SCORM",
    "lti": "Externes Tool", "data": "Datenbank", "bigbluebuttonbn": "BigBlueButton", "chat": "Chat", "survey": "Umfrage",
]

func modIcon(_ modname: String) -> String {
    switch modname {
    case "resource": return "doc.fill"
    case "folder": return "folder.fill"
    case "assign": return "tray.and.arrow.up.fill"
    case "quiz": return "checklist"
    case "forum": return "bubble.left.and.bubble.right.fill"
    case "page", "book": return "doc.text.fill"
    case "url": return "link"
    case "label": return "text.alignleft"
    case "bigbluebuttonbn": return "video.fill"
    case "choice", "feedback", "survey": return "chart.bar.fill"
    case "glossary", "wiki", "data": return "books.vertical.fill"
    default: return "square.grid.2x2.fill"
    }
}

func fileIcon(_ ext: String) -> String {
    switch ext {
    case "pdf": return "doc.richtext.fill"
    case "doc", "docx", "odt", "txt", "md": return "doc.text.fill"
    case "ppt", "pptx", "odp": return "rectangle.on.rectangle.angled"
    case "xls", "xlsx", "csv", "ods": return "tablecells.fill"
    case "png", "jpg", "jpeg", "gif", "webp", "heic": return "photo.fill"
    case "zip", "rar", "7z": return "doc.zipper"
    case "mp4", "mov", "m4v": return "film.fill"
    case "mp3", "m4a", "wav": return "waveform"
    default: return "doc.fill"
    }
}

func fmtSize(_ b: Int) -> String {
    b <= 0 ? "" : b > 1_048_576 ? String(format: "%.1f MB", Double(b) / 1_048_576) : "\(Int(ceil(Double(b) / 1024))) KB"
}

let deLocale = Locale(identifier: "de_DE")

func fmtDate(_ ts: Int) -> String {
    guard ts > 0 else { return "–" }
    let f = DateFormatter()
    f.locale = deLocale
    f.dateFormat = "EE, dd.MM.yyyy, HH:mm"
    return f.string(from: Date(timeIntervalSince1970: TimeInterval(ts)))
}

func relTime(_ date: Date) -> String {
    let f = RelativeDateTimeFormatter()
    f.locale = deLocale
    return f.localizedString(for: date, relativeTo: Date())
}

// HTML → Text (für die KI-Werkzeuge und Vorschauen)
func stripHtml(_ h: String?) -> String {
    guard var s = h, !s.isEmpty else { return "" }
    s = s.replacingOccurrences(of: "<(script|style)[\\s\\S]*?</\\1>", with: "", options: [.regularExpression, .caseInsensitive])
    s = s.replacingOccurrences(of: "<br\\s*/?>", with: "\n", options: [.regularExpression, .caseInsensitive])
    s = s.replacingOccurrences(of: "</(p|div|li|h\\d|tr)>", with: "\n", options: [.regularExpression, .caseInsensitive])
    s = s.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
    s = decodeEntities(s)
    s = s.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
    return s.trimmingCharacters(in: .whitespacesAndNewlines)
}

private let namedEntities = ["amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " ", "shy": "", "euro": "€",
                             "auml": "ä", "ouml": "ö", "uuml": "ü", "Auml": "Ä", "Ouml": "Ö", "Uuml": "Ü", "szlig": "ß", "ndash": "–", "mdash": "—"]

func decodeEntities(_ s: String) -> String {
    guard s.contains("&") else { return s }
    let re = try! NSRegularExpression(pattern: "&(#\\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);")
    var out = ""
    var last = s.startIndex
    for m in re.matches(in: s, range: NSRange(s.startIndex..., in: s)) {
        let r = Range(m.range, in: s)!
        let e = String(s[Range(m.range(at: 1), in: s)!])
        out += s[last..<r.lowerBound]
        if e.hasPrefix("#x"), let n = UInt32(e.dropFirst(2), radix: 16), let u = Unicode.Scalar(n) {
            out += String(Character(u))
        } else if e.hasPrefix("#"), let n = UInt32(e.dropFirst()), let u = Unicode.Scalar(n) {
            out += String(Character(u))
        } else if let v = namedEntities[e] ?? namedEntities[e.lowercased()] {
            out += v
        } else {
            out += s[r]
        }
        last = r.upperBound
    }
    out += s[last...]
    return out
}
