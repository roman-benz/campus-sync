// Kursliste mit Volltextsuche, Kursinhalt (Abschnitte → Aktivitäten) und Aktivitäten im Detail.
import SafariServices
import SwiftUI

struct CoursesView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var index: DocIndex
    @State private var query = ""

    private var courses: [Course] {
        app.cache.courses.filter { !$0.hidden }.sorted { ($0.isfavourite ? 0 : 1, -($0.lastaccess ?? 0)) < ($1.isfavourite ? 0 : 1, -($1.lastaccess ?? 0)) }
    }

    var body: some View {
        NavigationStack {
            List {
                if query.trimmingCharacters(in: .whitespaces).count >= 2 {
                    SearchResults(query: query)
                } else {
                    if courses.isEmpty {
                        ContentUnavailableView("Noch keine Kurse", systemImage: "books.vertical", description: Text("Ziehe nach unten, um zu synchronisieren."))
                    }
                    ForEach(courses) { k in
                        NavigationLink(value: Route.course(k.id)) { CourseRow(course: k) }
                    }
                }
            }
            .navigationTitle("Kurse")
            .searchable(text: $query, prompt: "In allen Unterlagen suchen")
            .refreshable { await app.sync() }
            .withRoutes()
        }
    }
}

struct CourseRow: View {
    @EnvironmentObject private var app: AppModel
    let course: Course

    var body: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 10)
                .fill(color(course.id).gradient)
                .frame(width: 44, height: 44)
                .overlay(Text(initials).font(.subheadline.bold()).foregroundStyle(.white))
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    if course.isfavourite { Image(systemName: "star.fill").font(.caption2).foregroundStyle(.yellow) }
                    Text(course.fullname).font(.subheadline.weight(.medium)).lineLimit(2)
                }
                let files = app.cache.files.values.filter { $0.courseId == course.id }
                Text([course.categoryname, files.isEmpty ? nil : "\(files.count) Dateien"].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                if let p = course.progress {
                    ProgressView(value: p, total: 100).tint(brand)
                }
            }
        }
    }

    private var initials: String {
        String(course.title.split(separator: " ").prefix(2).compactMap(\.first)).uppercased()
    }
}

func color(_ id: Int) -> Color {
    let palette: [Color] = [.blue, .indigo, .teal, .purple, .orange, .pink, .green, .cyan, .mint, .brown]
    return palette[abs(id) % palette.count]
}

// Volltextsuche (seitengenau) plus Treffer in Kurs-, Datei- und Aktivitätsnamen
struct SearchResults: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var index: DocIndex
    let query: String

    var body: some View {
        let r = index.search(query, files: app.cache.files, limit: 60)
        let q = norm(query)
        let names = app.cache.files.values.filter { norm($0.filename + " " + $0.moduleName).contains(q) }.prefix(20)
        let p = index.progress(app.cache.files)
        Section {
            if r.hits.isEmpty { Text("Keine Fundstellen in den Dokumenten").foregroundStyle(.secondary) }
            ForEach(r.hits) { h in
                if let f = app.cache.files[h.fileId] {
                    NavigationLink(value: Route.doc(f.id, h.page)) {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Image(systemName: fileIcon(f.ext)).foregroundStyle(.red)
                                Text(f.filename).font(.subheadline.weight(.medium)).lineLimit(1)
                                Spacer()
                                Text("S. \(h.page)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            }
                            Text(highlight(h.snippet, r.terms)).font(.caption).foregroundStyle(.secondary).lineLimit(4)
                            if let k = app.cache.course(f.courseId) { Text(k.title).font(.caption2).foregroundStyle(.tertiary) }
                        }
                    }
                }
            }
        } header: {
            Text(r.hits.isEmpty ? "Dokumente" : "\(r.totalPages) Seiten in \(r.totalFiles) Dokumenten")
        } footer: {
            if p.indexed < p.total { Text("\(p.indexed) von \(p.total) Dokumenten sind schon durchsuchbar.") }
        }
        if !names.isEmpty {
            Section("Dateien") {
                ForEach(Array(names)) { f in
                    NavigationLink(value: Route.doc(f.id, nil)) { FileRow(file: f, showCourse: true) }
                }
            }
        }
    }

    private func highlight(_ s: String, _ terms: [String]) -> AttributedString {
        var a = AttributedString(s)
        let n = norm(s)
        guard n.count == s.count else { return a } // Umlaut-Ersetzung verschiebt Positionen – dann ohne Hervorhebung
        for t in terms {
            var from = n.startIndex
            while let r = n.range(of: t, range: from..<n.endIndex) {
                let lo = n.distance(from: n.startIndex, to: r.lowerBound)
                let len = n.distance(from: r.lowerBound, to: r.upperBound)
                let start = a.index(a.startIndex, offsetByCharacters: lo)
                let end = a.index(start, offsetByCharacters: len)
                a[start..<end].foregroundColor = .primary
                a[start..<end].font = .caption.bold()
                from = r.upperBound
            }
        }
        return a
    }
}

// ---------- Kurs ----------
struct CourseDetailView: View {
    @EnvironmentObject private var app: AppModel
    let courseId: Int
    @State private var showGrades = false

    var body: some View {
        let course = app.cache.course(courseId)
        let sections = app.cache.contents[courseId] ?? []
        List {
            if let course, !stripHtml(course.summary).isEmpty {
                Section { HTMLText(html: course.summary).font(.callout) }
            }
            ForEach(sections.filter { $0.uservisible && (!$0.modules.isEmpty || !stripHtml($0.summary).isEmpty) }) { s in
                Section(s.name.isEmpty ? "Abschnitt \(s.section)" : s.name) {
                    if !stripHtml(s.summary).isEmpty { HTMLText(html: s.summary).font(.callout).foregroundStyle(.secondary) }
                    ForEach(s.modules.filter(\.uservisible)) { m in ModuleRow(module: m) }
                }
            }
        }
        .navigationTitle(course?.title ?? "Kurs")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !(app.cache.grades[courseId] ?? []).isEmpty {
                Button { showGrades = true } label: { Image(systemName: "rosette") }
            }
        }
        .sheet(isPresented: $showGrades) { GradesView(courseId: courseId) }
        .refreshable { await app.sync() }
    }
}

struct ModuleRow: View {
    @EnvironmentObject private var app: AppModel
    let module: Module

    var body: some View {
        let files = app.files(of: module)
        if module.modname == "label" {
            HTMLText(html: module.description).font(.callout)
        } else if module.modname == "resource", files.count == 1, let f = files.first {
            NavigationLink(value: Route.doc(f.id, nil)) { FileRow(file: f) }
        } else {
            NavigationLink(value: Route.module(module.id)) {
                HStack(spacing: 12) {
                    Image(systemName: modIcon(module.modname)).font(.title3).foregroundStyle(modColor).frame(width: 28)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(module.name).font(.subheadline).lineLimit(2)
                        if let sub = subtitle { Text(sub).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                    }
                    Spacer()
                    if module.completion == 1 || module.completion == 2 { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) }
                }
            }
        }
    }

    private var modColor: Color {
        switch module.modname {
        case "assign", "quiz": return .pink
        case "forum": return .orange
        case "folder": return .teal
        case "url": return .indigo
        default: return brand
        }
    }

    private var subtitle: String? {
        if let a = app.cache.assignments[module.id], a.duedate > 0 { return "Fällig \(fmtDate(a.duedate))" }
        if module.modname == "folder" { return "\(app.files(of: module).count) Dateien" }
        if let d = module.dates.first { return "\(d.label) \(fmtDate(d.timestamp))" }
        return modLabel[module.modname]
    }
}

// ---------- Aktivität ----------
struct ModuleDetailView: View {
    @EnvironmentObject private var app: AppModel
    let moduleId: Int
    @State private var safari: URL?

    var body: some View {
        if let hit = app.cache.findModule(moduleId) {
            let m = hit.module
            List {
                Section {
                    Label(modLabel[m.modname] ?? m.modname, systemImage: modIcon(m.modname)).font(.caption).foregroundStyle(.secondary)
                    Text(m.name).font(.title3.bold())
                    ForEach(m.dates, id: \.self) { d in
                        LabeledContent(d.label, value: fmtDate(d.timestamp)).font(.callout)
                    }
                }
                if let a = app.cache.assignments[m.id] {
                    Section("Aufgabe") {
                        if a.duedate > 0 { LabeledContent("Fällig", value: fmtDate(a.duedate)) }
                        if a.cutoffdate > 0 { LabeledContent("Letzte Abgabe", value: fmtDate(a.cutoffdate)) }
                        if !stripHtml(a.intro).isEmpty { HTMLText(html: a.intro) }
                    }
                } else if !stripHtml(m.description).isEmpty {
                    Section { HTMLText(html: m.description) }
                }
                if let p = app.cache.pages[m.id] {
                    Section { HTMLText(html: p.content) }
                }
                if let fo = app.cache.forums[m.id] {
                    Section("Diskussionen") {
                        if fo.discussions.isEmpty { Text("Keine Beiträge").foregroundStyle(.secondary) }
                        ForEach(fo.discussions) { d in
                            DisclosureGroup {
                                HTMLText(html: d.message).font(.callout)
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack(spacing: 4) {
                                        if d.pinned { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(.orange) }
                                        Text(d.subject).font(.subheadline.weight(.medium))
                                    }
                                    Text("\(d.author) · \(fmtDate(d.modified)) · \(d.replies) Antworten").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                let files = app.files(of: m)
                if !files.isEmpty {
                    Section("Dateien") {
                        ForEach(files) { f in NavigationLink(value: Route.doc(f.id, nil)) { FileRow(file: f) } }
                    }
                }
                if m.modname == "url", let link = m.contents.first?.fileurl, let u = URL(string: link) {
                    Section { Button { safari = u } label: { Label(link, systemImage: "link").lineLimit(1) } }
                }
                if let url = m.url {
                    Section {
                        Button {
                            Task { safari = await app.onlineURL(url) }
                        } label: { Label("In Moodle öffnen", systemImage: "safari") }
                    } footer: {
                        if app.cache.pages[m.id] == nil && app.cache.forums[m.id] == nil && files.isEmpty && app.cache.assignments[m.id] == nil {
                            Text("Diese Aktivität gibt es nur online in Moodle.")
                        }
                    }
                }
            }
            .navigationTitle(modLabel[m.modname] ?? "Aktivität")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(item: $safari) { SafariView(url: $0).ignoresSafeArea() }
        } else {
            ContentUnavailableView("Aktivität nicht gefunden", systemImage: "questionmark.folder")
        }
    }
}

struct GradesView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.dismiss) private var dismiss
    let courseId: Int

    var body: some View {
        NavigationStack {
            List(Array((app.cache.grades[courseId] ?? []).enumerated()), id: \.offset) { _, g in
                HStack {
                    VStack(alignment: .leading) {
                        Text(g.name).font(g.itemtype == "course" ? .subheadline.bold() : .subheadline)
                        if let r = g.range { Text("Bereich \(r)").font(.caption).foregroundStyle(.secondary) }
                    }
                    Spacer()
                    VStack(alignment: .trailing) {
                        Text(g.grade.flatMap { $0.isEmpty ? nil : $0 } ?? "–").font(.subheadline.monospacedDigit().bold())
                        if let p = g.percentage, p != "-" { Text(p).font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
            .navigationTitle("Bewertungen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Fertig") { dismiss() } }
        }
    }
}

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}

struct SafariView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}
}
