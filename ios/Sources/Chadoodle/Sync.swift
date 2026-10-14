// Synchronisation wie src/main/sync.js: holt Kurse, Inhalte, Termine, Noten und lädt alle Kursdateien
// in den Dokumente-Ordner der App (sichtbar in der Dateien-App unter „Auf meinem iPhone → Chadoodle“).
// Läuft beim Start, beim Zurückkehren in die App und per Ziehen zum Aktualisieren.
import CryptoKit
import Foundation
import SwiftUI

struct SyncStatus: Equatable {
    enum State { case idle, syncing, downloading, error }
    var state: State = .idle
    var message = ""
    var done = 0
    var total = 0
}

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var account: MoodleAccount?
    @Published private(set) var cache = MoodleCache()
    @Published private(set) var status = SyncStatus()
    // Einstellungen (die Ansichten binden dieselben Schlüssel mit @AppStorage)
    var autoDownload: Bool { UserDefaults.standard.object(forKey: "autoDownload") as? Bool ?? true }
    var maxFileSizeMB: Int { UserDefaults.standard.object(forKey: "maxFileSizeMB") as? Int ?? 200 }

    let index = DocIndex()
    let timetables = Timetables()
    let mensa = MensaStore()
    lazy var chatgpt = ChatGPTAuth()

    private var client: MoodleClient?
    private var running = false
    private var cacheURL: URL { AppPaths.file("cache/\(sha1(client?.siteUrl ?? "none").prefix(12)).json") }

    init() {
        if let a = Keychain.getJSON("moodleAccount", as: MoodleAccount.self) { attach(a) }
    }

    var signedIn: Bool { account != nil }

    // ---------- Anmeldung ----------
    func signIn(_ a: MoodleAccount) {
        Keychain.setJSON("moodleAccount", a)
        attach(a)
        Task { await sync() }
    }

    func signOut(deleteFiles: Bool) {
        Keychain.setJSON("moodleAccount", Optional<MoodleAccount>.none)
        if deleteFiles {
            let fm = FileManager.default
            for f in cache.files.values { try? fm.removeItem(at: f.localURL) }
            try? fm.removeItem(at: cacheURL)
            index.clear()
        }
        client = nil
        account = nil
        cache = MoodleCache()
        status = SyncStatus()
    }

    private func attach(_ a: MoodleAccount) {
        account = a
        var c = MoodleClient(a)
        client = c
        cache = readJSON(cacheURL, as: MoodleCache.self) ?? MoodleCache()
        c.userid = cache.site?.userid
        client = c
        index.attach(site: c.siteUrl)
    }

    private func save() { writeJSON(cacheURL, cache) }

    // Beim Öffnen der App: höchstens alle 10 Minuten neu synchronisieren
    func syncIfStale() async {
        if Date().timeIntervalSince1970 * 1000 - cache.lastSync > 10 * 60 * 1000 { await sync() }
        await timetables.refreshIfStale()
    }

    // ---------- Synchronisation ----------
    func sync() async {
        guard var c = client, !running else { return }
        running = true
        defer { running = false }
        let prev = cache
        let firstSync = prev.lastSync == 0
        var next = MoodleCache()
        next.newItems = prev.newItems

        do {
            status = SyncStatus(state: .syncing, message: "Verbinde mit Moodle…")
            guard let info = try await c.call("core_webservice_get_site_info") as? [String: Any], let uid = jInt(info["userid"]) else {
                throw MoodleError(message: "Unerwartete Antwort von Moodle")
            }
            c.userid = uid
            client = c
            next.site = SiteInfo(url: c.siteUrl, sitename: jStr(info["sitename"]) ?? "Moodle", fullname: jStr(info["fullname"]) ?? "",
                                 firstname: jStr(info["firstname"]) ?? "", lastname: jStr(info["lastname"]) ?? "", userid: uid)

            status.message = "Lade Kursliste…"
            let courses = try await c.call("core_enrol_get_users_courses", ["userid": uid, "returnusercount": 0]) as? [[String: Any]] ?? []
            next.courses = courses.compactMap { k in
                guard let id = jInt(k["id"]) else { return nil }
                return Course(id: id, fullname: stripHtml(jStr(k["fullname"])), shortname: stripHtml(jStr(k["shortname"])), summary: jStr(k["summary"]) ?? "",
                              categoryname: nil, progress: jDouble(k["progress"]), lastaccess: jInt(k["lastaccess"]),
                              isfavourite: jBool(k["isfavourite"]), hidden: jBool(k["hidden"]))
            }
            // Kategorienamen (optional, nicht jede Seite erlaubt das)
            let catIds = Set(courses.compactMap { jInt($0["category"]) })
            if !catIds.isEmpty, let cats = try? await c.call("core_course_get_categories", ["criteria": [["key": "ids", "value": catIds.map(String.init).joined(separator: ",")]], "addsubcategories": 0]) as? [[String: Any]] {
                let names = Dictionary(cats.compactMap { x in jInt(x["id"]).map { ($0, jStr(x["name"]) ?? "") } }, uniquingKeysWith: { a, _ in a })
                for i in next.courses.indices {
                    if let cat = jInt(courses.first { jInt($0["id"]) == next.courses[i].id }?["category"]) { next.courses[i].categoryname = names[cat] }
                }
            }

            var n = 0
            let ws = c
            try await pool(next.courses, limit: 4) { course in
                let sections = try? await ws.call("core_course_get_contents", ["courseid": course.id]) as? [[String: Any]]
                let grades = try? await ws.call("gradereport_user_get_grade_items", ["courseid": course.id, "userid": uid]) as? [String: Any]
                return (course.id, sections, grades)
            } onResult: { (cid, sections, grades) in
                n += 1
                self.status = SyncStatus(state: .syncing, message: "Kursinhalte…", done: n, total: next.courses.count)
                next.contents[cid] = sections.map { $0.map(parseSection) } ?? prev.contents[cid] ?? []
                if let g = grades, let ug = (g["usergrades"] as? [[String: Any]])?.first, let items = ug["gradeitems"] as? [[String: Any]] {
                    next.grades[cid] = items.map { it in
                        GradeItem(name: stripHtml(jStr(it["itemname"])).isEmpty ? (jStr(it["itemtype"]) == "course" ? "Kursgesamt" : "Bewertung") : stripHtml(jStr(it["itemname"])),
                                  grade: jStr(it["gradeformatted"]), range: jStr(it["rangeformatted"]), percentage: jStr(it["percentageformatted"]),
                                  feedback: jStr(it["feedback"]), itemtype: jStr(it["itemtype"]))
                    }
                } else {
                    next.grades[cid] = prev.grades[cid] ?? []
                }
            }

            let courseids = next.courses.map(\.id)
            status = SyncStatus(state: .syncing, message: "Aufgaben, Seiten und Foren…")
            if !courseids.isEmpty {
                if let a = try? await c.call("mod_assign_get_assignments", ["courseids": courseids]) as? [String: Any] {
                    for course in a["courses"] as? [[String: Any]] ?? [] {
                        for x in course["assignments"] as? [[String: Any]] ?? [] {
                            guard let cmid = jInt(x["cmid"]) else { continue }
                            next.assignments[cmid] = Assignment(id: jInt(x["id"]) ?? 0, courseid: jInt(course["id"]) ?? 0, name: jStr(x["name"]) ?? "",
                                                                duedate: jInt(x["duedate"]) ?? 0, cutoffdate: jInt(x["cutoffdate"]) ?? 0, intro: jStr(x["intro"]) ?? "",
                                                                attachments: (x["introattachments"] as? [[String: Any]] ?? []).map(parseFile))
                        }
                    }
                } else { next.assignments = prev.assignments }
                if let p = try? await c.call("mod_page_get_pages_by_courses", ["courseids": courseids]) as? [String: Any] {
                    for pg in p["pages"] as? [[String: Any]] ?? [] {
                        guard let cm = jInt(pg["coursemodule"]) else { continue }
                        next.pages[cm] = PageContent(name: jStr(pg["name"]) ?? "", content: jStr(pg["content"]) ?? "", timemodified: jInt(pg["timemodified"]) ?? 0)
                    }
                } else { next.pages = prev.pages }
                if let forums = try? await c.call("mod_forum_get_forums_by_courses", ["courseids": courseids]) as? [[String: Any]] {
                    try await pool(forums, limit: 4) { f -> (Int, Forum)? in
                        guard let fid = jInt(f["id"]), let cmid = jInt(f["cmid"]) else { return nil }
                        var list: [[String: Any]] = []
                        if let r = try? await ws.call("mod_forum_get_forum_discussions", ["forumid": fid, "sortorder": 1, "page": 0, "perpage": 15]) as? [String: Any] {
                            list = r["discussions"] as? [[String: Any]] ?? []
                        } else if let r = try? await ws.call("mod_forum_get_forum_discussions_paginated", ["forumid": fid, "sortby": "timemodified", "sortdirection": "DESC", "page": 0, "perpage": 15]) as? [String: Any] {
                            list = r["discussions"] as? [[String: Any]] ?? []
                        }
                        return (cmid, Forum(name: jStr(f["name"]) ?? "", courseid: jInt(f["course"]) ?? 0, discussions: list.map { d in
                            Discussion(id: jInt(d["discussion"]) ?? jInt(d["id"]) ?? 0, subject: jStr(d["subject"]) ?? jStr(d["name"]) ?? "", message: jStr(d["message"]) ?? "",
                                       author: jStr(d["userfullname"]) ?? "", created: jInt(d["created"]) ?? 0, modified: jInt(d["timemodified"]) ?? 0,
                                       replies: jInt(d["numreplies"]) ?? 0, pinned: jBool(d["pinned"]))
                        }))
                    } onResult: { r in
                        if let (cmid, forum) = r { next.forums[cmid] = forum }
                    }
                } else { next.forums = prev.forums }
            }

            status.message = "Termine…"
            let now = Int(Date().timeIntervalSince1970)
            if let ev = try? await c.call("core_calendar_get_action_events_by_timesort", ["timesortfrom": now - 3 * 86400, "limitnum": 50, "limittononsuspendedevents": 1]) as? [String: Any] {
                next.events = (ev["events"] as? [[String: Any]] ?? []).compactMap { e in
                    guard let id = jInt(e["id"]) else { return nil }
                    let url = jStr(e["url"])
                    let cmid = url.flatMap { u in u.range(of: "[?&]id=(\\d+)", options: .regularExpression).map { Int(u[$0].dropFirst(4)) } } ?? nil
                    let course = e["course"] as? [String: Any]
                    return CalEvent(id: id, name: jStr(e["name"]) ?? "", activityname: jStr(e["activityname"]), timesort: jInt(e["timesort"]) ?? 0,
                                    modulename: jStr(e["modulename"]), cmid: cmid, courseid: jInt(course?["id"]), coursename: stripHtml(jStr(course?["fullname"])),
                                    url: url, overdue: jBool(e["overdue"]))
                }
            } else { next.events = prev.events }

            // Während des Abrufs abgemeldet? Dann gehören die Daten zur alten Sitzung.
            guard self.client?.token == c.token else { return }

            next.files = buildFileIndex(&next, prev: prev)
            let newFiles = firstSync ? [] : next.files.values.filter { prev.files[$0.id] == nil }
            for f in newFiles { next.newItems.insert(NewItem(fileId: f.id, courseId: f.courseId, time: Date().timeIntervalSince1970), at: 0) }
            next.newItems = Array(next.newItems.filter { next.files[$0.fileId] != nil }.prefix(100))
            next.lastSync = Date().timeIntervalSince1970 * 1000
            cache = next
            save()

            await downloadPending()
            status = SyncStatus(state: .idle, message: "Synchronisiert")
            index.indexPending(cache.files)
        } catch {
            guard self.client?.token == c.token else { return }
            cache.lastError = error.localizedDescription
            let offline = (error as? URLError) != nil
            status = SyncStatus(state: .error, message: offline ? "Offline – zeige lokale Daten" : error.localizedDescription)
            index.indexPending(cache.files)
        }
    }

    private func parseFile(_ f: [String: Any]) -> ModFile {
        ModFile(type: jStr(f["type"]) ?? "file", filename: jStr(f["filename"]) ?? "Datei", filepath: jStr(f["filepath"]) ?? "/",
                filesize: jInt(f["filesize"]) ?? 0, fileurl: jStr(f["fileurl"]) ?? "", timemodified: jInt(f["timemodified"]) ?? 0, mimetype: jStr(f["mimetype"]))
    }

    private func parseSection(_ s: [String: Any]) -> CourseSection {
        CourseSection(id: jInt(s["id"]) ?? 0, section: jInt(s["section"]) ?? 0, name: stripHtml(jStr(s["name"])), summary: jStr(s["summary"]) ?? "",
                      uservisible: s["uservisible"] == nil || jBool(s["uservisible"]),
                      modules: (s["modules"] as? [[String: Any]] ?? []).compactMap { m in
                          guard let id = jInt(m["id"]) else { return nil }
                          return Module(id: id, instance: jInt(m["instance"]), name: stripHtml(jStr(m["name"])), modname: jStr(m["modname"]) ?? "",
                                        url: jStr(m["url"]), description: jStr(m["description"]) ?? "", uservisible: m["uservisible"] == nil || jBool(m["uservisible"]),
                                        completion: jInt((m["completiondata"] as? [String: Any])?["state"]),
                                        dates: (m["dates"] as? [[String: Any]] ?? []).map { ModDate(label: jStr($0["label"]) ?? "", timestamp: jInt($0["timestamp"]) ?? 0) },
                                        contents: (m["contents"] as? [[String: Any]] ?? []).map(parseFile))
                      })
    }

    private func buildFileIndex(_ next: inout MoodleCache, prev: MoodleCache) -> [String: LocalFile] {
        var files: [String: LocalFile] = [:]
        var used = Set<String>()
        let fm = FileManager.default

        func add(_ course: Course, _ sectionLabel: String, _ mod: Module, _ f: ModFile, _ subdir: String?) {
            guard !f.fileurl.isEmpty, f.type != "url" else { return }
            let id = String(sha1(String(f.fileurl.split(separator: "?").first ?? "")).prefix(12))
            guard files[id] == nil else { return }
            let old = prev.files[id]
            var rel = old?.relPath
            if rel == nil {
                var dir = [safeName(course.title, 60), sectionLabel]
                if let subdir { dir.append(safeName(subdir)) }
                dir += f.filepath.split(separator: "/").map { safeName(String($0)) }
                var candidate = (dir + [safeName(f.filename, 120)]).joined(separator: "/")
                var i = 2
                while used.contains(candidate.lowercased()) {
                    let ext = (f.filename as NSString).pathExtension
                    let base = safeName((f.filename as NSString).deletingPathExtension, 110)
                    candidate = (dir + ["\(base) (\(i))" + (ext.isEmpty ? "" : ".\(ext)")]).joined(separator: "/")
                    i += 1
                }
                rel = candidate
            }
            used.insert(rel!.lowercased())
            let changed = old != nil && old!.timemodified != f.timemodified
            let path = AppPaths.documents.appendingPathComponent(rel!).path
            files[id] = LocalFile(id: id, courseId: course.id, cmid: mod.id, modname: mod.modname, moduleName: mod.name, section: sectionLabel,
                                  filename: f.filename, filesize: f.filesize, mimetype: f.mimetype, timemodified: f.timemodified, url: f.fileurl,
                                  relPath: rel!, downloaded: (old?.downloaded ?? false) && !changed && fm.fileExists(atPath: path),
                                  updated: changed, error: nil)
        }

        for course in next.courses {
            for (idx, s) in (next.contents[course.id] ?? []).enumerated() {
                let label = safeName(String(format: "%02d ", idx) + (s.name.isEmpty ? "Abschnitt \(s.section)" : s.name), 70)
                for m in s.modules {
                    if m.modname == "resource" {
                        let multi = m.contents.filter { $0.type == "file" }.count > 1
                        m.contents.forEach { add(course, label, m, $0, multi ? m.name : nil) }
                    } else if m.modname == "folder" {
                        m.contents.forEach { add(course, label, m, $0, m.name) }
                    } else if m.modname == "assign", let a = next.assignments[m.id] {
                        a.attachments.forEach { add(course, label, m, $0, m.name) }
                    }
                }
            }
        }
        // Datei-IDs an die Module hängen, damit die Oberfläche sie direkt findet
        var byUrl: [String: String] = [:]
        for f in files.values { byUrl[String(f.url.split(separator: "?").first ?? "")] = f.id }
        let key = { (u: String) in String(u.split(separator: "?").first ?? "") }
        for (cid, sections) in next.contents {
            next.contents[cid] = sections.map { s in
                var s = s
                s.modules = s.modules.map { m in
                    var m = m
                    m.contents = m.contents.map { var f = $0; f.fileId = byUrl[key(f.fileurl)]; return f }
                    return m
                }
                return s
            }
        }
        for (cm, a) in next.assignments {
            var a = a
            a.attachments = a.attachments.map { var f = $0; f.fileId = byUrl[key(f.fileurl)]; return f }
            next.assignments[cm] = a
        }
        return files
    }

    private func downloadPending() async {
        guard autoDownload, let client else { return }
        let max = maxFileSizeMB * 1024 * 1024
        let todo = cache.files.values.filter { !$0.downloaded && ($0.filesize == 0 || $0.filesize <= max) }
        guard !todo.isEmpty else { return }
        var done = 0
        status = SyncStatus(state: .downloading, message: "Lade \(todo.count) Dateien…", done: 0, total: todo.count)
        try? await pool(todo, limit: 3) { f -> (String, String?) in
            do {
                try await client.download(f.url, to: f.localURL)
                return (f.id, nil)
            } catch {
                return (f.id, error.localizedDescription)
            }
        } onResult: { (id, err) in
            guard self.client?.token == client.token else { return }
            done += 1
            self.cache.files[id]?.downloaded = err == nil
            self.cache.files[id]?.error = err
            self.status = SyncStatus(state: .downloading, message: self.cache.files[id]?.filename ?? "", done: done, total: todo.count)
        }
        save()
    }

    // Datei bei Bedarf sofort laden (Öffnen im Viewer, KI liest sie)
    func ensureFile(_ id: String) async throws -> LocalFile {
        guard let f = cache.files[id] else { throw MoodleError(message: "Datei unbekannt") }
        if f.downloaded, FileManager.default.fileExists(atPath: f.localURL.path) { return f }
        guard let client else { throw MoodleError(message: "Nicht angemeldet") }
        try await client.download(f.url, to: f.localURL)
        cache.files[id]?.downloaded = true
        cache.files[id]?.error = nil
        save()
        return cache.files[id]!
    }

    func clearNews() {
        cache.newItems = []
        save()
    }

    func onlineURL(_ target: String) async -> URL? {
        guard let client else { return URL(string: target) }
        return client.isSiteUrl(target) ? await client.autologinUrl(target) : URL(string: target)
    }

    // ---------- Hilfen ----------
    func files(of module: Module) -> [LocalFile] {
        var ids = module.contents.compactMap(\.fileId)
        if let a = cache.assignments[module.id] { ids += a.attachments.compactMap(\.fileId) }
        var seen = Set<String>()
        return ids.filter { seen.insert($0).inserted }.compactMap { cache.files[$0] }
    }
}

func sha1(_ s: String) -> String {
    Insecure.SHA1.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
}

func safeName(_ name: String, _ max: Int = 80) -> String {
    var s = name.replacingOccurrences(of: "<[^>]*>", with: "", options: .regularExpression)
    s = s.replacingOccurrences(of: "[<>:\"/\\\\|?*\\x00-\\x1f]", with: "_", options: .regularExpression)
    s = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    s = s.replacingOccurrences(of: "[. ]+$", with: "", options: .regularExpression)
    if s.count > max { s = String(s.prefix(max)).trimmingCharacters(in: .whitespaces) }
    return s.isEmpty ? "Unbenannt" : s
}

// Parallel mit begrenzter Anzahl; Ergebnisse werden der Reihe nach auf dem MainActor verarbeitet
@MainActor
func pool<T, R>(_ items: [T], limit: Int, _ work: @escaping (T) async throws -> R, onResult: (R) -> Void) async throws {
    try await withThrowingTaskGroup(of: R.self) { group in
        var it = items.makeIterator()
        for _ in 0..<min(limit, items.count) {
            if let x = it.next() { group.addTask { try await work(x) } }
        }
        while let r = try await group.next() {
            onResult(r)
            if let x = it.next() { group.addTask { try await work(x) } }
        }
    }
}
