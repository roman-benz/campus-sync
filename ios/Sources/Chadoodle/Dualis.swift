// Noten aus Dualis (dualis.dhbw.de, CampusNet), wie src/main/dualis.js: Anmeldung mit Benutzername/Kennwort,
// Leistungsübersicht auslesen, lokal speichern, im Hintergrund aktualisieren und neue Noten melden.
// Zugangsdaten liegen im Schlüsselbund und gehen ausschließlich an dualis.dhbw.de.
import Foundation

struct DualisModule: Codable, Hashable, Identifiable {
    var no: String
    var name: String
    var date: String?
    var credits: Double?
    var grade: String?
    var status: String
    var newAt: Double? // ms seit 1970: seit dem letzten Abruf neu benotet (7 Tage markiert)
    var id: String { no + name }
    var isNew: Bool { newAt.map { Date().timeIntervalSince1970 * 1000 - $0 < 7 * 86_400_000 } ?? false }
}

struct DualisGroup: Codable, Hashable, Identifiable {
    var title: String
    var modules: [DualisModule]
    var sumCredits: Double?
    var id: String { title }
}

struct DualisGPA: Codable, Hashable {
    var total: String?
    var major: String?
}

struct DualisData: Codable, Hashable {
    var program: String
    var groups: [DualisGroup]
    var totalCredits: Double?
    var required: Double?
    var gpa: DualisGPA
}

struct DualisCache: Codable {
    var fetchedAt: Date
    var data: DualisData
}

struct DualisError: LocalizedError {
    enum Code { case auth, unexpected, format, http, input }
    let message: String
    let code: Code
    var errorDescription: String? { message }
}

// ---------- HTML-Auswertung ohne DOM ----------
private func rx(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p, options: [.caseInsensitive, .dotMatchesLineSeparators]) }
private func groups(_ re: NSRegularExpression, _ s: String) -> [[String?]] {
    re.matches(in: s, range: NSRange(s.startIndex..., in: s)).map { m in
        (0..<m.numberOfRanges).map { i in Range(m.range(at: i), in: s).map { String(s[$0]) } }
    }
}
private func htmlText(_ h: String) -> String {
    var s = h.replacingOccurrences(of: "<!--[\\s\\S]*?-->", with: "", options: .regularExpression)
    s = s.replacingOccurrences(of: "<script[\\s\\S]*?</script>", with: "", options: [.regularExpression, .caseInsensitive])
    s = s.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
    return decodeEntities(s).replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
}
private func num(_ s: String?) -> Double? { gradeNumber(s) }

private struct Cell {
    var cls: String
    var text: String
    var img: String
}

private let cellRe = rx("<t([dh])\\b([^>]*)>([\\s\\S]*?)</t\\1>")
private let rowRe = rx("<tr\\b[^>]*>([\\s\\S]*?)</tr>")
private let clsRe = rx("class=\"([^\"]*)\"")
private let imgTitleRe = rx("<img[^>]*\\btitle=\"([^\"]*)\"")
private let imgAltRe = rx("<img[^>]*\\balt=\"([^\"]*)\"")

private func cells(_ row: String) -> [Cell] {
    groups(cellRe, row).map { g in
        let attrs = g[2] ?? ""
        let inner = g[3] ?? ""
        let img = groups(imgTitleRe, inner).first?[1] ?? groups(imgAltRe, inner).first?[1] ?? ""
        return Cell(cls: groups(clsRe, attrs).first?[1] ?? "", text: htmlText(inner), img: decodeEntities(img ?? ""))
    }
}

private func tables(_ html: String, _ cls: String) -> [[[Cell]]] {
    groups(rx("<table[^>]*class=\"[^\"]*\(cls)[^\"]*\"[^>]*>([\\s\\S]*?)</table>"), html).map { t in
        groups(rowRe, t[1] ?? "").map { cells($0[1] ?? "") }
    }
}

// Leistungsübersicht (PRGNAME=STUDENT_RESULT) → Gruppen mit Modulen, Summen, GPA
func parseDualisResults(_ html: String) throws -> DualisData {
    let all = tables(html, "students_results")
    guard let main = all.first, !main.isEmpty else { throw DualisError(message: "Die Leistungsübersicht von Dualis hat ein unbekanntes Format.", code: .format) }
    var groups: [(title: String, modules: [DualisModule], sum: Double?, used: Bool)] = []
    var heading: Int? // Index in groups oder -1 für eine noch unbenutzte Überschrift
    var pendingTitle: String?
    var program = ""
    var total: Double?
    var required: Double?
    for c in main {
        if c.isEmpty || c.contains(where: { $0.cls.contains("tbsubhead") }) { continue }
        let first = c[0]
        if first.cls.contains("tbdata") && c.count >= 6 {
            if heading == nil || pendingTitle != nil {
                groups.append((pendingTitle ?? (heading.map { groups[$0].title } ?? "Module"), [], nil, true))
                heading = groups.count - 1
                pendingTitle = nil
            }
            groups[heading!].modules.append(DualisModule(no: first.text, name: c[1].text, date: c[2].text.isEmpty ? nil : c[2].text, credits: num(c[3].text),
                                                         grade: c[4].text.isEmpty ? nil : c[4].text, status: c[5].img.isEmpty ? c[5].text : c[5].img))
            continue
        }
        if first.cls.hasPrefix("level") {
            let label = first.text
            if label.range(of: "^Erforderliche Credits", options: [.regularExpression, .caseInsensitive]) != nil {
                let nums = c.map(\.text).joined(separator: " ").matches(of: #/\d+(?:,\d+)?/#).map { String($0.output) }
                required = num(nums.last)
                continue
            }
            let credits = c.count > 2 ? num(c[2].text) : nil
            if let i = groups.firstIndex(where: { "Summe \($0.title)" == label }) { groups[i].sum = credits }
            if first.cls.contains("level00"), label.hasPrefix("Summe ") { total = credits }
            continue
        }
        // Überschrift (Studiengang, Bereich, Modulgruppe)
        if !first.text.isEmpty, c.dropFirst().allSatisfy({ $0.text.isEmpty && $0.img.isEmpty }) {
            if program.isEmpty { program = first.text }
            pendingTitle = first.text
        }
    }
    var gpa = DualisGPA()
    if all.count > 1 {
        for c in all[1] where c.count >= 2 && c[0].text.range(of: "GPA", options: .caseInsensitive) != nil {
            if c[0].text.range(of: "hauptfach", options: .caseInsensitive) != nil { gpa.major = c[1].text.isEmpty ? nil : c[1].text }
            else { gpa.total = c[1].text.isEmpty ? nil : c[1].text }
        }
    }
    return DualisData(program: program, groups: groups.filter { !$0.modules.isEmpty }.map { DualisGroup(title: $0.title, modules: $0.modules, sumCredits: $0.sum) },
                      totalCredits: total, required: required, gpa: gpa)
}

// ---------- Netz ----------
private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? {
        task.taskDescription == "noredirect" ? nil : request
    }
}

private struct DualisSession {
    var session: String
    var cookie: String
    var start: URL
}

private let dualisBase = URL(string: "https://dualis.dhbw.de")!
private let dualisDll = "https://dualis.dhbw.de/scripts/mgrqispi.dll"

private enum DualisNet {
    static let delegate = NoRedirect()
    static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        c.timeoutIntervalForRequest = 30
        return URLSession(configuration: c, delegate: delegate, delegateQueue: nil)
    }()

    static func get(_ url: URL, cookie: String) async throws -> (String, HTTPURLResponse) {
        var req = URLRequest(url: url)
        req.setValue("Mozilla/5.0 (iPhone) Chadoodle", forHTTPHeaderField: "User-Agent")
        if !cookie.isEmpty { req.setValue(cookie, forHTTPHeaderField: "Cookie") }
        let (data, res) = try await session.data(for: req)
        let http = res as! HTTPURLResponse
        if http.statusCode >= 500 { throw DualisError(message: "Dualis antwortet nicht (HTTP \(http.statusCode)).", code: .http) }
        return (String(data: data, encoding: .utf8) ?? String(decoding: data, as: UTF8.self), http)
    }

    // Wie ein Browser: „cnsc =wert“ → „cnsc=wert“; mehrere Set-Cookie sind mit Komma verbunden
    static func cookies(_ res: HTTPURLResponse) -> String {
        guard let raw = res.value(forHTTPHeaderField: "Set-Cookie"), !raw.isEmpty else { return "" }
        let parts = raw.components(separatedBy: CharacterSet(charactersIn: ","))
        var list: [String] = []
        for p in parts {
            let head = p.split(separator: ";", maxSplits: 1).first.map(String.init) ?? ""
            guard let eq = head.firstIndex(of: "="), head[..<eq].trimmingCharacters(in: .whitespaces).range(of: "^[^\\s=;]+$", options: .regularExpression) != nil else { continue }
            list.append("\(head[..<eq].trimmingCharacters(in: .whitespaces))=\(head[head.index(after: eq)...].trimmingCharacters(in: .whitespaces))")
        }
        return list.joined(separator: "; ")
    }

    static func login(_ user: String, _ pass: String) async throws -> DualisSession {
        var req = URLRequest(url: URL(string: dualisDll)!)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.setValue("Mozilla/5.0 (iPhone) Chadoodle", forHTTPHeaderField: "User-Agent")
        req.httpBody = formEncode([("usrname", user), ("pass", pass), ("APPNAME", "CampusNet"), ("PRGNAME", "LOGINCHECK"),
                                   ("ARGUMENTS", "clino,usrname,pass,menuno,menu_type,browser,platform"), ("clino", "000000000000001"),
                                   ("menuno", "000324"), ("menu_type", "classic"), ("browser", ""), ("platform", "")])
        let (data, res) = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<(Data, URLResponse), Error>) in
            let t = session.dataTask(with: req) { d, r, e in
                if let e { cont.resume(throwing: e) } else { cont.resume(returning: (d ?? Data(), r!)) }
            }
            t.taskDescription = "noredirect"
            t.resume()
        }
        let http = res as! HTTPURLResponse
        if http.statusCode >= 500 { throw DualisError(message: "Dualis antwortet nicht (HTTP \(http.statusCode)).", code: .http) }
        let refresh = http.value(forHTTPHeaderField: "Refresh") ?? ""
        let sessionNo = refresh.firstMatch(of: #/ARGUMENTS=-N(\d+)/#).map { String($0.1) }
        guard let sessionNo, sessionNo.range(of: "^0+1?$", options: .regularExpression) == nil else {
            let page = String(decoding: data, as: UTF8.self)
            if page.range(of: "type=\"password\"", options: .caseInsensitive) == nil {
                throw DualisError(message: "Dualis hat unerwartet geantwortet – bitte später erneut versuchen.", code: .unexpected)
            }
            throw DualisError(message: "Anmeldung bei Dualis fehlgeschlagen – Benutzername oder Kennwort falsch.", code: .auth)
        }
        let target = refresh.replacingOccurrences(of: "^.*?URL=", with: "", options: [.regularExpression, .caseInsensitive]).trimmingCharacters(in: .whitespaces)
        return DualisSession(session: sessionNo, cookie: cookies(http), start: URL(string: target, relativeTo: dualisBase)?.absoluteURL ?? dualisBase)
    }

    // Adresse der Leistungsübersicht aus dem Menü der Startseite (Fallback: bekannte Adresse)
    static func resultsUrl(_ s: DualisSession) async throws -> URL {
        var url: URL? = s.start
        for _ in 0..<3 {
            guard let u = url else { break }
            let (page, res) = try await get(u, cookie: s.cookie)
            if let link = page.firstMatch(of: #/href="([^"]*PRGNAME=STUDENT_RESULT[^"]*)"/#), let r = URL(string: decodeEntities(String(link.1)), relativeTo: dualisBase) {
                return r.absoluteURL
            }
            let next = (res.value(forHTTPHeaderField: "Refresh") ?? "").firstMatch(of: #/URL=([^"'\s>]+)/#).map { String($0.1) }
                ?? page.firstMatch(of: #/http-equiv="refresh"[^>]*content="[^"]*URL=([^"]+)"/#).map { String($0.1) }
            url = next.flatMap { URL(string: decodeEntities($0), relativeTo: dualisBase)?.absoluteURL }
        }
        return URL(string: "\(dualisDll)?APPNAME=CampusNet&PRGNAME=STUDENT_RESULT&ARGUMENTS=-N\(s.session),-N000310,-N0,-N000000000000000,-N000000000000000,-N000000000000000,-N0,-N000000000000000")!
    }

    static func fetchResults(_ user: String, _ pass: String) async throws -> DualisData {
        let s = try await login(user, pass)
        defer {
            Task { _ = try? await get(URL(string: "\(dualisDll)?APPNAME=CampusNet&PRGNAME=LOGOUT&ARGUMENTS=-N\(s.session),-N001")!, cookie: s.cookie) }
        }
        let url = try await resultsUrl(s)
        let (page, _) = try await get(url, cookie: s.cookie)
        return try parseDualisResults(page)
    }
}

// ---------- Speicher + Zustand ----------
@MainActor
final class DualisStore: ObservableObject {
    @Published private(set) var cache: DualisCache?
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    @Published private(set) var authFailed = false
    // Wird mit neuen Noten aufgerufen (Benachrichtigung)
    var onNewGrades: (([DualisModule]) -> Void)?
    var onAuthFailed: (() -> Void)?

    private var cacheURL: URL { AppPaths.file("cache/dualis.json") }

    init() {
        cache = readJSON(cacheURL, as: DualisCache.self)
    }

    var configured: Bool { Keychain.get("dualisUser") != nil && Keychain.get("dualisPass") != nil }
    var user: String? { Keychain.get("dualisUser") }
    var data: DualisData? { cache?.data }

    func connect(user: String, pass: String) async throws {
        let u = user.trimmingCharacters(in: .whitespaces)
        guard !u.isEmpty, !pass.isEmpty else { throw DualisError(message: "Bitte Benutzername und Kennwort eingeben.", code: .input) }
        busy = true
        defer { busy = false }
        let d = try await DualisNet.fetchResults(u, pass)
        Keychain.set("dualisUser", u)
        Keychain.set("dualisPass", pass)
        save(d, notify: false)
    }

    func disconnect() {
        Keychain.set("dualisUser", nil)
        Keychain.set("dualisPass", nil)
        try? FileManager.default.removeItem(at: cacheURL)
        cache = nil
        error = nil
        authFailed = false
    }

    // Im Vordergrund höchstens alle 30 Minuten, im Hintergrund bei jedem Weckruf
    func refreshIfStale(maxAge: TimeInterval = 30 * 60) async {
        guard configured else { return }
        if let c = cache, Date().timeIntervalSince(c.fetchedAt) < maxAge { return }
        await refresh()
    }

    @discardableResult
    func refresh() async -> [DualisModule] {
        guard configured, !busy, let u = Keychain.get("dualisUser"), let p = Keychain.get("dualisPass") else { return [] }
        busy = true
        defer { busy = false }
        do {
            let fresh = save(try await DualisNet.fetchResults(u, p), notify: true)
            return fresh
        } catch let e as DualisError where e.code == .auth {
            error = "Dualis hat das gespeicherte Kennwort abgelehnt. Bitte neu anmelden."
            if !authFailed { onAuthFailed?() }
            authFailed = true
        } catch let e as URLError {
            error = e.code == .notConnectedToInternet ? "Offline – letzter Stand wird angezeigt." : "Dualis ist gerade nicht erreichbar."
        } catch {
            self.error = error.localizedDescription
        }
        return []
    }

    // Speichern und neu benotete Module markieren; gibt die neuen Noten zurück
    @discardableResult
    private func save(_ input: DualisData, notify: Bool) -> [DualisModule] {
        var d = input
        let prev = cache?.data
        let before = Dictionary((prev?.groups.flatMap(\.modules) ?? []).map { ($0.no, $0) }, uniquingKeysWith: { a, _ in a })
        var fresh: [DualisModule] = []
        for gi in d.groups.indices {
            for mi in d.groups[gi].modules.indices {
                let m = d.groups[gi].modules[mi]
                let old = before[m.no]
                if let old, old.newAt != nil, old.grade == m.grade { d.groups[gi].modules[mi].newAt = old.newAt }
                else if prev != nil, m.grade != nil, old?.grade == nil {
                    d.groups[gi].modules[mi].newAt = Date().timeIntervalSince1970 * 1000
                    fresh.append(d.groups[gi].modules[mi])
                }
            }
        }
        cache = DualisCache(fetchedAt: Date(), data: d)
        error = nil
        authFailed = false
        writeJSON(cacheURL, cache)
        if notify, !fresh.isEmpty { onNewGrades?(fresh) }
        return fresh
    }
}
