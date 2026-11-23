// Verschiebevorschläge im Stundenplan wie auf dem Desktop (src/renderer/tt-proposal.js): Stunden auf einen
// anderen Tag, eine andere Woche oder eine andere Uhrzeit legen – nie in die Vergangenheit. Der Plan selbst
// bleibt unverändert; die Vorschläge bleiben auf dem Gerät und gehen als fertige Mail an den Kurssprecher.
import MessageUI
import SwiftUI

struct TTMove: Codable, Hashable, Identifiable {
    var id: String
    var title: String
    var location: String
    var persons: [String]
    var start: Date
    var end: Date
    var newStart: Date
    var newEnd: Date

    // Ersatztermin an der neuen Stelle (für Wochen, in denen die Stunde ursprünglich nicht liegt)
    var asEvent: TTEvent { TTEvent(id: id, title: title, location: location, persons: persons, start: start, end: end, allDay: false) }
}

extension Timetables {
    private static let movesKey = "ttMoves"

    private var allMoves: [String: [String: TTMove]] {
        get { UserDefaults.standard.data(forKey: Self.movesKey).flatMap { try? JSONDecoder().decode([String: [String: TTMove]].self, from: $0) } ?? [:] }
        set {
            objectWillChange.send()
            UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: Self.movesKey)
        }
    }

    func moves(_ planId: String? = nil) -> [String: TTMove] { allMoves[planId ?? active?.id ?? ""] ?? [:] }

    func move(_ e: TTEvent, to start: Date) {
        guard let plan = active?.id else { return }
        var all = allMoves
        var map = all[plan] ?? [:]
        let end = start.addingTimeInterval(e.end.timeIntervalSince(e.start))
        if abs(start.timeIntervalSince(e.start)) < 1 { map[e.id] = nil }
        else { map[e.id] = TTMove(id: e.id, title: e.title, location: e.location, persons: e.persons, start: e.start, end: e.end, newStart: start, newEnd: end) }
        all[plan] = map.isEmpty ? nil : map
        allMoves = all
    }

    func undoMove(_ id: String) {
        guard let plan = active?.id else { return }
        var all = allMoves
        all[plan]?[id] = nil
        if all[plan]?.isEmpty == true { all[plan] = nil }
        allMoves = all
    }

    func resetMoves() {
        guard let plan = active?.id else { return }
        var all = allMoves
        all[plan] = nil
        allMoves = all
    }
}

// ---------- Mailtext (gleich wie TTP.mailText) ----------
private let wd = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"]
func ttSpan(_ start: Date, _ end: Date) -> String {
    let c = Calendar.current
    let d = c.dateComponents([.weekday, .day, .month], from: start)
    let f = { (x: Date) in x.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).locale(deLocale)) }
    return String(format: "%@, %02d.%02d., %@–%@", wd[(d.weekday ?? 1) - 1], d.day ?? 0, d.month ?? 0, f(start), f(end))
}

func ttProposalSubject(plan: String, moves: [TTMove]) -> String {
    var cal = Calendar(identifier: .iso8601)
    cal.locale = deLocale
    let weeks = Array(Set(moves.map { cal.component(.weekOfYear, from: $0.start) })).sorted()
    return "Verschiebevorschlag Stundenplan \(plan)" + (weeks.isEmpty ? "" : " (KW \(weeks.map(String.init).joined(separator: ", ")))")
}

func ttProposalText(plan: String, moves: [TTMove], note: String, sender: String) -> String {
    let list = moves.sorted { $0.start < $1.start }
    var lines = ["Hallo,", "", "ich schlage \(list.count == 1 ? "folgende Verschiebung" : "folgende Verschiebungen") im Stundenplan \(plan) vor:", ""]
    for m in list {
        lines.append("• \(m.title)\(m.location.isEmpty ? "" : " (\(m.location))")")
        lines.append("  bisher: \(ttSpan(m.start, m.end))")
        lines.append("  neu:    \(ttSpan(m.newStart, m.newEnd))")
        lines.append("")
    }
    let n = note.trimmingCharacters(in: .whitespacesAndNewlines)
    if !n.isEmpty { lines += ["Bemerkung:", n, ""] }
    lines.append("Viele Grüße")
    if !sender.isEmpty { lines.append(sender) }
    return lines.joined(separator: "\n")
}

// ---------- Vorschlag senden ----------
struct ProposalSheet: View {
    @EnvironmentObject private var tt: Timetables
    @EnvironmentObject private var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @AppStorage("ttProposalTo") private var to = ""
    @State private var note = ""
    @State private var showMail = false

    private var moves: [TTMove] { tt.moves().values.sorted { $0.start < $1.start } }
    private var planName: String { tt.active?.name ?? "Stundenplan" }
    private var validTo: Bool { to.range(of: "^[^\\s@<>()\",;:?&]+@[^\\s@<>()\",;:?&]+\\.[^\\s@<>()\",;:?&]+$", options: .regularExpression) != nil }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("kurssprecher@…", text: $to).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: { Text("An (Kurssprecher)") }
                Section("Verschiebungen") {
                    ForEach(moves) { m in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(cleanLectureTitle(m.title)).font(.subheadline.weight(.semibold))
                            Text("bisher \(ttSpan(m.start, m.end))").font(.caption).foregroundStyle(.secondary).strikethrough()
                            Text("neu \(ttSpan(m.newStart, m.newEnd))").font(.caption.weight(.semibold))
                        }
                        .swipeActions { Button("Zurücknehmen", role: .destructive) { tt.undoMove(m.id) } }
                    }
                }
                Section {
                    TextField("z. B. warum der neue Termin besser passt", text: $note, axis: .vertical).lineLimit(3...6)
                } header: { Text("Bemerkung (optional)") } footer: {
                    Text("Deine Mail-App öffnet sich mit einer fertigen Mail – du musst sie nur noch abschicken.")
                }
            }
            .navigationTitle("Vorschlag senden")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Mail öffnen") { send() }.disabled(!validTo || moves.isEmpty)
                }
            }
            .sheet(isPresented: $showMail) {
                MailView(to: to.trimmingCharacters(in: .whitespaces), subject: ttProposalSubject(plan: planName, moves: moves),
                         body: ttProposalText(plan: planName, moves: moves, note: note, sender: app.cache.site?.fullname ?? "")) { sent in
                    showMail = false
                    if sent { dismiss() }
                }
                .ignoresSafeArea()
            }
        }
    }

    private func send() {
        let subject = ttProposalSubject(plan: planName, moves: moves)
        let body = ttProposalText(plan: planName, moves: moves, note: note, sender: app.cache.site?.fullname ?? "")
        if MFMailComposeViewController.canSendMail() { showMail = true; return }
        var c = URLComponents()
        c.scheme = "mailto"
        c.path = to.trimmingCharacters(in: .whitespaces)
        c.queryItems = [URLQueryItem(name: "subject", value: subject), URLQueryItem(name: "body", value: body)]
        if let u = c.url { openURL(u) }
    }
}

struct MailView: UIViewControllerRepresentable {
    let to: String
    let subject: String
    let body: String
    let done: (Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(done: done) }

    func makeUIViewController(context: Context) -> MFMailComposeViewController {
        let vc = MFMailComposeViewController()
        vc.mailComposeDelegate = context.coordinator
        vc.setToRecipients([to])
        vc.setSubject(subject)
        vc.setMessageBody(body, isHTML: false)
        return vc
    }

    func updateUIViewController(_ vc: MFMailComposeViewController, context: Context) {}

    final class Coordinator: NSObject, MFMailComposeViewControllerDelegate {
        let done: (Bool) -> Void
        init(done: @escaping (Bool) -> Void) { self.done = done }
        func mailComposeController(_ controller: MFMailComposeViewController, didFinishWith result: MFMailComposeResult, error: Error?) {
            done(result == .sent)
        }
    }
}
