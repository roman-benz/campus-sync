// ChatGPT-Lernassistent über „Sign in with ChatGPT“ (Plan-Nutzung statt API-Key), wie src/main/chatgpt.js.
// Responses API mit store:false + stream:true; der Verlauf wird lokal gehalten und komplett mitgeschickt.
// Die Werkzeuge (wie src/main/ai-tools.js) arbeiten auf der lokalen Kopie (Cache + Volltextindex).
// Datenschutz: keine Namen anderer Personen (Forenautoren) an den KI-Anbieter, keine Noten.
import Foundation
import SwiftUI

private let apiBase = "https://api.openai.com/v1"
private let maxPagesPerRead = 25

struct ChatMessage: Identifiable {
    enum Role { case user, assistant }
    let id = UUID()
    var role: Role
    var text = ""
    var thinking = ""
    var tools: [String] = []
    var error: String?
}

@MainActor
final class Assistant: ObservableObject {
    @Published private(set) var messages: [ChatMessage] = []
    @Published private(set) var busy = false
    @Published private(set) var models: [ModelInfo] = []

    private var input: [[String: Any]] = []
    private var task: Task<Void, Never>?
    private var noReasoningOpts = false
    private weak var app: AppModel?

    func attach(_ app: AppModel) { self.app = app }

    func reset() {
        task?.cancel()
        messages = []
        input = []
        busy = false
    }

    func stop() { task?.cancel() }

    func send(_ text: String, context: String? = nil) {
        guard !busy, let app else { return }
        let content = context.map { "\($0)\n\n\(text)" } ?? text
        messages.append(ChatMessage(role: .user, text: text))
        messages.append(ChatMessage(role: .assistant))
        busy = true
        let startLen = input.count
        input.append(["type": "message", "role": "user", "content": [["type": "input_text", "text": content]]])
        task = Task {
            do {
                try await run(app)
            } catch {
                input.removeSubrange(startLen...)
                if Task.isCancelled {
                    updateLast { $0.error = $0.text.isEmpty ? "Gestoppt." : nil }
                } else {
                    updateLast { $0.error = self.describe(error) }
                }
            }
            busy = false
        }
    }

    private func updateLast(_ f: (inout ChatMessage) -> Void) {
        guard !messages.isEmpty else { return }
        f(&messages[messages.count - 1])
    }

    // ---------- Modelle ----------
    func loadModels(force: Bool = false) async {
        guard let app, force || models.isEmpty, let token = try? await app.chatgpt.accessToken() else { return }
        var req = URLRequest(url: URL(string: "\(apiBase)/models")!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let resp = try? await URLSession.shared.data(for: req) else { return }
        let json = try? JSONSerialization.jsonObject(with: resp.0)
        let list = (json as? [[String: Any]]) ?? ((json as? [String: Any])?["data"] as? [[String: Any]]) ?? ((json as? [String: Any])?["models"] as? [[String: Any]]) ?? []
        models = list.filter { ($0["visibility"] as? String).map { $0 == "list" } ?? true }.compactMap { m in
            guard let id = (m["slug"] as? String) ?? (m["id"] as? String) else { return nil }
            return ModelInfo(id: id, name: (m["display_name"] as? String) ?? id)
        }
    }

    // Standard: erstes Modell, das kein „Pro“-Modell ist – die denken oft minutenlang
    private func pickModel() async throws -> String {
        await loadModels()
        let wanted = UserDefaults.standard.string(forKey: "chatgptModel") ?? ""
        if !wanted.isEmpty, models.isEmpty || models.contains(where: { $0.id == wanted }) { return wanted }
        if let normal = models.first(where: { ($0.id + " " + $0.name).range(of: "(^|[-_ ])pro\\b", options: [.regularExpression, .caseInsensitive]) == nil }) {
            return normal.id
        }
        if let first = models.first { return first.id }
        throw OAuthError(message: "Für deinen ChatGPT-Plan sind keine Modelle verfügbar.")
    }

    // ---------- Ablauf ----------
    private func run(_ app: AppModel) async throws {
        let model = try await pickModel()
        let effort = ["fast": "low", "balanced": "medium", "thorough": "high"][UserDefaults.standard.string(forKey: "aiEffort") ?? "balanced"] ?? "medium"
        let tools = AITools(app: app)
        var authRetried = false
        var rounds = 0
        while true {
            rounds += 1
            if rounds > 25 { throw OAuthError(message: "Zu viele Werkzeugschritte – bitte die Frage eingrenzen.") }
            try Task.checkCancellation()
            let token = try await app.chatgpt.accessToken()
            var params: [String: Any] = [
                "model": model, "instructions": tools.instructions(), "input": input, "tools": AITools.specs.map { spec in
                    ["type": "function", "name": spec.name, "description": spec.description, "parameters": spec.schema, "strict": false] as [String: Any]
                }, "parallel_tool_calls": true, "store": false, "stream": true,
            ]
            if !noReasoningOpts {
                params["include"] = ["reasoning.encrypted_content"]
                params["reasoning"] = ["summary": "auto", "effort": effort]
            }
            var req = URLRequest(url: URL(string: "\(apiBase)/responses")!, timeoutInterval: 240)
            req.httpMethod = "POST"
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            req.httpBody = try JSONSerialization.data(withJSONObject: params)

            let (bytes, res) = try await URLSession.shared.bytes(for: req)
            let status = (res as? HTTPURLResponse)?.statusCode ?? 0
            if status != 200 {
                var body = ""
                for try await line in bytes.lines { body += line; if body.count > 4000 { break } }
                let err = ((try? JSONSerialization.jsonObject(with: Data(body.utf8))) as? [String: Any])?["error"] as? [String: Any]
                let msg = (err?["message"] as? String) ?? "HTTP \(status)"
                let code = (err?["code"] as? String) ?? ""
                if status == 401 && !authRetried {
                    authRetried = true
                    _ = try await app.chatgpt.accessToken(force: true)
                    continue
                }
                if status == 400 && !noReasoningOpts && msg.range(of: "reasoning|include|effort", options: [.regularExpression, .caseInsensitive]) != nil {
                    noReasoningOpts = true
                    continue
                }
                throw APIFailure(status: status, code: code, message: msg)
            }

            var output: [[String: Any]] = []
            var completed: [String: Any]?
            var streamed = ""
            for try await line in bytes.lines {
                try Task.checkCancellation()
                guard line.hasPrefix("data:") else { continue }
                let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                guard payload != "[DONE]", let ev = (try? JSONSerialization.jsonObject(with: Data(payload.utf8))) as? [String: Any] else { continue }
                switch ev["type"] as? String {
                case "response.output_item.done":
                    if let item = ev["item"] as? [String: Any] { output.append(item) }
                case "response.output_text.delta":
                    let d = ev["delta"] as? String ?? ""
                    streamed += d
                    updateLast { $0.text += d }
                case "response.reasoning_summary_text.delta":
                    let d = ev["delta"] as? String ?? ""
                    updateLast { $0.thinking += d }
                case "response.completed":
                    completed = ev["response"] as? [String: Any]
                case "response.failed", "response.incomplete", "error":
                    let r = ev["response"] as? [String: Any]
                    let er = (r?["error"] as? [String: Any]) ?? (ev["error"] as? [String: Any]) ?? ev
                    let reason = (r?["incomplete_details"] as? [String: Any])?["reason"] as? String
                    throw APIFailure(status: 0, code: (er["code"] as? String) ?? reason ?? "", message: (er["message"] as? String) ?? (reason.map { "Antwort unvollständig (\($0))" } ?? "Antwort fehlgeschlagen"))
                default: break
                }
            }
            if let out = completed?["output"] as? [[String: Any]], !out.isEmpty { output = out }
            if !output.contains(where: { $0["type"] as? String == "message" }) && !streamed.isEmpty {
                output.append(["type": "message", "role": "assistant", "content": [["type": "output_text", "text": streamed]]])
            }
            if completed == nil && output.isEmpty { throw OAuthError(message: "Antwort wurde unterbrochen.") }
            input.append(contentsOf: toInputItems(output))

            let calls = output.filter { $0["type"] as? String == "function_call" }
            if calls.isEmpty { return }
            for call in calls {
                let name = call["name"] as? String ?? ""
                let callId = call["call_id"] as? String ?? ""
                let args = ((try? JSONSerialization.jsonObject(with: Data((call["arguments"] as? String ?? "{}").utf8))) as? [String: Any]) ?? [:]
                updateLast { $0.tools.append(tools.label(name, args)) }
                let result: String
                do { result = try await tools.run(name, args) } catch { result = "Fehler: \(error.localizedDescription)" }
                input.append(["type": "function_call_output", "call_id": callId, "output": result])
            }
            // Neue Runde: Text der nächsten Antwort beginnt in derselben Nachricht
            if !streamed.isEmpty { updateLast { $0.text += "\n\n" } }
        }
    }

    // Ausgabe-Elemente so zurückschicken, dass sie ohne serverseitige Speicherung gültig sind
    private func toInputItems(_ output: [[String: Any]]) -> [[String: Any]] {
        output.compactMap { it in
            switch it["type"] as? String {
            case "message":
                let content = (it["content"] as? [[String: Any]] ?? []).filter { $0["type"] as? String == "output_text" }
                    .map { ["type": "output_text", "text": $0["text"] as? String ?? "", "annotations": [Any]()] as [String: Any] }
                return ["type": "message", "role": "assistant", "content": content]
            case "function_call":
                return ["type": "function_call", "call_id": it["call_id"] ?? "", "name": it["name"] ?? "", "arguments": it["arguments"] ?? "{}"]
            case "reasoning":
                guard let enc = it["encrypted_content"] else { return nil }
                return ["type": "reasoning", "id": it["id"] ?? "", "summary": it["summary"] ?? [Any](), "encrypted_content": enc]
            default:
                return nil
            }
        }
    }

    private func describe(_ err: Error) -> String {
        if let e = err as? OAuthError, e.code == "auth_required" { return e.message }
        if let e = err as? APIFailure {
            switch e.code {
            case "subscription_sharing_usage_limit_exceeded": return "Nutzungslimit erreicht. Prüfe deinen Plan oder das Limit dieser App in den ChatGPT-Einstellungen."
            case "subscription_sharing_user_not_eligible": return "Dein ChatGPT-Konto ist für die Plan-Nutzung in Apps nicht berechtigt (Plus oder Pro nötig)."
            case "subscription_sharing_usage_unavailable": return "Die ChatGPT-Plan-Nutzung ist gerade nicht verfügbar. Bitte später erneut versuchen."
            default:
                if e.status == 429 { return "Nutzungslimit erreicht. Bitte später erneut versuchen." }
                if e.status == 503 { return "ChatGPT ist gerade nicht verfügbar. Bitte später erneut versuchen." }
                return "ChatGPT-Fehler (\(e.status == 0 ? "–" : String(e.status))): \(e.message)"
            }
        }
        if err is URLError { return "Keine Verbindung zu ChatGPT. Bist du offline?" }
        return err.localizedDescription
    }
}

struct ModelInfo: Identifiable, Hashable {
    let id: String
    let name: String
}

struct APIFailure: LocalizedError {
    let status: Int
    let code: String
    let message: String
    var errorDescription: String? { message }
}

// ---------- Werkzeuge ----------
@MainActor
struct AITools {
    let app: AppModel
    private var c: MoodleCache { app.cache }

    struct Spec {
        let name: String
        let description: String
        let schema: [String: Any]
    }

    private static func obj(_ props: [String: [String: Any]], _ required: [String]) -> [String: Any] {
        ["type": "object", "properties": props, "required": required]
    }

    static let specs: [Spec] = [
        Spec(name: "search_documents", description: "Volltextsuche im INHALT aller synchronisierten Kursdokumente (PDF-Skripte, Folien, Code). Liefert Fundstellen mit Datei, Seite und Textausschnitt. Das wichtigste Werkzeug, um Stellen in den Unterlagen zu finden. Nutze mehrere Suchen mit Synonymen/Fachbegriffen, wenn die erste wenig liefert.",
             schema: obj(["query": ["type": "string", "description": "Suchbegriffe; \"Anführungszeichen\" für exakte Wortgruppen"],
                          "course_id": ["type": "integer", "description": "Optional: nur in diesem Kurs suchen"],
                          "file_id": ["type": "string", "description": "Optional: nur in diesem Dokument suchen"]], ["query"])),
        Spec(name: "read_pages", description: "Liest bestimmte Seiten/Folien eines Dokuments als Text (max. \(maxPagesPerRead) Seiten pro Aufruf). Ideal nach search_documents, um eine Fundstelle mit Kontext zu lesen.",
             schema: obj(["file_id": ["type": "string"], "from_page": ["type": "integer", "description": "Erste Seite (ab 1)"], "to_page": ["type": "integer", "description": "Letzte Seite (inklusive)"]], ["file_id", "from_page", "to_page"])),
        Spec(name: "read_file", description: "Liest ein ganzes Dokument (bei sehr langen Dokumenten den Anfang plus Seitenzahl). Für gezielte Stellen besser search_documents + read_pages.",
             schema: obj(["file_id": ["type": "string", "description": "file_id aus get_course_contents, search_documents oder search_materials"]], ["file_id"])),
        Spec(name: "list_courses", description: "Listet alle Moodle-Kurse des Nutzers mit ID, Name und Fortschritt.", schema: obj([:], [])),
        Spec(name: "get_course_contents", description: "Struktur eines Kurses: Abschnitte mit allen Aktivitäten und Dateien inkl. file_id und module_id.",
             schema: obj(["course_id": ["type": "integer", "description": "Kurs-ID aus list_courses"]], ["course_id"])),
        Spec(name: "search_materials", description: "Sucht in Datei-, Aktivitäts- und Abschnittsnamen sowie Textseiten, Aufgabenstellungen und Forenbeiträgen (nicht im Inhalt der PDFs – dafür search_documents).",
             schema: obj(["query": ["type": "string", "description": "Suchbegriff(e)"], "course_id": ["type": "integer", "description": "Optional: nur in diesem Kurs suchen"]], ["query"])),
        Spec(name: "read_activity", description: "Liest eine Aktivität: Textseite, Aufgabenstellung (mit Fälligkeit), Forendiskussionen oder Beschreibung.",
             schema: obj(["module_id": ["type": "integer", "description": "module_id aus get_course_contents"]], ["module_id"])),
        Spec(name: "get_deadlines", description: "Anstehende Termine und Abgaben (Zeitleiste) aller Kurse.",
             schema: obj(["days": ["type": "integer", "description": "Zeitraum in Tagen ab heute (Standard 30)"]], [])),
        Spec(name: "get_timetable", description: "Vorlesungen aus dem aktiven Stundenplan (Rapla/iCal) mit Uhrzeit, Titel und Raum, nach Tagen gruppiert.",
             schema: obj(["from_date": ["type": "string", "description": "Erster Tag als YYYY-MM-DD (Standard: heute)"], "days": ["type": "integer", "description": "Anzahl Tage ab from_date, 1–21 (Standard 7)"]], [])),
        Spec(name: "get_mensa_menu", description: "Speiseplan der Mensa mit Kategorie, Beschreibung, vegan/vegetarisch, Allergenen und Preisen.",
             schema: obj(["date": ["type": "string", "description": "Optional: nur dieser Tag (YYYY-MM-DD); sonst alle veröffentlichten Tage"]], [])),
    ]

    func instructions() -> String {
        let site = c.site
        let f = DateFormatter()
        f.locale = deLocale
        f.dateFormat = "EEEE, dd. MMMM yyyy"
        return [
            "Du bist der Lernassistent in „Chadoodle“, einer iPhone-App, die die Moodle-Kurse einer/eines Studierenden lokal synchronisiert.",
            "Nutzer: \(site?.firstname ?? "unbekannt") (Moodle: \(site?.sitename ?? "–")). Heute ist \(f.string(from: Date())).",
            "",
            "Deine Hauptaufgabe: die Kursunterlagen durchsuchen, die passenden Stellen finden und verständlich erklären.",
            "- Suche zuerst mit search_documents in den Dokumenten und lies relevante Stellen mit read_pages, bevor du inhaltlich antwortest. Rate nicht, wenn die Unterlagen die Antwort enthalten können.",
            "- Probiere bei wenigen Treffern Synonyme, Fachbegriffe, Abkürzungen oder englische Begriffe.",
            "- Belege Aussagen mit Fundstellen und verlinke sie IMMER als Markdown-Link im Format [Dateiname, S. 12](doc://FILE_ID?page=12). Die App öffnet diese Links direkt an der Seite im PDF-Viewer.",
            "- Erkläre didaktisch: erst die Kernidee, dann Details, bei Bedarf ein kurzes Beispiel. Die App zeigt kein LaTeX – schreibe Formeln gut lesbar mit Unicode (z. B. x², √, ∑, ∫, ≤).",
            "- Wenn die Unterlagen etwas nicht abdecken, sag das und ergänze dann mit allgemeinem Fachwissen (klar gekennzeichnet).",
            "- Für Termine und Abgaben nutze get_deadlines und read_activity. Auf Noten hast du keinen Zugriff.",
            "- Bei bewerteten Abgaben: erkläre, gib Hinweise und Feedback; eine fertige Lösung zum Abgeben schreibst du nicht, sondern hilfst Schritt für Schritt.",
            "- Stundenplan: get_timetable. Mensa: get_mensa_menu. Bestellen kann der Nutzer selbst im Reiter Mensa (Warenkorb, Abholzeit, Bestätigung).",
            "- Antworte auf Deutsch (außer der Nutzer schreibt anders), knapp und mit Markdown (Überschriften, Listen, **fett**).",
        ].joined(separator: "\n")
    }

    func label(_ name: String, _ input: [String: Any]) -> String {
        let f = (input["file_id"] as? String).flatMap { c.files[$0] }
        let k = jInt(input["course_id"]).flatMap { c.course($0) }
        switch name {
        case "search_documents": return "Durchsucht Dokumente nach „\(input["query"] as? String ?? "")“"
        case "read_pages": return "Liest \(f?.filename ?? "Dokument"), S. \(jInt(input["from_page"]) ?? 1)"
        case "read_file": return "Liest \(f?.filename ?? "Datei")"
        case "list_courses": return "Schaut sich deine Kurse an"
        case "get_course_contents": return "Öffnet Kurs \(k?.title ?? "")"
        case "search_materials": return "Sucht Materialien zu „\(input["query"] as? String ?? "")“"
        case "read_activity": return "Liest \(jInt(input["module_id"]).flatMap { c.findModule($0)?.module.name } ?? "Aktivität")"
        case "get_deadlines": return "Prüft anstehende Termine"
        case "get_timetable": return "Schaut in den Stundenplan"
        case "get_mensa_menu": return "Schaut auf den Speiseplan"
        default: return name
        }
    }

    func run(_ name: String, _ input: [String: Any]) async throws -> String {
        if name == "get_timetable" { return timetableText(input) }
        if name == "get_mensa_menu" { return await mensaText(input) }
        guard c.site != nil else { return "Noch keine Daten synchronisiert." }
        switch name {
        case "search_documents":
            guard let q = input["query"] as? String else { throw OAuthError(message: "query fehlt") }
            let r = app.index.search(q, files: c.files, courseId: jInt(input["course_id"]), fileId: input["file_id"] as? String, limit: 25)
            let p = app.index.progress(c.files)
            let note = p.indexed < p.total ? "\n(Hinweis: \(p.indexed) von \(p.total) Dokumenten sind bereits indexiert.)" : ""
            if r.hits.isEmpty { return "Keine Fundstellen für „\(q)“.\(note)" }
            var lines = ["\(r.totalPages) Seiten in \(r.totalFiles) Dokumenten gefunden (beste Treffer):"]
            for h in r.hits {
                guard let f = c.files[h.fileId] else { continue }
                lines.append("- \(f.filename) [\(c.course(f.courseId)?.shortname ?? "")] (file_id: \(f.id)) S. \(h.page): \(h.snippet)")
            }
            return lines.joined(separator: "\n") + note
        case "read_pages", "read_file":
            guard let id = input["file_id"] as? String, c.files[id] != nil else { throw OAuthError(message: "Unbekannte file_id") }
            let f = try await app.ensureFile(id)
            guard let pages = await app.index.pages(of: f) else { return "\(f.filename) kann nicht als Text gelesen werden." }
            let from = name == "read_file" ? 1 : max(1, jInt(input["from_page"]) ?? 1)
            let to = name == "read_file" ? min(pages.count, 40) : min(pages.count, min(jInt(input["to_page"]) ?? from, from + maxPagesPerRead - 1))
            guard from <= pages.count else { return "\(f.filename) hat nur \(pages.count) Seiten." }
            var out = ["\(f.filename) – Seiten \(from)–\(max(from, to)) von \(pages.count)"]
            for n in from...max(from, to) { out.append("\n--- Seite \(n) ---\n\(pages[n - 1].isEmpty ? "(kein Text – evtl. nur Abbildung)" : pages[n - 1])") }
            if name == "read_file" && pages.count > 40 { out.append("\n[Dokument hat \(pages.count) Seiten – weitere Seiten mit read_pages lesen.]") }
            return out.joined(separator: "\n")
        case "list_courses":
            return c.courses.map { k in
                "- \(k.fullname) (course_id: \(k.id), Kürzel: \(k.shortname)\(k.categoryname.map { ", \($0)" } ?? "")\(k.progress.map { ", Fortschritt \(Int($0))%" } ?? ""))"
            }.joined(separator: "\n").nonEmpty ?? "Keine Kurse."
        case "get_course_contents":
            guard let k = jInt(input["course_id"]).flatMap({ c.course($0) }) else { throw OAuthError(message: "Kurs nicht gefunden") }
            var lines = ["# \(k.fullname)"]
            for s in c.contents[k.id] ?? [] {
                lines.append("\n## \(s.name.isEmpty ? "Abschnitt \(s.section)" : s.name)")
                let sum = stripHtml(s.summary)
                if !sum.isEmpty { lines.append(String(sum.prefix(600))) }
                for m in s.modules {
                    var line = "- [\(modLabel[m.modname] ?? m.modname)] \(m.name) (module_id: \(m.id))"
                    if let a = c.assignments[m.id], a.duedate > 0 { line += " – fällig \(fmtDate(a.duedate))" }
                    lines.append(line)
                    if m.modname == "label" {
                        let t = stripHtml(m.description)
                        if !t.isEmpty { lines.append("  " + String(t.prefix(300)).replacingOccurrences(of: "\n", with: " ")) }
                    }
                    for f in app.files(of: m) {
                        lines.append("  - Datei: \(f.filename) (file_id: \(f.id), \(fmtSize(f.filesize))\(f.downloaded ? ", lokal" : ""))")
                    }
                }
            }
            return lines.joined(separator: "\n")
        case "search_materials":
            let terms = (input["query"] as? String ?? "").lowercased().split(separator: " ").map(String.init)
            let score = { (t: String) in terms.reduce(0) { $0 + (t.lowercased().contains($1) ? 1 : 0) } }
            let cid = jInt(input["course_id"])
            var hits: [(Int, String)] = []
            for k in c.courses where cid == nil || k.id == cid {
                for s in c.contents[k.id] ?? [] {
                    for m in s.modules {
                        let extra = stripHtml(m.description) + " " + stripHtml(c.pages[m.id]?.content) + " " + stripHtml(c.assignments[m.id]?.intro)
                        let sc = score(m.name) * 3 + score(s.name) + score(extra)
                        if sc > 0 { hits.append((sc, "[\(k.shortname)] \(modLabel[m.modname] ?? m.modname) „\(m.name)“ in „\(s.name)“ (module_id: \(m.id))")) }
                    }
                }
                for f in c.files.values where f.courseId == k.id {
                    let sc = score(f.filename) * 3 + score(f.moduleName)
                    if sc > 0 { hits.append((sc, "[\(k.shortname)] Datei \(f.filename) (file_id: \(f.id), Aktivität „\(f.moduleName)“)")) }
                }
            }
            for (cmid, fo) in c.forums where cid == nil || fo.courseid == cid {
                for d in fo.discussions {
                    let sc = score(d.subject) * 2 + score(stripHtml(d.message))
                    if sc > 0 { hits.append((sc, "Forum „\(fo.name)“: \(d.subject) (module_id: \(cmid), \(fmtDate(d.modified)))")) }
                }
            }
            hits.sort { $0.0 > $1.0 }
            return hits.isEmpty ? "Keine Treffer." : hits.prefix(40).map { "- " + $0.1 }.joined(separator: "\n")
        case "read_activity":
            guard let hit = jInt(input["module_id"]).flatMap({ c.findModule($0) }) else { throw OAuthError(message: "Aktivität nicht gefunden") }
            let m = hit.module
            var out = ["\(modLabel[m.modname] ?? m.modname): \(m.name)"]
            if !m.dates.isEmpty { out.append(m.dates.map { "\($0.label) \(fmtDate($0.timestamp))" }.joined(separator: " · ")) }
            let a = c.assignments[m.id]
            if let a {
                out.append("Fällig: \(fmtDate(a.duedate))\(a.cutoffdate > 0 ? " · Letzte Abgabemöglichkeit: \(fmtDate(a.cutoffdate))" : "")")
                out.append(stripHtml(a.intro))
                let att = app.files(of: m)
                if !att.isEmpty { out.append("Anhänge: " + att.map { "\($0.filename) (file_id: \($0.id))" }.joined(separator: ", ")) }
            }
            let p = c.pages[m.id]
            if let p { out.append(stripHtml(p.content)) }
            let fo = c.forums[m.id]
            // Ohne Verfassernamen: personenbezogene Daten anderer bleiben lokal
            if let fo { for d in fo.discussions { out.append("\n### \(d.subject)\n\(fmtDate(d.created))\n\(stripHtml(d.message))") } }
            if a == nil && p == nil && fo == nil { out.append(stripHtml(m.description).nonEmpty ?? "(Keine Beschreibung. Diese Aktivität ist nur online in Moodle verfügbar.)") }
            if let u = m.url { out.append("Online: \(u)") }
            return out.filter { !$0.isEmpty }.joined(separator: "\n")
        case "get_deadlines":
            let until = Int(Date().timeIntervalSince1970) + (jInt(input["days"]) ?? 30) * 86400
            let list = c.events.filter { $0.timesort <= until }
            if list.isEmpty { return "Keine anstehenden Termine in diesem Zeitraum." }
            return list.map { e in
                "- \(fmtDate(e.timesort)): \(e.title) (\(e.coursename))\(e.overdue ? " – ÜBERFÄLLIG" : "")\(e.cmid.map { " (module_id: \($0))" } ?? "")"
            }.joined(separator: "\n")
        default:
            throw OAuthError(message: "Unbekanntes Werkzeug")
        }
    }

    // Nur Zeit, Titel und Raum – Beschreibung und Dozierenden-Kürzel gehen nicht an den KI-Anbieter
    private func timetableText(_ input: [String: Any]) -> String {
        let tt = app.timetables
        guard let plan = tt.active else { return "Es ist kein Stundenplan eingetragen (Reiter „Stundenplan“)." }
        let cal = Calendar.current
        let isoF = DateFormatter()
        isoF.dateFormat = "yyyy-MM-dd"
        let start = (input["from_date"] as? String).flatMap { isoF.date(from: $0) } ?? cal.startOfDay(for: Date())
        let days = max(1, min(21, jInt(input["days"]) ?? 7))
        let end = cal.date(byAdding: .day, value: days, to: start)!
        let events = tt.events(plan.id, from: start, to: end)
        let dayF = DateFormatter()
        dayF.locale = deLocale
        dayF.dateFormat = "EE, dd.MM.yyyy"
        let clock = DateFormatter()
        clock.dateFormat = "HH:mm"
        let fetched = tt.caches[plan.id]?.fetchedAt
        var out = ["Stundenplan „\(plan.name)“ (Stand \(fetched.map { fmtDate(Int($0.timeIntervalSince1970)) } ?? "unbekannt"))"]
        for i in 0..<days {
            let d = cal.date(byAdding: .day, value: i, to: start)!
            let next = cal.date(byAdding: .day, value: 1, to: d)!
            let list = events.filter { cal.isDate($0.start, inSameDayAs: d) || ($0.allDay && $0.start <= d && $0.end > d) }
            out.append("\n\(dayF.string(from: d)):")
            if list.isEmpty { out.append("- keine Termine") }
            for e in list where e.start < next {
                let title = e.title.replacingOccurrences(of: "\\s*\\([A-ZÄÖÜ][A-Za-zÄÖÜäöü]{1,3}\\)\\s*$", with: "", options: .regularExpression)
                out.append("- \(e.allDay ? "ganztägig" : "\(clock.string(from: e.start))–\(clock.string(from: e.end))") \(title)\(e.location.isEmpty ? "" : " (\(e.location))")")
            }
        }
        return out.joined(separator: "\n")
    }

    private func mensaText(_ input: [String: Any]) async -> String {
        guard let plan = await app.mensa.get() else { return "Der Speiseplan konnte nicht geladen werden." }
        let only = input["date"] as? String
        let days = plan.days.filter { only == nil || $0.date == only }
        var out = ["\(plan.name) – Speiseplan (Stand \(fmtDate(Int(plan.fetchedAt.timeIntervalSince1970)))\(plan.error.map { ", Aktualisierung fehlgeschlagen: \($0)" } ?? ""))."]
        if days.isEmpty { return (out + [only != nil ? "Für \(only!) ist kein Speiseplan veröffentlicht." : "Es ist noch kein Speiseplan veröffentlicht."]).joined(separator: "\n") }
        for d in days {
            out.append("\n## \(d.label)\(d.rel.isEmpty ? "" : " (\(d.rel))")")
            for e in d.dishes {
                let dietTags = e.tags.filter(\.diet).map(\.text)
                let allergens = e.tags.filter { !$0.diet }.map(\.text)
                out.append("- \(e.category.isEmpty ? "" : e.category + ": ")\(e.title)\(e.description.isEmpty ? "" : " – \(e.description)")"
                    + (dietTags.isEmpty ? "" : " · \(dietTags.joined(separator: ", "))")
                    + (allergens.isEmpty ? "" : " · Allergene/Zusätze: \(allergens.joined(separator: ", "))")
                    + " · DHBW \(fmtEuro(e.dhbw)) (intern \(fmtEuro(e.intern)), extern \(fmtEuro(e.extern)))")
            }
        }
        return out.joined(separator: "\n")
    }
}

extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
