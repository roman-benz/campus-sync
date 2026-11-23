// Noten aus Dualis: Kacheln mit genauem Notenschnitt (zwei Nachkommastellen), Credits und Fortschritt,
// darunter alle Module je Gruppe. Neue Noten sind 7 Tage markiert und kommen als Mitteilung.
import SwiftUI

struct GradesView: View {
    @EnvironmentObject private var dualis: DualisStore

    var body: some View {
        NavigationStack {
            Group {
                if dualis.configured && !dualis.authFailed, let data = dualis.data {
                    GradesList(data: data)
                } else if dualis.configured && !dualis.authFailed {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("Lade Noten aus Dualis…").foregroundStyle(Color.inkSecondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .task { await dualis.refresh() }
                } else {
                    DualisLogin()
                }
            }
            .appBackground()
            .navigationTitle("Noten")
            .toolbar {
                if dualis.configured {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button { Task { await dualis.refresh() } } label: { Label("Aktualisieren", systemImage: "arrow.clockwise") }
                            Link(destination: URL(string: "https://dualis.dhbw.de/")!) { Label("Dualis im Browser", systemImage: "safari") }
                            Button(role: .destructive) { dualis.disconnect() } label: { Label("Dualis trennen", systemImage: "rectangle.portrait.and.arrow.right") }
                        } label: {
                            if dualis.busy { ProgressView() } else { Image(systemName: "ellipsis.circle") }
                        }
                    }
                }
            }
            .refreshable { await dualis.refresh() }
        }
    }
}

private struct GradesList: View {
    @EnvironmentObject private var dualis: DualisStore
    let data: DualisData

    var body: some View {
        let mods = data.groups.flatMap(\.modules)
        let graded = mods.filter { $0.grade != nil }.count
        let credits = data.totalCredits ?? mods.reduce(0) { $0 + ($1.grade != nil ? $1.credits ?? 0 : 0) }
        let gx = gpaExact(data)
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 2) {
                    if !data.program.isEmpty { Text(data.program).font(.subheadline.weight(.semibold)) }
                    Text([dualis.cache.map { "Stand \(relTime($0.fetchedAt))" }, dualis.error].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(Color.inkSecondary)
                }
                .padding(.horizontal, 2)

                LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                    tile("Gesamt-GPA", fmtGrade(gx.total) ?? data.gpa.total ?? "–", gx.total != nil ? data.gpa.total.map { "Dualis zeigt \($0)" } : nil, dark: true)
                    tile("Hauptfach-GPA", fmtGrade(gx.major) ?? data.gpa.major ?? "–", gx.major != nil ? data.gpa.major.map { "Dualis zeigt \($0)" } : nil)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Credits").font(.caption.weight(.semibold)).foregroundStyle(Color.inkSecondary)
                        Text(fmtNum(credits)).font(.title2.bold().monospacedDigit())
                        if let req = data.required, req > 0 {
                            ProgressView(value: min(1, credits / req)).tint(Color.ink)
                            Text("\(Int(min(100, credits / req * 100))) % von \(fmtNum(req))").font(.caption2).foregroundStyle(Color.inkSecondary)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 92, alignment: .topLeading)
                    .padding(14)
                    .card()
                    tile("Module mit Note", "\(graded) / \(mods.count)", nil)
                }

                ForEach(data.groups) { g in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text(g.title).font(.headline)
                            Spacer()
                            if let c = g.sumCredits { Text("\(fmtNum(c)) Credits").font(.caption).foregroundStyle(Color.inkSecondary) }
                        }
                        .padding(.horizontal, 2)
                        VStack(spacing: 0) {
                            ForEach(Array(g.modules.enumerated()), id: \.element.id) { i, m in
                                ModuleGradeRow(module: m)
                                if i < g.modules.count - 1 { Divider().padding(.leading, 14) }
                            }
                        }
                        .card()
                    }
                }

                Text("Chadoodle prüft Dualis im Hintergrund und meldet neue Noten als Mitteilung. Benutzername und Kennwort liegen nur im Schlüsselbund dieses iPhones und gehen ausschließlich an dualis.dhbw.de.")
                    .font(.caption).foregroundStyle(Color.inkSecondary).padding(.horizontal, 2)
            }
            .padding()
        }
    }

    private func tile(_ label: String, _ value: String, _ sub: String?, dark: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.caption.weight(.semibold)).opacity(0.75)
            Text(value).font(.title.bold().monospacedDigit())
            if let sub { Text(sub).font(.caption2).opacity(0.75) }
        }
        .foregroundStyle(dark ? Color.pLight : Color.ink)
        .frame(maxWidth: .infinity, minHeight: 92, alignment: .topLeading)
        .padding(14)
        .background(dark ? Color.shade0 : Color.cardBackground, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

func fmtNum(_ n: Double) -> String {
    n == n.rounded() ? String(Int(n)) : String(format: "%.1f", n).replacingOccurrences(of: ".", with: ",")
}

private struct ModuleGradeRow: View {
    let module: DualisModule

    var body: some View {
        let failed = module.status.lowercased().contains("nicht")
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(module.name).font(.subheadline.weight(.medium)).lineLimit(2)
                    if module.isNew { Pill(text: "Neu") }
                }
                Text([module.no, module.credits.map { "\(fmtNum($0)) Credits" }, module.status.isEmpty ? nil : module.status].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(Color.inkSecondary).lineLimit(1)
            }
            Spacer()
            Text(module.grade ?? "–")
                .font(.headline.monospacedDigit())
                .frame(minWidth: 48, minHeight: 34)
                .background(module.grade == nil ? Color.clear : failed ? Color.ink : Color.appBackground, in: RoundedRectangle(cornerRadius: 10))
                .foregroundStyle(module.grade == nil ? Color.pMid : failed ? Color.onInk : Color.ink)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(module.isNew ? Color.softFill.opacity(0.6) : .clear)
    }
}

private struct DualisLogin: View {
    @EnvironmentObject private var dualis: DualisStore
    @State private var user = ""
    @State private var pass = ""
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Image(systemName: "graduationcap.fill").font(.largeTitle).foregroundStyle(Color.ink)
                    Text(dualis.authFailed ? "Bei Dualis neu anmelden" : "Mit Dualis verbinden").font(.title3.bold())
                    Text(dualis.authFailed
                         ? "Dualis hat das gespeicherte Kennwort abgelehnt – vermutlich wurde es geändert. Melde dich einmal neu an."
                         : "Melde dich einmal an – danach lädt Chadoodle deine Noten, aktualisiert sie im Hintergrund und meldet neue Noten als Mitteilung.")
                        .font(.subheadline).foregroundStyle(Color.inkSecondary)
                }
                .listRowBackground(Color.clear)
            }
            Section("Dualis-Zugang") {
                TextField("Benutzername", text: $user).textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField("Kennwort", text: $pass).textContentType(.password)
                Button {
                    Task {
                        error = nil
                        do { try await dualis.connect(user: user, pass: pass) } catch { self.error = error.localizedDescription }
                    }
                } label: {
                    HStack {
                        if dualis.busy { ProgressView() }
                        Text(dualis.busy ? "Verbinde…" : "Anmelden").frame(maxWidth: .infinity)
                    }
                }
                .disabled(dualis.busy || user.isEmpty || pass.isEmpty)
            }
            if let error { Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.ink) } }
            Section {} footer: {
                Text("Benutzername und Kennwort werden nur im Schlüsselbund dieses iPhones gespeichert und nur an dualis.dhbw.de gesendet – nicht an das Chadoodle-Konto und nicht an einen KI-Anbieter.")
            }
        }
        .scrollContentBackground(.hidden)
        .onAppear { user = dualis.user ?? "" }
    }
}
