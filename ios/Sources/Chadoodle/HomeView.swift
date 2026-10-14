// Start: aktuelle Vorlesung, Mensa heute, anstehende Abgaben, neue Dateien und der Sync-Status – als Karten wie in den Apple-Apps.
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

// Gemeinsamer Tab-Wechsel (z. B. Karte auf der Startseite → Stundenplan)
final class TabRouter: ObservableObject {
    enum Tab: Hashable { case home, courses, timetable, mensa, assistant }
    @Published var tab: Tab = .home
}

struct HomeView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var timetables: Timetables
    @EnvironmentObject private var mensa: MensaStore
    @EnvironmentObject private var router: TabRouter

    private var upcoming: [CalEvent] {
        let now = Int(Date().timeIntervalSince1970)
        return app.cache.events.filter { $0.timesort >= now - 86400 }.sorted { $0.timesort < $1.timesort }.prefix(6).map { $0 }
    }

    private var today: [TTEvent] {
        let cal = Calendar.current
        let start = cal.startOfDay(for: Date())
        return timetables.events(timetables.active?.id, from: start, to: cal.date(byAdding: .day, value: 1, to: start)!)
            .filter { !$0.allDay && $0.end > Date() }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Text(Date().formatted(.dateTime.weekday(.wide).day().month(.wide).locale(deLocale)).uppercased())
                        .font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                        .padding(.horizontal, 4).padding(.bottom, -14)

                    NowCard(events: today).onTapGesture { router.tab = .timetable }

                    if let d = mensa.plan?.days.first(where: { $0.date == isoDay(Date()) }), !d.dishes.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionTitle("Heute in der Mensa", action: "Speiseplan") { router.tab = .mensa }
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

                    VStack(alignment: .leading, spacing: 10) {
                        SectionTitle("Bald fällig")
                        VStack(spacing: 0) {
                            if upcoming.isEmpty {
                                Label("Nichts fällig – gut gemacht!", systemImage: "checkmark.circle")
                                    .font(.subheadline).foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity, alignment: .leading).padding(14)
                            }
                            ForEach(Array(upcoming.enumerated()), id: \.element.id) { i, e in
                                NavigationLink(value: e.cmid.map { Route.module($0) } ?? Route.course(e.courseid ?? 0)) {
                                    HStack {
                                        DeadlineRow(event: e)
                                        Spacer()
                                        Image(systemName: "chevron.right").font(.caption.bold()).foregroundStyle(.tertiary)
                                    }
                                    .padding(.horizontal, 14).padding(.vertical, 10)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                if i < upcoming.count - 1 { Divider().padding(.leading, 70) }
                            }
                        }
                        .card()
                    }

                    let news = app.cache.newItems.prefix(8).compactMap { app.cache.files[$0.fileId] }
                    if !news.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionTitle("Neu synchronisiert", action: "Gelesen") { withAnimation { app.clearNews() } }
                            VStack(spacing: 0) {
                                ForEach(Array(news.enumerated()), id: \.element.id) { i, f in
                                    NavigationLink(value: Route.doc(f.id, nil)) {
                                        HStack {
                                            FileRow(file: f, showCourse: true)
                                            Spacer()
                                            Image(systemName: "chevron.right").font(.caption.bold()).foregroundStyle(.tertiary)
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

                    SyncStatusRow().padding(14).card()
                }
                .padding(.horizontal)
                .padding(.bottom, 24)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(greeting)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink(value: Route.settings) { Image(systemName: "gearshape") }
                }
            }
            .refreshable { await app.sync() }
            .withRoutes()
        }
    }

    private var greeting: String {
        let h = Calendar.current.component(.hour, from: Date())
        let name = app.cache.site?.firstname ?? ""
        let g = h < 11 ? "Guten Morgen" : h < 18 ? "Hallo" : "Guten Abend"
        return name.isEmpty ? g : "\(g), \(name)"
    }
}

extension View {
    // Weiße, abgerundete Karte wie in den Apple-Apps (Health, Fitness)
    func card() -> some View {
        background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

struct SectionTitle: View {
    let title: String
    var action: String?
    var onAction: (() -> Void)?

    init(_ title: String, action: String? = nil, onAction: (() -> Void)? = nil) {
        self.title = title
        self.action = action
        self.onAction = onAction
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.title3.bold())
            Spacer()
            if let action, let onAction { Button(action, action: onAction).font(.subheadline) }
        }
        .padding(.horizontal, 4)
    }
}

// Aktuelle bzw. nächste Vorlesung heute
struct NowCard: View {
    let events: [TTEvent]

    var body: some View {
        TimelineView(.periodic(from: .now, by: 10)) { ctx in
            let now = ctx.date
            let current = events.first { $0.start <= now && $0.end > now }
            let next = events.first { $0.start > now }
            VStack(alignment: .leading, spacing: 12) {
                if let e = current ?? next {
                    let c = lectureColor(e.title)
                    HStack {
                        Label(current != nil ? "Jetzt" : "Als Nächstes", systemImage: current != nil ? "dot.radiowaves.left.and.right" : "clock")
                            .font(.caption.weight(.bold)).foregroundStyle(c)
                            .textCase(.uppercase)
                        Spacer()
                        if let p = current?.elapsed(at: now) {
                            Text("\(Int(p * 100)) % vorbei").font(.caption.weight(.bold).monospacedDigit()).foregroundStyle(c)
                                .contentTransition(.numericText())
                        } else {
                            Text(e.start, style: .relative).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                    Text(lectureTitle(e.title)).font(.title2.bold()).lineLimit(2)
                    HStack(spacing: 14) {
                        Label("\(e.start.formatted(date: .omitted, time: .shortened)) – \(e.end.formatted(date: .omitted, time: .shortened))", systemImage: "clock")
                        if !e.location.isEmpty { Label(e.location, systemImage: "mappin.and.ellipse").lineLimit(1) }
                    }
                    .font(.subheadline).foregroundStyle(.secondary)
                    if let p = current?.elapsed(at: now) {
                        VStack(spacing: 4) {
                            ProgressView(value: p).tint(c)
                            Text("noch \(Int(ceil(e.end.timeIntervalSince(now) / 60))) min")
                                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .trailing)
                        }
                    }
                    let later = events.filter { $0.start > (current?.start ?? now) && $0.id != e.id }
                    if !later.isEmpty {
                        Divider()
                        ForEach(later.prefix(3)) { l in
                            HStack(spacing: 8) {
                                Circle().fill(lectureColor(l.title)).frame(width: 8, height: 8)
                                Text(l.start.formatted(date: .omitted, time: .shortened)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                Text(lectureTitle(l.title)).font(.caption).lineLimit(1)
                            }
                        }
                    }
                } else {
                    HStack(spacing: 14) {
                        Image(systemName: "sun.max.fill").font(.largeTitle).symbolRenderingMode(.multicolor)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Heute keine Vorlesungen mehr").font(.headline)
                            Text("Tippe für den Stundenplan").font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
        }
    }
}

struct DishCard: View {
    let dish: Dish

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack {
                Color(.tertiarySystemFill)
                if let t = dish.image ?? dish.thumb, let u = URL(string: t) {
                    AsyncImage(url: u) { img in img.resizable().scaledToFill() } placeholder: { Image(systemName: "fork.knife").foregroundStyle(.tertiary) }
                } else {
                    Image(systemName: "fork.knife").font(.title2).foregroundStyle(.tertiary)
                }
            }
            .frame(width: 170, height: 104)
            .clipped()
            VStack(alignment: .leading, spacing: 3) {
                Text(dish.category.uppercased()).font(.caption2.bold()).foregroundStyle(.secondary).lineLimit(1)
                Text(dish.title).font(.subheadline.weight(.semibold)).lineLimit(2, reservesSpace: true)
                Text(fmtEuro(dish.dhbw ?? dish.intern)).font(.caption.weight(.semibold).monospacedDigit()).foregroundStyle(brand)
            }
            .padding(10)
        }
        .frame(width: 170)
        .card()
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
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
                case .error: Image(systemName: "exclamationmark.icloud.fill").foregroundStyle(.orange)
                case .idle: Image(systemName: "checkmark.icloud.fill").foregroundStyle(.green)
                }
            }
            .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
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
        HStack(spacing: 12) {
            VStack(spacing: 0) {
                Text(date.formatted(.dateTime.day())).font(.title3.bold())
                Text(date.formatted(.dateTime.month(.abbreviated).locale(deLocale))).font(.caption2).textCase(.uppercase)
            }
            .frame(width: 44, height: 44)
            .background((event.overdue ? Color.red : brand).opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
            .foregroundStyle(event.overdue ? .red : brand)
            VStack(alignment: .leading, spacing: 2) {
                Text(event.title).font(.subheadline.weight(.medium)).lineLimit(2)
                Text("\(event.coursename) · \(date.formatted(.dateTime.weekday(.abbreviated).hour().minute().locale(deLocale)))")
                    .font(.caption).foregroundStyle(event.overdue ? .red : .secondary).lineLimit(1)
            }
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
                .font(.title3).foregroundStyle(file.ext == "pdf" ? .red : brand)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.filename).font(.subheadline).lineLimit(2)
                HStack(spacing: 4) {
                    if showCourse, let k = app.cache.course(file.courseId) { Text(k.title + " ·") }
                    Text(fmtSize(file.filesize))
                    if file.downloaded { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) }
                    else if file.error != nil { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
                    else { Image(systemName: "icloud").foregroundStyle(.secondary) }
                }
                .font(.caption).foregroundStyle(.secondary)
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
