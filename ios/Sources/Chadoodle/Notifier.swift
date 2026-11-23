// Mitteilungen auf dem iPhone: neue Noten (Dualis), neue Kursdateien und Erinnerungen an Fristen.
// Chadoodle hat keinen eigenen Push-Server (der bekäme sonst Dualis-Kennwort bzw. Moodle-Token):
// stattdessen weckt iOS die App regelmäßig im Hintergrund (Background App Refresh), sie prüft Dualis
// und Moodle selbst und zeigt bei Neuem eine lokale Mitteilung. Fristen-Erinnerungen werden fest
// eingeplant und kommen auch ohne Weckruf pünktlich.
import BackgroundTasks
import SwiftUI
import UIKit
import UserNotifications

let backgroundRefreshId = "de.rbenz.chadoodle.refresh"

@MainActor
final class Notifier: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()
    // Tippen auf eine Mitteilung öffnet den passenden Reiter
    @Published var openTab: TabRouter.Tab?
    @Published private(set) var authorized: Bool?

    @AppStorage("notifyGrades") var notifyGrades = true
    @AppStorage("notifyFiles") var notifyFiles = true
    @AppStorage("notifyDeadlines") var notifyDeadlines = true

    private let center = UNUserNotificationCenter.current()

    override init() {
        super.init()
        center.delegate = self
    }

    func requestPermission() async {
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        authorized = granted
    }

    func refreshAuthorization() async {
        let s = await center.notificationSettings()
        authorized = s.authorizationStatus == .authorized || s.authorizationStatus == .provisional
    }

    private func post(id: String, title: String, body: String, tab: TabRouter.Tab, important: Bool = false) {
        let c = UNMutableNotificationContent()
        c.title = title
        c.body = body
        c.sound = .default
        c.userInfo = ["tab": tab.rawValue]
        if important { c.interruptionLevel = .timeSensitive }
        center.add(UNNotificationRequest(identifier: id, content: c, trigger: nil))
    }

    // ---------- Neue Noten ----------
    func newGrades(_ mods: [DualisModule]) {
        guard notifyGrades, !mods.isEmpty else { return }
        let fmt = { (n: Double) in String(n).replacingOccurrences(of: ".", with: ",").replacingOccurrences(of: ",0$", with: "", options: .regularExpression) }
        if mods.count == 1, let m = mods.first {
            let line = [m.grade.map { "Note \($0)" }, m.credits.map { "\(fmt($0)) Credits" }, m.status.isEmpty ? nil : m.status].compactMap { $0 }.joined(separator: " · ")
            post(id: "grade-\(m.no)", title: "🎓 Neue Note: \(m.name)", body: line, tab: .grades, important: true)
        } else {
            let list = mods.map { "\($0.name): \($0.grade ?? "–")" }
            post(id: "grades-\(Int(Date().timeIntervalSince1970))", title: "🎓 \(mods.count) neue Noten in Dualis",
                 body: list.prefix(3).joined(separator: " · ") + (list.count > 3 ? " · und \(list.count - 3) weitere" : ""), tab: .grades, important: true)
        }
    }

    func dualisAuthFailed() {
        post(id: "dualis-auth", title: "Dualis-Anmeldung abgelaufen", body: "Das gespeicherte Kennwort wurde abgelehnt. Bitte unter „Noten“ neu anmelden.", tab: .grades)
    }

    // ---------- Neue Dateien (nur wenn die App nicht offen ist – sonst sieht man sie ohnehin) ----------
    func newFiles(_ files: [LocalFile], courses: [Course]) {
        guard notifyFiles, !files.isEmpty, UIApplication.shared.applicationState != .active else { return }
        let names = Set(files.compactMap { f in courses.first { $0.id == f.courseId }?.title })
        if files.count == 1, let f = files.first {
            post(id: "file-\(f.id)", title: "Neue Datei in \(names.first ?? "Moodle")", body: f.filename, tab: .home)
        } else {
            post(id: "files-\(Int(Date().timeIntervalSince1970))", title: "\(files.count) neue Dateien in Moodle", body: names.sorted().prefix(3).joined(separator: ", "), tab: .home)
        }
    }

    // ---------- Fristen: Erinnerung einen Tag und zwei Stunden vorher ----------
    func scheduleDeadlines(_ events: [CalEvent]) async {
        let pending = await center.pendingNotificationRequests()
        center.removePendingNotificationRequests(withIdentifiers: pending.map(\.identifier).filter { $0.hasPrefix("due-") })
        guard notifyDeadlines else { return }
        let now = Date()
        var count = 0
        for e in events.sorted(by: { $0.timesort < $1.timesort }) {
            let due = Date(timeIntervalSince1970: TimeInterval(e.timesort))
            guard due > now, due < now.addingTimeInterval(21 * 86400) else { continue }
            for (label, before) in [("morgen", 86400.0), ("in 2 Stunden", 7200.0)] {
                let at = due.addingTimeInterval(-before)
                guard at > now, count < 50 else { continue }
                let c = UNMutableNotificationContent()
                c.title = "Fällig \(label): \(e.title)"
                c.body = "\(e.coursename) · bis \(due.formatted(date: .omitted, time: .shortened)) Uhr"
                c.sound = .default
                c.userInfo = ["tab": TabRouter.Tab.home.rawValue]
                let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: at)
                try? await center.add(UNNotificationRequest(identifier: "due-\(e.id)-\(Int(before))", content: c, trigger: UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)))
                count += 1
            }
        }
    }

    // ---------- Hintergrund ----------
    // Nächsten Weckruf anmelden (iOS entscheidet selbst, wann genau – meist alle 30–60 Minuten)
    nonisolated static func scheduleBackgroundRefresh() {
        let r = BGAppRefreshTaskRequest(identifier: backgroundRefreshId)
        r.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
        try? BGTaskScheduler.shared.submit(r)
    }

    // ---------- UNUserNotificationCenterDelegate ----------
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let raw = response.notification.request.content.userInfo["tab"] as? String
        await MainActor.run { self.openTab = raw.flatMap(TabRouter.Tab.init(rawValue:)) }
    }
}
