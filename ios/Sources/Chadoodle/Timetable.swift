// Stundenpläne aus iCal-Quellen (Rapla der DHBW oder beliebige .ics/webcal-Links), wie src/main/timetable.js.
// Jeder Plan wird geladen, in einzelne Termine aufgelöst und lokal gespeichert (offline nutzbar).
import Foundation

struct Timetable: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var url: String
}

struct TTEvent: Codable, Identifiable, Hashable {
    var id: String
    var title: String
    var location: String
    var persons: [String]
    var start: Date
    var end: Date
    var allDay: Bool

    // Anteil der laufenden Vorlesung, der schon vorbei ist (0…1); nil, wenn sie gerade nicht läuft
    func elapsed(at now: Date = Date()) -> Double? {
        guard !allDay, start <= now, end > now else { return nil }
        return now.timeIntervalSince(start) / end.timeIntervalSince(start)
    }
}

struct TimetableCache: Codable {
    var fetchedAt: Date
    var events: [TTEvent]
    var error: String?
}

let raplaTemplate = Timetable(id: "tsa25", name: "TSA25 · DHBW Ravensburg",
                              url: "https://rapla.dhbw.de/rapla/internal_calendar?user=muenzer@vw.ba.ba-ravensburg.de&file=TSA25")

// Rapla-Ansichtslinks (internal_calendar, calendar) auf den iCal-Export umbiegen, webcal → https
func icalUrl(_ input: String) throws -> URL {
    let s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        .replacingOccurrences(of: "^webcals?://", with: "https://", options: [.regularExpression, .caseInsensitive])
    guard let u = URLComponents(string: s), let scheme = u.scheme?.lowercased(), let host = u.host else {
        throw MoodleError(message: "Das ist kein gültiger Link.")
    }
    guard scheme == "http" || scheme == "https" else { throw MoodleError(message: "Nur http(s)- oder webcal-Links werden unterstützt.") }
    if host.range(of: "(^|\\.)rapla\\.", options: [.regularExpression, .caseInsensitive]) != nil,
       u.path.range(of: "/rapla/(internal_calendar|calendar)$", options: [.regularExpression, .caseInsensitive]) != nil {
        var c = URLComponents()
        c.scheme = scheme
        c.host = host
        c.port = u.port
        c.path = "/rapla/ical"
        c.queryItems = ["user", "file", "key", "salt"].compactMap { k in u.queryItems?.first { $0.name == k }.flatMap { $0.value.map { URLQueryItem(name: k, value: $0) } } }
        return c.url!
    }
    return u.url!
}

// ---------- iCal-Parser (RFC 5545, was Stundenpläne tatsächlich nutzen) ----------
private struct Prop {
    var name: String
    var params: [String: String]
    var value: String
}

private struct ICalDate {
    var date: Date
    var tz: TimeZone
    var allDay: Bool
    var wallKey: String
}

private let berlin = TimeZone(identifier: "Europe/Berlin")!

private func calendar(_ tz: TimeZone) -> Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = tz
    return c
}

private func wallKey(_ date: Date, _ tz: TimeZone) -> String {
    let c = calendar(tz).dateComponents([.year, .month, .day, .hour, .minute], from: date)
    return "\(c.year!)-\(c.month!)-\(c.day!)-\(c.hour!)-\(c.minute!)"
}

private func unescapeText(_ s: String) -> String {
    s.replacingOccurrences(of: "\\n", with: "\n").replacingOccurrences(of: "\\N", with: "\n")
        .replacingOccurrences(of: "\\,", with: ",").replacingOccurrences(of: "\\;", with: ";").replacingOccurrences(of: "\\\\", with: "\\")
}

private func parseLine(_ line: String) -> Prop? {
    guard let i = line.firstIndex(of: ":") else { return nil }
    let head = line[..<i].split(separator: ";", omittingEmptySubsequences: false)
    var params: [String: String] = [:]
    for x in head.dropFirst() {
        let kv = x.split(separator: "=", maxSplits: 1)
        if let k = kv.first { params[k.uppercased()] = kv.count > 1 ? kv[1].trimmingCharacters(in: CharacterSet(charactersIn: "\"")) : "" }
    }
    return Prop(name: String(head.first ?? "").uppercased(), params: params, value: String(line[line.index(after: i)...]))
}

private func parseDate(_ value: String, _ params: [String: String]) -> ICalDate? {
    let v = value.trimmingCharacters(in: .whitespaces)
    let re = try! NSRegularExpression(pattern: "^(\\d{4})(\\d{2})(\\d{2})(?:T(\\d{2})(\\d{2})(\\d{2})(Z)?)?$")
    guard let m = re.firstMatch(in: v, range: NSRange(v.startIndex..., in: v)) else { return nil }
    let g = { (i: Int) -> String? in Range(m.range(at: i), in: v).map { String(v[$0]) } }
    let hasTime = g(4) != nil
    let utc = g(7) != nil
    let allDay = params["VALUE"] == "DATE" || !hasTime
    let tz = utc ? TimeZone(identifier: "UTC")! : allDay ? berlin : (params["TZID"].flatMap { TimeZone(identifier: $0) } ?? berlin)
    var c = DateComponents()
    c.year = Int(g(1)!)
    c.month = Int(g(2)!)
    c.day = Int(g(3)!)
    c.hour = Int(g(4) ?? "0")
    c.minute = Int(g(5) ?? "0")
    c.second = Int(g(6) ?? "0")
    guard let date = calendar(tz).date(from: c) else { return nil }
    return ICalDate(date: date, tz: tz, allDay: allDay, wallKey: "\(c.year!)-\(c.month!)-\(c.day!)-\(c.hour!)-\(c.minute!)")
}

// Wiederholungen auflösen: täglich/wöchentlich/monatlich mit COUNT, UNTIL, INTERVAL, BYDAY
private func expand(_ start: ICalDate, _ rrule: String, _ exdates: Set<String>, _ limit: Date) -> [Date] {
    var r: [String: String] = [:]
    for part in rrule.split(separator: ";") {
        let kv = part.split(separator: "=", maxSplits: 1)
        if kv.count == 2 { r[String(kv[0]).uppercased()] = String(kv[1]) }
    }
    let interval = max(1, Int(r["INTERVAL"] ?? "") ?? 1)
    let count = Int(r["COUNT"] ?? "") ?? Int.max
    let until = r["UNTIL"].flatMap { parseDate($0, [:])?.date } ?? .distantFuture
    let cal = calendar(start.tz)
    var out: [Date] = []
    var n = 0
    func push(_ d: Date) -> Bool {
        if d < start.date { return true }
        if d > until || n >= count || d > limit { return false }
        n += 1
        if !exdates.contains(wallKey(d, start.tz)) { out.append(d) }
        return true
    }
    switch r["FREQ"] {
    case "WEEKLY":
        let days = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]
        let wd = cal.component(.weekday, from: start.date) - 1 // 0 = Sonntag
        let by = r["BYDAY"].map { $0.split(separator: ",").compactMap { days.firstIndex(of: String($0.suffix(2))) } } ?? [wd]
        let toMonday = -((wd + 6) % 7)
        var wk = 0
        while wk < 600 {
            let dates = by.compactMap { d in cal.date(byAdding: .day, value: toMonday + wk * 7 + (d + 6) % 7, to: start.date) }.sorted()
            for d in dates where !push(d) { return out }
            wk += interval
        }
    case "DAILY":
        var i = 0
        while i < 3000 {
            guard let d = cal.date(byAdding: .day, value: i, to: start.date), push(d) else { return out }
            i += interval
        }
    case "MONTHLY":
        let day = cal.component(.day, from: start.date)
        var i = 0
        while i < 240 {
            if let d = cal.date(byAdding: .month, value: i, to: start.date), cal.component(.day, from: d) == day {
                if !push(d) { return out }
            }
            i += interval
        }
    default:
        out.append(start.date) // unbekannte Regel: nur der erste Termin
    }
    return out
}

// Rapla schreibt Dozenten in die Beschreibung („… Personen: Name, Vorname Ressourcen: …“)
private func persons(_ desc: String) -> [String] {
    guard let r = desc.range(of: "Personen:\\s*([\\s\\S]*?)\\s*(?:Ressourcen:|$)", options: .regularExpression) else { return [] }
    let body = desc[r].replacingOccurrences(of: "^Personen:\\s*", with: "", options: .regularExpression)
        .replacingOccurrences(of: "\\s*Ressourcen:$", with: "", options: .regularExpression)
    let parts = body.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    var names: [String] = []
    var i = 0
    while i < parts.count {
        names.append(i + 1 < parts.count ? "\(parts[i + 1]) \(parts[i])" : parts[i])
        i += 2
    }
    return names
}

func parseIcs(_ text: String, from: Date, to: Date) -> [TTEvent] {
    let lines = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\n ", with: "").replacingOccurrences(of: "\n\t", with: "")
        .components(separatedBy: "\n")
    struct Raw { var props: [String: Prop] = [:]; var exdate: [Prop] = []; var rdate: [Prop] = [] }
    var events: [Raw] = []
    var cur: Raw?
    var depth = 0
    for line in lines {
        let up = line.uppercased()
        if up == "BEGIN:VEVENT" { cur = Raw(); depth = 0; continue }
        guard cur != nil else { continue }
        if up.hasPrefix("BEGIN:") { depth += 1; continue } // z. B. VALARM überspringen
        if up == "END:VEVENT" { events.append(cur!); cur = nil; continue }
        if up.hasPrefix("END:") { depth -= 1; continue }
        if depth > 0 { continue }
        guard let p = parseLine(line) else { continue }
        if p.name == "EXDATE" { p.value.split(separator: ",").forEach { cur!.exdate.append(Prop(name: p.name, params: p.params, value: String($0))) } }
        else if p.name == "RDATE" { p.value.split(separator: ",").forEach { cur!.rdate.append(Prop(name: p.name, params: p.params, value: String($0))) } }
        else if cur!.props[p.name] == nil { cur!.props[p.name] = p }
    }

    var out: [TTEvent] = []
    for ev in events {
        guard let sp = ev.props["DTSTART"], let start = parseDate(sp.value, sp.params) else { continue }
        let end = ev.props["DTEND"].flatMap { parseDate($0.value, $0.params) }
        var dur: TimeInterval
        if let end { dur = end.date.timeIntervalSince(start.date) }
        else if let d = ev.props["DURATION"]?.value, let m = try? NSRegularExpression(pattern: "P(?:(\\d+)W)?(?:(\\d+)D)?(?:T(?:(\\d+)H)?(?:(\\d+)M)?)?").firstMatch(in: d, range: NSRange(d.startIndex..., in: d)) {
            let g = { (i: Int) -> Double in Range(m.range(at: i), in: d).flatMap { Double(d[$0]) } ?? 0 }
            dur = ((g(1) * 7 + g(2)) * 24 * 3600) + g(3) * 3600 + g(4) * 60
        } else { dur = start.allDay ? 86400 : 0 }
        let exdates = Set(ev.exdate.compactMap { parseDate($0.value, $0.params)?.wallKey })
        var starts = ev.props["RRULE"].map { expand(start, $0.value, exdates, to) } ?? [start.date]
        starts += ev.rdate.compactMap { parseDate($0.value, $0.params)?.date }
        let desc = ev.props["DESCRIPTION"].map { unescapeText($0.value) } ?? ""
        let uid = ev.props["UID"]?.value ?? UUID().uuidString
        let title = ev.props["SUMMARY"].map { unescapeText($0.value).trimmingCharacters(in: .whitespaces) } ?? "(ohne Titel)"
        let location = ev.props["LOCATION"].map { unescapeText($0.value).trimmingCharacters(in: .whitespaces) } ?? ""
        // Rapla legt Feiertage mit Uhrzeit-Start und Datums-Ende an
        let allDay = start.allDay || (end?.allDay ?? false) || dur >= 23 * 3600
        let ps = persons(desc)
        for s in starts {
            let e = s.addingTimeInterval(dur)
            if e < from || s > to { continue }
            out.append(TTEvent(id: "\(uid)@\(Int(s.timeIntervalSince1970))", title: title, location: location, persons: ps, start: s, end: e, allDay: allDay))
        }
    }
    return out.sorted { $0.start < $1.start }
}

// ---------- Verwaltung + Cache ----------
@MainActor
final class Timetables: ObservableObject {
    @Published private(set) var list: [Timetable] = []
    @Published private(set) var caches: [String: TimetableCache] = [:]
    @Published var activeId: String {
        didSet { UserDefaults.standard.set(activeId, forKey: "timetableActive") }
    }
    @Published private(set) var loading = false

    init() {
        let saved = UserDefaults.standard.data(forKey: "timetables").flatMap { try? JSONDecoder().decode([Timetable].self, from: $0) }
        list = saved ?? [raplaTemplate]
        activeId = UserDefaults.standard.string(forKey: "timetableActive") ?? ""
        for t in list { caches[t.id] = readJSON(cacheURL(t.id), as: TimetableCache.self) }
    }

    var active: Timetable? { list.first { $0.id == activeId } ?? list.first }

    private func cacheURL(_ id: String) -> URL { AppPaths.file("timetables/\(id).json") }

    private func persist() {
        UserDefaults.standard.set(try? JSONEncoder().encode(list), forKey: "timetables")
    }

    func add(name: String, url: String) async throws {
        let ics = try icalUrl(url)
        if try list.contains(where: { try icalUrl($0.url) == ics }) { throw MoodleError(message: "Dieser Stundenplan ist schon eingetragen.") }
        let t = Timetable(id: b64url(randomBytes(6)), name: name.trimmingCharacters(in: .whitespaces).isEmpty ? "Stundenplan" : name, url: url.trimmingCharacters(in: .whitespaces))
        // Erst laden, dann speichern: ungültige Links landen gar nicht erst in der Liste
        try await fetch(t)
        list.append(t)
        activeId = t.id
        persist()
    }

    func remove(_ id: String) {
        list.removeAll { $0.id == id }
        caches[id] = nil
        try? FileManager.default.removeItem(at: cacheURL(id))
        persist()
    }

    func fetch(_ t: Timetable) async throws {
        var req = URLRequest(url: try icalUrl(t.url), timeoutInterval: 30)
        req.setValue("text/calendar, */*", forHTTPHeaderField: "Accept")
        let (data, res) = try await URLSession.shared.data(for: req)
        if let http = res as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw MoodleError(message: "Stundenplan nicht erreichbar (HTTP \(http.statusCode))")
        }
        let text = String(decoding: data, as: UTF8.self)
        guard text.range(of: "BEGIN:VCALENDAR", options: .caseInsensitive) != nil else { throw MoodleError(message: "Unter diesem Link liegt kein Kalender (iCal).") }
        let now = Date()
        let events = await Task.detached(priority: .utility) {
            parseIcs(text, from: now.addingTimeInterval(-120 * 86400), to: now.addingTimeInterval(400 * 86400))
        }.value
        let c = TimetableCache(fetchedAt: now, events: events)
        caches[t.id] = c
        writeJSON(cacheURL(t.id), c)
    }

    // Alle Pläne aktualisieren; Fehler (z. B. offline) werden vermerkt, der alte Stand bleibt nutzbar
    func refreshAll() async {
        loading = true
        defer { loading = false }
        for t in list {
            do { try await fetch(t) } catch {
                if var c = caches[t.id] {
                    c.error = error.localizedDescription
                    caches[t.id] = c
                }
            }
        }
    }

    func refreshIfStale() async {
        let stale = list.contains { (caches[$0.id]?.fetchedAt ?? .distantPast) < Date().addingTimeInterval(-2 * 3600) }
        if stale { await refreshAll() }
    }

    func events(_ id: String?, from: Date, to: Date) -> [TTEvent] {
        guard let id, let c = caches[id] else { return [] }
        return c.events.filter { $0.end >= from && $0.start <= to }
    }
}
