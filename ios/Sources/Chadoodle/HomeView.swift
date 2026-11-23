// Übersicht wie auf Desktop und Website: Begrüßungsbanner mit der laufenden Vorlesung, Kurse als
// einfarbige Karten in drei Abstufungen, heutige Vorlesungen, Fristen und neue Dateien – flache weiße
// Karten auf hellgrauem Grund, nur die drei App-Farben.
import SwiftUI

enum Route: Hashable {
    case course(Int)
    case module(Int)
    case doc(String, Int?)
    case settings
}

extension View {
    func withRoutes() -> some View {
        navigationDestination(for: Route.self) { r in
            switch r {
            case .course(let id): CourseDetailView(courseId: id)
            case .module(let id): ModuleDetailView(moduleId: id)
            case .doc(let id, let page): DocumentView(fileId: id, page: page)
            case .settings: SettingsView()
            }
        }
    }
}

// Gemeinsamer Tab-Wechsel (z. B. Karte auf der Startseite → Stundenplan) und der Assistent als Blatt
final class TabRouter: ObservableObject {
    enum Tab: String, Hashable { case home, courses, timetable, grades, mensa }
    @Published var tab: Tab = .home
    @Published var assistant = false
}

struct HomeView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var timetables: Timetables
    @EnvironmentObject private var mensa: MensaStore
    @EnvironmentObject private var dualis: DualisStore
    @EnvironmentObject private var router: TabRouter

    private var upcoming: [CalEvent] {
        let now = Int(Date().timeIntervalSince1970)
        return app.cache.events.filter { $0.timesort >= now - 86400 }.sorted { $0.timesort < $1.timesort }.prefix(5).map { $0 }
    }

    private var today: [TTEvent] {
        let cal = Calendar.current
        let start = cal.startOfDay(for: Date())
        return timetables.events(timetables.active?.id, from: start, to: cal.date(byAdding: .day, value: 1, to: start)!)
            .filter { !$0.allDay && $0.start >= start }
            .sorted { $0.start < $1.start }
    }

    private var recentCourses: [Course] {
        app.cache.courses.filter { !$0.hidden }.sorted { ($0.lastaccess ?? 0) > ($1.lastaccess ?? 0) }.prefix(6).map { $0 }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    HeroBanner(events: today, greeting: greeting, summary: summary)

                    if !recentCourses.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            SectionHeader("Deine Kurse", action: "Alle ansehen") { router.tab = .courses }
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 12) {
                                    ForEach(Array(recentCourses.enumerated()), id: \.element.id) { i, k in
                                        NavigationLink(value: Route.course(k.id)) { CourseTile(course: k, index: i).frame(width: 220) }
                                            .buttonStyle(.plain)
                                    }
                                }
                                .padding(.horizontal, 2)
                            }
                        }
                    }

                    if timetables.active != nil {
                        VStack(alignment: .leading, spacing: 12) {
                            SectionHeader("Heute", action: "Woche") { router.tab = .timetable }
                            VStack(spacing: 2) {
                                if today.isEmpty {
                                    Label("Heute keine Vorlesungen", systemImage: "checkmark.circle")
                                        .font(.subheadline).foregroundStyle(Color.inkSecondary)
                                        .frame(maxWidth: .infinity, alignment: .leading).padding(14)
                                }
                                ForEach(today) { e in
                                    let k = courseFor(e.title, in: app.cache.courses)
                                    Group {
                                        if let k {
                                            NavigationLink(value: Route.course(k.id)) { ReminderRow(event: e, course: k) }
                                        } else {
                                            Button { router.tab = .timetable } label: { ReminderRow(event: e, course: nil) }
                                        }
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(6)
                            .card()
                        }
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        SectionHeader("Fristen")
                        VStack(spacing: 0) {
                            if upcoming.isEmpty {
                                Label("Nichts fällig – gut gemacht!", systemImage: "checkmark.circle")
                                    .font(.subheadline).foregroundStyle(Color.inkSecondary)
                                    .frame(maxWidth: .infinity, alignment: .leading).padding(14)
                            }
                            ForEach(Array(upcoming.enumerated()), id: \.element.id) { i, e in
                                NavigationLink(value: e.cmid.map { Route.module($0) } ?? Route.course(e.courseid ?? 0)) {
                                    DeadlineRow(event: e).padding(.horizontal, 14).padding(.vertical, 11).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                if i < upcoming.count - 1 { Divider().padding(.leading, 14) }
                            }
                        }
                        .card()
                    }

                    let news = app.cache.newItems.prefix(6).compactMap { app.cache.files[$0.fileId] }
                    if !news.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            SectionHeader("Neu synchronisiert", action: "Gelesen") { withAnimation { app.clearNews() } }
                            VStack(spacing: 0) {
                                ForEach(Array(news.enumerated()), id: \.element.id) { i, f in
                                    NavigationLink(value: Route.doc(f.id, nil)) {
                                        HStack {
                                            FileRow(file: f, showCourse: true)
                                            Spacer()
                                            Image(systemName: "chevron.right").font(.caption.bold()).foregroundStyle(Color.pMid)
                                        }
                                        .padding(.horizontal, 14).padding(.vertical, 10)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    if i < news.count - 1 { Divider().padding(.leading, 54) }
                                }
                            }
                            .card()
                        }
                    }

                    if let d = mensa.plan?.days.first(where: { $0.date == isoDay(Date()) }), !d.dishes.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            SectionHeader("Heute in der Mensa", action: "Speiseplan") { router.tab = .mensa }
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 12) {
                                    ForEach(d.dishes.filter { $0.dhbw != nil || $0.intern != nil }.prefix(6)) { e in
                                        DishCard(dish: e).onTapGesture { router.tab = .mensa }
                                    }
                                }
                                .padding(.horizontal, 2)
                            }
                        }
                    }

                    SyncStatusRow().padding(14).card()
                }
                .padding(.horizontal)
                .padding(.bottom, 24)
            }
            .appBackground()
            .navigationTitle(Date().formatted(.dateTime.weekday(.wide).day().month(.wide).locale(deLocale)))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { AssistantButton() }
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink(value: Route.settings) { ProfileBadge(name: app.cache.site?.fullname ?? "") }
                }
            }
            .refreshable { await app.sync() }
            .withRoutes()
        }
    }

    private var greeting: String {
        let h = Calendar.current.component(.hour, from: Date())
        let name = app.cache.site?.firstname ?? ""
        let g = h < 11 ? "Guten Morgen" : h < 18 ? "Willkommen zurück" : "Guten Abend"
        return name.isEmpty ? g : "\(g), \(name)!"
    }

    private var summary: String {
        let now = Int(Date().timeIntervalSince1970)
        let soon = app.cache.events.filter { $0.timesort > now && $0.timesort <= now + 2 * 86400 }.count
        let week = app.cache.events.filter { $0.timesort > now && $0.timesort <= now + 7 * 86400 }.count
        var parts = [soon > 0 ? "\(soon) \(soon == 1 ? "Frist" : "Fristen") in den nächsten 2 Tagen" : week > 0 ? "\(week) \(week == 1 ? "Frist" : "Fristen") diese Woche" : "Diese Woche keine Fristen"]
        if let d = dualis.data, let g = fmtGrade(gpaExact(d).total) ?? d.gpa.total { parts.append("Notenschnitt \(g)") }
        return parts.joined(separator: " · ")
    }
}

// Kreis mit Initialen (führt zu den Einstellungen)
struct ProfileBadge: View {
    let name: String

    var body: some View {
        Text(String(name.split(separator: " ").prefix(2).compactMap(\.first)).uppercased())
            .font(.caption.bold())
            .frame(width: 32, height: 32)
            .background(Color.pMid, in: Circle())
            .foregroundStyle(.white)
    }
}

// Banner mit Verlauf in den App-Farben, darin die laufende bzw. nächste Vorlesung
struct HeroBanner: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var router: TabRouter
    let events: [TTEvent]
    let greeting: String
    let summary: String

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { ctx in
            let n = lectureNow(events, at: ctx.date)
            VStack(alignment: .leading, spacing: 6) {
                Text(greeting).font(.title3.bold()).foregroundStyle(Color.pLight)
                Text(summary).font(.subheadline).foregroundStyle(Color.pLight.opacity(0.8))
                if let e = n.running ?? n.next {
                    NowStrip(event: e, running: n.running != nil, course: courseFor(e.title, in: app.cache.courses), now: ctx.date)
                        .padding(.top, 10)
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(alignment: .bottomTrailing) {
                Image(systemName: "books.vertical.fill")
                    .font(.system(size: 92))
                    .foregroundStyle(Color.pLight.opacity(0.12))
                    .offset(x: 6, y: 16)
            }
            .background(LinearGradient(colors: [.pDark, Color.pDark.opacity(0.85), .pMid], startPoint: .topLeading, endPoint: .bottomTrailing),
                        in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
    }
}

struct NowStrip: View {
    let event: TTEvent
    let running: Bool
    let course: Course?
    let now: Date

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if running { Circle().fill(Color.pLight).frame(width: 7, height: 7) }
                    Text(running ? "Jetzt im Unterricht" : "Als Nächstes · \(event.start.formatted(date: .omitted, time: .shortened)) Uhr")
                }
                .font(.caption.weight(.semibold)).foregroundStyle(Color.pLight.opacity(0.8))
                Text(cleanLectureTitle(event.title)).font(.headline).foregroundStyle(Color.pLight).lineLimit(1)
                Text([running ? "noch \(Int(ceil(event.end.timeIntervalSince(now) / 60))) min" : "\(event.start.formatted(date: .omitted, time: .shortened))–\(event.end.formatted(date: .omitted, time: .shortened))",
                      event.location].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption.monospacedDigit()).foregroundStyle(Color.pLight.opacity(0.8)).lineLimit(1)
                if let p = event.elapsed(at: now) {
                    ProgressView(value: p).tint(Color.pLight).padding(.top, 4)
                }
            }
            Spacer(minLength: 0)
            if let course {
                NavigationLink(value: Route.course(course.id)) {
                    Text("Zum Kurs").font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .background(Color.pLight.opacity(0.22), in: RoundedRectangle(cornerRadius: 12))
                        .foregroundStyle(Color.pLight)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(12)
        .background(Color.pLight.opacity(0.13), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

// Kurs als einfarbige Karte (drei Abstufungen der Palette)
struct CourseTile: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var timetables: Timetables
    let course: Course
    let index: Int
    var badge: String?

    var body: some View {
        let files = app.cache.files.values.filter { $0.courseId == course.id }.count
        let who = teacher
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                Text(course.categoryname ?? course.shortname).font(.caption2.weight(.semibold)).opacity(0.75).lineLimit(1)
                Spacer(minLength: 4)
                if let badge { Pill(text: badge, filled: false).environment(\.colorScheme, .light) }
            }
            Text(course.fullname).font(.subheadline.bold()).lineLimit(2, reservesSpace: true)
            Spacer(minLength: 6)
            Label("\(files) \(files == 1 ? "Datei" : "Dateien")", systemImage: "folder").font(.caption.weight(.medium))
            if let who { Label(who, systemImage: "person").font(.caption.weight(.medium)).lineLimit(1) }
            else if let p = course.progress { Label("\(Int(p)) % erledigt", systemImage: "checkmark.circle").font(.caption.weight(.medium)) }
        }
        .foregroundStyle(Color.pLight)
        .padding(16)
        .frame(maxWidth: .infinity, minHeight: 140, alignment: .topLeading)
        .background([Color.shade0, .shade1, .shade2][index % 3], in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    // Dozent aus dem Stundenplan (erste passende Vorlesung der nächsten Wochen)
    private var teacher: String? {
        let now = Date()
        let ev = timetables.events(timetables.active?.id, from: now.addingTimeInterval(-7 * 86400), to: now.addingTimeInterval(14 * 86400))
            .first { !$0.persons.isEmpty && courseFor($0.title, in: app.cache.courses)?.id == course.id }
        return ev?.persons.joined(separator: ", ")
    }
}

// Vorlesung als Erinnerungszeile (Symbol in heller Kachel, Titel, Zeit)
struct ReminderRow: View {
    let event: TTEvent
    let course: Course?

    var body: some View {
        TimelineView(.everyMinute) { ctx in
            let now = ctx.date
            let done = event.end <= now
            let live = event.start <= now && event.end > now
            HStack(spacing: 12) {
                Image(systemName: done ? "checkmark" : live ? "bell.fill" : "clock")
                    .font(.subheadline.weight(.semibold))
                    .frame(width: 38, height: 38)
                    .background(live ? Color.ink : Color.appBackground, in: RoundedRectangle(cornerRadius: 11))
                    .foregroundStyle(live ? Color.onInk : Color.inkSecondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(cleanLectureTitle(event.title)).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text(["\(event.start.formatted(date: .omitted, time: .shortened))–\(event.end.formatted(date: .omitted, time: .shortened))", event.location, live ? "jetzt" : ""].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.caption.monospacedDigit()).foregroundStyle(Color.inkSecondary).lineLimit(1)
                }
                Spacer()
                if course != nil { Image(systemName: "chevron.right").font(.caption.bold()).foregroundStyle(Color.pMid) }
            }
            .padding(8)
            .opacity(done ? 0.5 : 1)
            .contentShape(Rectangle())
        }
    }
}

struct DishCard: View {
    let dish: Dish

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack {
                Color.softFill
                if let t = dish.image ?? dish.thumb, let u = URL(string: t) {
                    AsyncImage(url: u) { img in img.resizable().scaledToFill() } placeholder: { Image(systemName: "fork.knife").foregroundStyle(Color.pMid) }
                } else {
                    Image(systemName: "fork.knife").font(.title2).foregroundStyle(Color.pMid)
                }
            }
            .frame(width: 170, height: 104)
            .clipped()
            VStack(alignment: .leading, spacing: 3) {
                Text(dish.category.uppercased()).font(.caption2.bold()).foregroundStyle(Color.inkSecondary).lineLimit(1)
                Text(dish.title).font(.subheadline.weight(.semibold)).lineLimit(2, reservesSpace: true)
                Text(fmtEuro(dish.dhbw ?? dish.intern)).font(.caption.weight(.semibold).monospacedDigit()).foregroundStyle(Color.ink)
            }
            .padding(10)
        }
        .frame(width: 170)
        .card()
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

struct SyncStatusRow: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var index: DocIndex

    var body: some View {
        HStack(spacing: 12) {
            Group {
                switch app.status.state {
                case .syncing, .downloading: ProgressView()
                case .error: Image(systemName: "exclamationmark.icloud.fill").foregroundStyle(Color.ink)
                case .idle: Image(systemName: "checkmark.icloud.fill").foregroundStyle(Color.pMid)
                }
            }
            .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(subtitle).font(.caption).foregroundStyle(Color.inkSecondary).lineLimit(1)
            }
            Spacer()
            Button {
                Task { await app.sync() }
            } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.borderless)
                .disabled(app.status.state == .syncing || app.status.state == .downloading)
        }
    }

    private var title: String {
        switch app.status.state {
        case .syncing: return app.status.total > 0 ? "Synchronisiere \(app.status.done)/\(app.status.total)" : "Synchronisiere…"
        case .downloading: return "Dateien \(app.status.done)/\(app.status.total)"
        case .error: return app.status.message
        case .idle:
            return app.cache.lastSync > 0 ? "Synchronisiert \(relTime(Date(timeIntervalSince1970: app.cache.lastSync / 1000)))" : "Noch nicht synchronisiert"
        }
    }

    private var subtitle: String {
        if app.status.state != .idle && app.status.state != .error { return app.status.message }
        let files = app.cache.files.values
        let p = index.progress(app.cache.files)
        var s = "\(app.cache.courses.count) Kurse · \(files.filter(\.downloaded).count)/\(files.count) Dateien lokal"
        if p.total > 0 { s += " · \(p.indexed)/\(p.total) durchsuchbar" }
        if let r = index.running { s = "Indexiere \(r)" }
        return s
    }
}

struct DeadlineRow: View {
    let event: CalEvent

    var body: some View {
        let date = Date(timeIntervalSince1970: TimeInterval(event.timesort))
        let urgent = event.overdue || date.timeIntervalSinceNow < 2 * 86400
        HStack(spacing: 12) {
            VStack(spacing: 0) {
                Text(date.formatted(.dateTime.day())).font(.headline)
                Text(date.formatted(.dateTime.month(.abbreviated).locale(deLocale))).font(.caption2).textCase(.uppercase)
            }
            .frame(width: 44, height: 44)
            .background(urgent ? Color.ink : Color.appBackground, in: RoundedRectangle(cornerRadius: 11))
            .foregroundStyle(urgent ? Color.onInk : Color.ink)
            VStack(alignment: .leading, spacing: 2) {
                Text(event.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                Text("\(event.coursename) · \(date.formatted(.dateTime.weekday(.abbreviated).hour().minute().locale(deLocale)))")
                    .font(.caption).foregroundStyle(Color.inkSecondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            HStack(spacing: 5) {
                RoundedRectangle(cornerRadius: 2).fill(urgent ? Color.ink : Color.pMid).frame(width: 8, height: 8)
                Text(event.overdue ? "Überfällig" : urgent ? "Bald" : "Offen").font(.caption.weight(urgent ? .bold : .regular))
            }
            .foregroundStyle(urgent ? Color.ink : Color.inkSecondary)
        }
    }
}

struct FileRow: View {
    @EnvironmentObject private var app: AppModel
    let file: LocalFile
    var showCourse = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: fileIcon(file.ext))
                .font(.subheadline)
                .frame(width: 32, height: 32)
                .background(Color.appBackground, in: RoundedRectangle(cornerRadius: 9))
                .foregroundStyle(Color.ink)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.filename).font(.subheadline).lineLimit(2)
                HStack(spacing: 4) {
                    if showCourse, let k = app.cache.course(file.courseId) { Text(k.title + " ·") }
                    Text(fmtSize(file.filesize))
                    if file.downloaded { Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.pMid) }
                    else if file.error != nil { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Color.ink) }
                    else { Image(systemName: "icloud").foregroundStyle(Color.pMid) }
                }
                .font(.caption).foregroundStyle(Color.inkSecondary)
            }
        }
    }
}

// Moodle-HTML (Textseiten, Aufgabenstellungen, Forenbeiträge) als nativer Text
struct HTMLText: View {
    let html: String
    @State private var text: AttributedString?

    var body: some View {
        Group {
            if let text { Text(text).textSelection(.enabled) } else { Text(stripHtml(html)) }
        }
        .task(id: html) { text = render(html) }
    }

    private func render(_ html: String) -> AttributedString? {
        let cleaned = html.replacingOccurrences(of: "<img[^>]*>", with: "", options: [.regularExpression, .caseInsensitive])
        let doc = "<meta charset=\"utf-8\"><style>body{font-family:-apple-system;font-size:16px}</style>" + cleaned
        guard let ns = try? NSMutableAttributedString(data: Data(doc.utf8), options: [.documentType: NSAttributedString.DocumentType.html,
                                                                                    .characterEncoding: String.Encoding.utf8.rawValue], documentAttributes: nil) else { return nil }
        // Dunkelmodus: Textfarbe aus dem System statt Schwarz aus dem HTML
        ns.removeAttribute(.foregroundColor, range: NSRange(location: 0, length: ns.length))
        ns.removeAttribute(.backgroundColor, range: NSRange(location: 0, length: ns.length))
        while ns.string.hasSuffix("\n") { ns.deleteCharacters(in: NSRange(location: ns.length - 1, length: 1)) }
        return try? AttributedString(ns, including: \.uiKit)
    }
}
