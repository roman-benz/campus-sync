// Speiseplan aus my-mensa.de (Standard: Mensa Fallenbrunnen), wie src/main/mensa.js.
// Gelesen wird getdata.php (JSON) – der letzte Stand bleibt offline sichtbar.
import Foundation

let defaultMensaUrl = "https://zuf.my-mensa.de/mensatogo.php?mensa=mensa_fallenbrunnen"
private let diet = ["VEG": "vegan", "V": "vegetarisch", "F": "Fisch", "G": "Geflügel", "R": "Rind", "S": "Schwein", "L": "Lamm", "W": "Wild"]

struct DishTag: Codable, Hashable {
    var code: String
    var text: String
    var diet: Bool
}

struct Dish: Codable, Hashable, Identifiable {
    var id: String
    var aid: String?
    var category: String
    var title: String
    var description: String
    var intern: Double?
    var dhbw: Double?
    var extern: Double?
    var image: String?
    var thumb: String?
    var tags: [DishTag]
}

struct MensaDay: Codable, Hashable, Identifiable {
    var date: String
    var weekday: String
    var label: String
    var rel: String
    var dishes: [Dish]
    var id: String { date }
}

struct MensaPlan: Codable {
    var name: String
    var days: [MensaDay]
    var url: String
    var fetchedAt: Date
    var error: String?
}

func parseMensaUrl(_ input: String) throws -> (origin: String, mensaId: String) {
    guard let u = URLComponents(string: input.trimmingCharacters(in: .whitespacesAndNewlines)), let host = u.host, let scheme = u.scheme,
          ["http", "https"].contains(scheme.lowercased()) else { throw MoodleError(message: "Das ist kein gültiger Link.") }
    guard host.lowercased() == "my-mensa.de" || host.lowercased().hasSuffix(".my-mensa.de") else { throw MoodleError(message: "Bitte einen Link von my-mensa.de angeben.") }
    guard let id = u.queryItems?.first(where: { $0.name == "mensa" || $0.name == "mensa_id" })?.value, !id.isEmpty else {
        throw MoodleError(message: "Im Link fehlt die Mensa (…?mensa=…).")
    }
    return ("\(scheme)://\(host)\(u.port.map { ":\($0)" } ?? "")", id)
}

private let cp1252: [Character] = ["€", "\u{81}", "‚", "ƒ", "„", "…", "†", "‡", "ˆ", "‰", "Š", "‹", "Œ", "\u{8d}", "Ž", "\u{8f}", "\u{90}", "‘", "’", "“", "”", "•", "–", "—", "˜", "™", "š", "›", "œ", "\u{9d}", "ž", "Ÿ"]

func mensaClean(_ v: Any?) -> String {
    var s = jStr(v) ?? ""
    s = s.replacingOccurrences(of: "<br\\s*/?>", with: " ", options: [.regularExpression, .caseInsensitive])
    s = s.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
    s = decodeEntities(s).replacingOccurrences(of: "\u{AD}", with: "")
    // Steuerzeichen U+0080–U+009F sind falsch kodierte Windows-1252-Zeichen (z. B. 0x96 = „–“)
    s = String(s.unicodeScalars.map { u -> String in
        (0x80...0x9F).contains(u.value) ? String(cp1252[Int(u.value - 0x80)]).filter { $0.unicodeScalars.first!.value > 0x9F } : String(u)
    }.joined())
    return s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
}

private func price(_ v: Any?) -> Double? {
    guard let n = jDouble(v), n > 0 else { return nil }
    return n
}

@MainActor
final class MensaStore: ObservableObject {
    @Published private(set) var plan: MensaPlan?
    @Published private(set) var loading = false

    // Über Chadoodle aufgegebene Bestellungen, Warenkorb und Abholzeit je Tag (YYYY-MM-DD)
    @Published private(set) var orders: [MensaOrder] = []
    @Published var cart: [String: [String: Int]] = [:]
    @Published var pickup: [String: String] = [:]
    private var cfg: OrderConfig?

    private var cacheURL: URL { AppPaths.file("mensa.json") }
    private var ordersURL: URL { AppPaths.file("mensa-orders.json") }
    var url: String { UserDefaults.standard.string(forKey: "mensaUrl").flatMap { $0.isEmpty ? nil : $0 } ?? defaultMensaUrl }

    init() {
        plan = readJSON(cacheURL, as: MensaPlan.self)
        orders = readJSON(ordersURL, as: [MensaOrder].self) ?? []
    }

    // Aktueller Stand; lädt neu, wenn er älter als 30 Minuten ist (oder force)
    func get(force: Bool = false) async -> MensaPlan? {
        if !force, let p = plan, p.url == url, p.error == nil, Date().timeIntervalSince(p.fetchedAt) < 30 * 60 { return p }
        do {
            try await fetch()
        } catch {
            if var p = plan, p.url == url {
                p.error = error.localizedDescription
                plan = p
            }
        }
        return plan
    }

    func fetch(url override: String? = nil) async throws {
        loading = true
        defer { loading = false }
        let link = override ?? url
        let json = try await raw(link)
        let p = normalize(json, origin: try parseMensaUrl(link).origin, url: link)
        plan = p
        writeJSON(cacheURL, p)
    }

    // Rohdaten aus getdata.php (für Bestellungen werden die Originaltexte und -preise gebraucht)
    private func raw(_ link: String) async throws -> [String: Any] {
        let (origin, mensaId) = try parseMensaUrl(link)
        let api = "\(origin)/getdata.php?mensa_id=\(mensaId.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)&json=1&hyp=1&now=\(Int(Date().timeIntervalSince1970 * 1000))&mode=togo&lang=de"
        var req = URLRequest(url: URL(string: api)!, timeoutInterval: 20)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, res) = try await URLSession.shared.data(for: req)
        if let http = res as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw MoodleError(message: "Speiseplan nicht erreichbar (HTTP \(http.statusCode))")
        }
        guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw MoodleError(message: "Unter diesem Link liegt kein Speiseplan.")
        }
        return json
    }

    // ---------- Bestellen (wie src/main/mensa.js) ----------
    // Die Bestellseite (mensatogo.php) bringt API-Adresse und Mensa-Konfiguration im Quelltext mit
    private func orderConfig() async throws -> OrderConfig {
        let link = url
        if let c = cfg, c.url == link, Date().timeIntervalSince(c.at) < 10 * 60 { return c }
        let (origin, mensaId) = try parseMensaUrl(link)
        let page = URL(string: "\(origin)/mensatogo.php?mensa=\(mensaId.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)")!
        let (data, res) = try await URLSession.shared.data(for: URLRequest(url: page, timeoutInterval: 20))
        if let http = res as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw MoodleError(message: "Bestellseite nicht erreichbar (HTTP \(http.statusCode))")
        }
        let html = String(decoding: data, as: UTF8.self)
        let none = MoodleError(message: "Bei dieser Mensa ist keine Vorbestellung möglich.")
        guard let api = firstGroup(html, "var\\s+apiLink\\s*=\\s*'([^']+)'"),
              let conf = firstGroup(html, "var\\s+mensen\\s*=\\s*JSON\\.parse\\('(.*?)'\\);") else { throw none }
        guard let all = (try? JSONSerialization.jsonObject(with: Data(conf.replacingOccurrences(of: "\\'", with: "'").utf8))) as? [String: Any] else {
            throw MoodleError(message: "Die Bestellseite konnte nicht gelesen werden.")
        }
        guard let config = all[mensaId] as? [String: Any], config["mmplus_location_id"] != nil else { throw none }
        let c = OrderConfig(url: link, at: Date(), origin: origin, mensaId: mensaId, api: api, config: config)
        cfg = c
        return c
    }

    private func apiPost(_ c: OrderConfig, _ endpoint: String, _ params: [(String, String)]) async throws -> Any {
        var req = URLRequest(url: URL(string: "\(c.api)api/\(endpoint)/")!, timeoutInterval: 20)
        req.httpMethod = "POST"
        formHeaders(&req)
        req.httpBody = formEncode(params)
        let (data, res) = try await URLSession.shared.data(for: req)
        if let http = res as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw MoodleError(message: "Der Mensa-Server antwortet nicht (HTTP \(http.statusCode)).")
        }
        return try JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed)
    }

    // Frühester bestellbarer Tag wie auf der Bestellseite: maxBookingTimes bildet den Wochentag
    // (1 = Mo … 7 = So) vor bzw. nach bookingSplitTime auf den ersten erlaubten Wochentag ab
    private func earliestDate(_ config: [String: Any], now: Date = Date()) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Berlin")!
        let c = cal.dateComponents([.year, .month, .day, .hour, .minute, .weekday], from: now)
        let wd = (c.weekday! + 5) % 7 + 1 // Calendar: 1 = So → 7, 2 = Mo → 1
        var split = String((jStr(config["bookingSplitTime"]) ?? "09:00").prefix(5))
        if split.count == 4 { split = "0" + split }
        let hm = String(format: "%02d:%02d", c.hour!, c.minute!)
        let map = ((config["maxBookingTimes"] as? [String: Any])?[hm < split ? "vormittag" : "nachmittag"] as? [String: Any]) ?? [:]
        let target = jInt(map[String(wd)]) ?? (wd % 7) + 1
        let offset = (target - wd + 7) % 7
        let day = cal.date(byAdding: .day, value: offset, to: cal.date(from: DateComponents(year: c.year, month: c.month, day: c.day, hour: 12))!)!
        return isoDay(day)
    }

    // Abholzeiten und Restmengen für einen Tag
    func orderOptions(_ date: String, email: String = "") async throws -> OrderOptions {
        let c = try await orderConfig()
        let earliest = earliestDate(c.config)
        var out = OrderOptions(date: date, earliest: earliest, orderable: date >= earliest, termsUrl: jStr(c.config["nutzungs_vereinbarung_link"]) ?? "")
        guard out.orderable else { return out }
        let loc = jStr(c.config["mmplus_location_id"]) ?? ""
        async let slotsReq = apiPost(c, "get_free_slots", [("mensa_id", loc), ("tag", date), ("id", email)])
        let stock = jBool(c.config["checkContigent"]) ? ((try? await apiPost(c, "get_contigent", [])) as? [String: Any] ?? [:]) : [:]
        let slots = try await slotsReq
        if let d = slots as? [String: Any], let msg = d["message"] {
            out.message = mensaClean(msg)
        } else if let d = slots as? [String: Any] {
            // „HH:MM:SS“ → freie Plätze; der letzte Eintrag markiert nur das Ende des letzten Fensters
            let keys = d.keys.sorted()
            out.slots = keys.indices.dropLast().map { i in
                MensaSlot(time: String(keys[i].prefix(5)), until: String(keys[i + 1].prefix(5)), free: jInt(d[keys[i]]) ?? 0)
            }
        }
        for (aid, x) in stock {
            if let x = x as? [String: Any] { out.stock[aid] = MensaStock(rest: jInt(x["rest"]) ?? 0, live: jInt(x["restlive"]) ?? 0) }
        }
        return out
    }

    // Vorbestellbar sind nur Gerichte mit Kontingent; führt die Mensa keins, alles mit Preis
    func orderable(_ e: Dish, _ o: OrderOptions) -> Bool {
        guard let aid = e.aid else { return false }
        return o.stock.isEmpty ? (e.dhbw ?? e.intern ?? 0) > 0 : o.stock[aid] != nil
    }

    // Bestellung absenden – Felder genau wie das jQuery-Formular der offiziellen Seite
    func order(date: String, items: [String: Int], time: String, firstName: String, lastName: String, email: String) async throws -> MensaOrder {
        let first = firstName.trimmingCharacters(in: .whitespaces)
        let last = lastName.trimmingCharacters(in: .whitespaces)
        let mail = email.trimmingCharacters(in: .whitespaces)
        guard !first.isEmpty, !last.isEmpty else { throw MoodleError(message: "Bitte Vor- und Nachname angeben.") }
        guard mail.range(of: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", options: .regularExpression) != nil else { throw MoodleError(message: "Bitte eine gültige E-Mail-Adresse angeben.") }
        let wanted = items.filter { $0.value > 0 }.sorted { $0.key < $1.key }
        guard !wanted.isEmpty else { throw MoodleError(message: "Der Warenkorb ist leer.") }
        guard wanted.allSatisfy({ $0.value <= 20 }) else { throw MoodleError(message: "Höchstens 20 Stück pro Gericht.") }

        let c = try await orderConfig()
        let opts = try await orderOptions(date, email: mail)
        guard opts.orderable else { throw MoodleError(message: "Für diesen Tag kann nicht mehr bestellt werden.") }
        guard let slot = opts.slots.first(where: { $0.time == time }), slot.free > 0 else { throw MoodleError(message: "Diese Abholzeit ist nicht mehr frei.") }

        let json = try await raw(c.url)
        guard let day = (json["result"] as? [[String: Any]] ?? []).first(where: { jStr(($0["tag"] as? [String: Any])?["datum_iso"]) == date }) else {
            throw MoodleError(message: "Für diesen Tag gibt es keinen Speiseplan.")
        }
        let tag = day["tag"] as? [String: Any] ?? [:]
        var byId: [String: [String: Any]] = [:]
        for e in day["essen"] as? [[String: Any]] ?? [] { if let a = jStr(e["a_id"]) { byId[a] = e } }
        for (aid, n) in wanted {
            guard let e = byId[aid] else { throw MoodleError(message: "Ein Gericht im Warenkorb gibt es nicht mehr.") }
            let name = mensaClean(e["title_clean"] ?? e["title"])
            let s = opts.stock[aid]
            if !opts.stock.isEmpty && s == nil { throw MoodleError(message: "\(name) kann nicht vorbestellt werden.") }
            if let s, s.rest <= 0 || s.live < n { throw MoodleError(message: "\(name): nur noch \(max(0, s.live)) verfügbar.") }
        }

        // basket_html ist das innerHTML der Warenkorb-Tabelle (&shy; als Zeichen, &nbsp; bleibt Entity)
        let shy = { (t: Any?) in (jStr(t) ?? "").replacingOccurrences(of: "&shy;", with: "\u{AD}") }
        let priceHtml = { (e: [String: Any]) in
            (jStr(e["preis_formated_Togo"]) ?? "").replacingOccurrences(of: "&euro;", with: "€")
                .replacingOccurrences(of: "<br\\s*/?>", with: "<br>", options: [.regularExpression, .caseInsensitive])
        }
        let rows = wanted.map { aid, n in "<tr><td>\(n)x</td> <td aid_check=\"\(aid)\">\(shy(byId[aid]!["title"]))</td> <td class=\"preis\">\(priceHtml(byId[aid]!))</td></tr>" }
        let basketHtml = "<tbody><tr><th>Anzahl</th> <th>Artikel</th> <th class=\"zahl\">Stückpreis</th></tr> \(rows.joined(separator: " ")) <tr class=\"trenner\"><td></td> <td></td> <td></td></tr></tbody>"

        let mensaName = mensaClean(json["mensaname"])
        let client: [(String, String)] = [
            ("einrichtung", mensaName.isEmpty ? c.mensaId : mensaName), ("einrichtung_val", c.mensaId),
            ("vorname", first), ("name", last), ("email", mail), ("nv2", "on"), ("save_allowed", "on"),
            ("language_val", "de"), ("language", ""), ("deliver_time_val", time), ("date_iso", date),
            ("date_hr", jStr(tag["tag_formatiert2"]) ?? date),
        ]
        var p = client.map { ("client[\($0.0)]", $0.1) }
        for (aid, n) in wanted { p.append(("basket_positions[\(aid)]", String(n))) }
        p.append(("basket_html", basketHtml))
        for (aid, n) in wanted {
            let e = byId[aid]!
            let full: [(String, String)] = [
                ("id", jStr(e["a_id"]) ?? aid), ("category", jStr(e["category"]) ?? ""),
                ("title", "\(jStr(e["title"]) ?? "") \(jStr(e["description"]) ?? "") \(jStr(e["kennzRest"]) ?? "")"),
                ("preis1", jStr(e["preis1"]) ?? ""), ("preis2", jStr(e["preis2"]) ?? ""), ("preis3", jStr(e["preis3"]) ?? ""),
                ("preis5", jStr(e["preis5"]) ?? ""), ("anzahl", String(n)),
            ]
            for (k, v) in full { p.append(("basket_full[\(aid)][\(k)]", v)) }
        }

        var req = URLRequest(url: URL(string: "\(c.origin)/setDataMensaTogo.php?order=add&language=de")!, timeoutInterval: 30)
        req.httpMethod = "POST"
        formHeaders(&req)
        req.httpBody = formEncode(p)
        let (data, res) = try await URLSession.shared.data(for: req)
        if let http = res as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw MoodleError(message: "Bestellung fehlgeschlagen (HTTP \(http.statusCode)).")
        }
        guard let r = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw MoodleError(message: "Unerwartete Antwort der Mensa – bitte erst im E-Mail-Postfach nachsehen, bevor du nochmal bestellst.")
        }
        guard jStr(r["type"]) == "success" else {
            let t = mensaClean(r["text"])
            throw MoodleError(message: t.isEmpty ? "Die Bestellung wurde abgelehnt." : t)
        }
        let entry = MensaOrder(no: mensaClean(r["text"]), date: date, time: time, until: slot.until, email: mail, mensa: client[0].1,
                               items: wanted.map { aid, n in
                                   MensaOrder.Item(aid: aid, n: n, title: mensaClean(byId[aid]!["title_clean"] ?? byId[aid]!["title"]), dhbw: price(byId[aid]!["preis2"]))
                               }, at: Date())
        orders.insert(entry, at: 0)
        orders = Array(orders.prefix(200))
        writeJSON(ordersURL, orders)
        cart[date] = nil
        return entry
    }

    // Neuen Link erst prüfen (laden), dann speichern
    func setUrl(_ link: String) async throws {
        _ = try parseMensaUrl(link)
        try await fetch(url: link)
        UserDefaults.standard.set(link.trimmingCharacters(in: .whitespaces), forKey: "mensaUrl")
    }

    private func normalize(_ json: [String: Any], origin: String, url: String) -> MensaPlan {
        let abs = { (p: String?) -> String? in
            guard let p, !p.isEmpty else { return nil }
            let clean = p.hasPrefix("./") ? String(p.dropFirst(2)) : p
            return URL(string: clean, relativeTo: URL(string: origin + "/"))?.absoluteString
        }
        let days: [MensaDay] = (json["result"] as? [[String: Any]] ?? []).map { d in
            let t = d["tag"] as? [String: Any] ?? [:]
            let iso = jStr(t["datum_iso"]) ?? ""
            let dishes: [Dish] = (d["essen"] as? [[String: Any]] ?? []).map { e in
                let codes = (jStr(e["kennzeichnungen"]) ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                let legend = e["icons2"] as? [String: Any] ?? [:]
                let tags = codes.map { code in
                    DishTag(code: code, text: mensaClean((legend[code] as? [String: Any])?["text"] ?? diet[code] ?? code), diet: diet[code] != nil)
                }
                let foto = jStr(e["foto"]).flatMap { $0.isEmpty ? nil : $0 }
                return Dish(id: jStr(e["md5"]) ?? jStr(e["a_id"]) ?? "\(iso)-\(jStr(e["title"]) ?? "")",
                            aid: jStr(e["a_id"]),
                            category: mensaClean(e["category"]),
                            title: mensaClean(e["title_clean"] ?? e["title"]),
                            description: mensaClean(e["description_clean"] ?? e["description"]),
                            intern: price(e["preis1"]), dhbw: price(e["preis2"]), extern: price(e["preis3"]),
                            image: foto == nil ? nil : abs(jStr(e["foto_sized"]) ?? foto),
                            thumb: foto == nil ? nil : abs(jStr(e["foto_thumb"]) ?? jStr(e["foto_sized"]) ?? foto),
                            tags: tags)
            }
            return MensaDay(date: iso, weekday: jStr(t["wochentag"]) ?? "", label: mensaClean(t["tag_formatiert2"] ?? iso), rel: mensaClean(t["tag_formatiert_rel"]), dishes: dishes)
        }
        let name = mensaClean(json["mensaname"])
        return MensaPlan(name: name.isEmpty ? "Mensa" : name, days: days, url: url, fetchedAt: Date())
    }
}

struct OrderConfig {
    var url: String
    var at: Date
    var origin: String
    var mensaId: String
    var api: String
    var config: [String: Any]
}

struct MensaSlot: Hashable {
    var time: String
    var until: String
    var free: Int
}

struct MensaStock: Hashable {
    var rest: Int
    var live: Int
}

struct OrderOptions {
    var date: String
    var earliest: String
    var orderable: Bool
    var termsUrl: String
    var slots: [MensaSlot] = []
    var message = ""
    var stock: [String: MensaStock] = [:]
}

struct MensaOrder: Codable, Hashable, Identifiable {
    struct Item: Codable, Hashable {
        var aid: String
        var n: Int
        var title: String
        var dhbw: Double?
    }

    var no: String
    var date: String
    var time: String
    var until: String
    var email: String
    var mensa: String
    var items: [Item]
    var at: Date
    var id: String { no }
}

// Wie jQuery.ajax auf der Bestellseite
private func formHeaders(_ req: inout URLRequest) {
    req.setValue("application/x-www-form-urlencoded; charset=UTF-8", forHTTPHeaderField: "Content-Type")
    req.setValue("application/json, text/javascript, */*; q=0.01", forHTTPHeaderField: "Accept")
    req.setValue("XMLHttpRequest", forHTTPHeaderField: "X-Requested-With")
}

private func firstGroup(_ s: String, _ pattern: String) -> String? {
    guard let re = try? NSRegularExpression(pattern: pattern, options: .dotMatchesLineSeparators),
          let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)), let r = Range(m.range(at: 1), in: s) else { return nil }
    return String(s[r])
}

// Datum als YYYY-MM-DD in deutscher Zeit (so rechnet die Mensa)
func isoDay(_ d: Date) -> String {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.timeZone = TimeZone(identifier: "Europe/Berlin")
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: d)
}

// Passt eine Abholzeit in eine Pause zwischen den Vorlesungen? (wie mensaBreaks/mensaSlotFits am Desktop)
// Gültig ist eine Pause, wenn sie mindestens minBreak Minuten lang ist, man darin während der Abholzeit
// abholen kann und ab Abholung noch minEat Minuten zum Essen bleiben. nil = kein Stundenplan für den Tag.
func mensaSlotFits(_ slots: [MensaSlot], date: String, events: [TTEvent]?) -> Set<String>? {
    guard let events else { return nil }
    let d = UserDefaults.standard
    let minBreak = Double(max(1, d.object(forKey: "mensaMinBreak") as? Int ?? 44)) * 60
    let minEat = Double(max(1, d.object(forKey: "mensaMinEat") as? Int ?? 30)) * 60
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "Europe/Berlin")!
    let f = DateFormatter()
    f.calendar = cal
    f.timeZone = cal.timeZone
    f.dateFormat = "yyyy-MM-dd HH:mm"
    let at = { (hm: String) in f.date(from: "\(date) \(hm)") }
    guard let pickFrom = at(d.string(forKey: "mensaPickupFrom") ?? "11:45") ?? at("11:45"),
          let pickTo = at(d.string(forKey: "mensaPickupTo") ?? "13:30") ?? at("13:30") else { return nil }
    let lectures = events.filter { !$0.allDay }.sorted { $0.start < $1.start }
    if lectures.isEmpty { return Set(slots.map(\.time)) }

    var merged: [(Date, Date)] = []
    for e in lectures {
        if let last = merged.last, e.start <= last.1 { merged[merged.count - 1].1 = max(last.1, e.end) } else { merged.append((e.start, e.end)) }
    }
    // (Abholung frühestens, Ende der Pause oder nil = offen)
    var breaks: [(from: Date, end: Date?)] = []
    func add(_ start: Date, _ end: Date?, before: Bool) {
        let from = max(start, pickFrom)
        let len = end == nil || before ? .infinity : end!.timeIntervalSince(start)
        let eat = end == nil ? .infinity : end!.timeIntervalSince(from)
        let ok = from <= pickTo && !(end != nil && end! <= pickFrom) && len >= minBreak && eat >= minEat
        if ok { breaks.append((from, end)) }
    }
    for i in 1..<max(1, merged.count) where merged[i].0 > merged[i - 1].1 { add(merged[i - 1].1, merged[i].0, before: false) }
    if merged[0].0 > pickFrom { add(min(pickFrom, merged[0].0), merged[0].0, before: true) }
    if merged[merged.count - 1].1 < pickTo { add(merged[merged.count - 1].1, nil, before: false) }

    var fits = Set<String>()
    for s in slots {
        guard let t = at(s.time) else { continue }
        if breaks.contains(where: { t >= $0.from && ($0.end == nil || t.addingTimeInterval(minEat) <= $0.end!) }) { fits.insert(s.time) }
    }
    return fits
}

func fmtEuro(_ n: Double?) -> String {
    guard let n else { return "–" }
    let f = NumberFormatter()
    f.locale = deLocale
    f.numberStyle = .currency
    f.currencyCode = "EUR"
    return f.string(from: NSNumber(value: n)) ?? "\(n) €"
}
