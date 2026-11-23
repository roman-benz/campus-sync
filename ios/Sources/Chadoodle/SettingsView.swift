// Einstellungen: Moodle-Konto, Synchronisation, KI-Assistent, Stundenpläne, Mensa, Chadoodle-Zugang.
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var gate: AccessGate
    @EnvironmentObject private var chatgpt: ChatGPTAuth
    @EnvironmentObject private var assistant: Assistant
    @EnvironmentObject private var tt: Timetables
    @EnvironmentObject private var mensa: MensaStore
    @EnvironmentObject private var index: DocIndex
    @EnvironmentObject private var dualis: DualisStore
    @EnvironmentObject private var notifier: Notifier
    @AppStorage("notifyGrades") private var notifyGrades = true
    @AppStorage("notifyFiles") private var notifyFiles = true
    @AppStorage("notifyDeadlines") private var notifyDeadlines = true
    @AppStorage("autoDownload") private var autoDownload = true
    @AppStorage("maxFileSizeMB") private var maxFileSizeMB = 200
    @AppStorage("chatgptModel") private var model = ""
    @AppStorage("aiEffort") private var effort = "balanced"
    @State private var mensaUrl = ""
    @State private var mensaError: String?
    @State private var confirmLogout = false
    @State private var showAddTimetable = false
    @State private var chatgptError: String?

    var body: some View {
        Form {
            Section("Moodle") {
                if let s = app.cache.site {
                    LabeledContent("Angemeldet als", value: s.fullname)
                    LabeledContent("Seite", value: s.sitename)
                }
                Button("Abmelden", role: .destructive) { confirmLogout = true }
            }
            Section {
                Toggle("Dateien automatisch laden", isOn: $autoDownload)
                Stepper("Max. Dateigröße: \(maxFileSizeMB) MB", value: $maxFileSizeMB, in: 10...1000, step: 10)
                Button("Jetzt synchronisieren") { Task { await app.sync() } }
                let p = index.progress(app.cache.files)
                LabeledContent("Durchsuchbar", value: "\(p.indexed) von \(p.total) Dokumenten")
            } header: { Text("Synchronisation") } footer: {
                Text("Die Kursdateien liegen in der Dateien-App unter „Auf meinem iPhone → Chadoodle“.")
            }
            Section {
                Toggle("Neue Noten", isOn: $notifyGrades)
                Toggle("Neue Dateien", isOn: $notifyFiles)
                Toggle("Fristen-Erinnerungen", isOn: $notifyDeadlines)
                    .onChange(of: notifyDeadlines) { _, _ in Task { await notifier.scheduleDeadlines(app.cache.events) } }
                if notifier.authorized == false {
                    Button("Mitteilungen in iOS erlauben") {
                        if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) }
                    }
                }
            } header: { Text("Mitteilungen") } footer: {
                Text("iOS weckt Chadoodle regelmäßig im Hintergrund; neue Noten aus Dualis und neue Kursdateien kommen dann als Mitteilung. Fristen werden einen Tag und zwei Stunden vorher gemeldet. Voraussetzung: Hintergrundaktualisierung ist in den iOS-Einstellungen an.")
            }
            Section("Noten (Dualis)") {
                if dualis.configured {
                    LabeledContent("Verbunden als", value: dualis.user ?? "")
                    if let c = dualis.cache { LabeledContent("Stand", value: relTime(c.fetchedAt)) }
                    Button("Dualis trennen", role: .destructive) { dualis.disconnect() }
                } else {
                    Text("Im Reiter „Noten“ mit Dualis verbinden.").foregroundStyle(Color.inkSecondary)
                }
            }
            Section("KI-Assistent (ChatGPT)") {
                if chatgpt.signedIn {
                    LabeledContent("Verbunden", value: chatgpt.account?.email ?? chatgpt.account?.name ?? "ChatGPT-Konto")
                    if !chatgpt.planUsage { Text("Plan-Nutzung nicht freigegeben").font(.caption).foregroundStyle(Color.ink) }
                    Picker("Modell", selection: $model) {
                        Text("Automatisch").tag("")
                        ForEach(assistant.models, id: \.id) { m in Text(m.name).tag(m.id) }
                    }
                    Picker("Gründlichkeit", selection: $effort) {
                        Text("Schnell").tag("fast")
                        Text("Ausgewogen").tag("balanced")
                        Text("Gründlich").tag("thorough")
                    }
                    Button("Von ChatGPT abmelden", role: .destructive) { Task { await chatgpt.logout() } }
                } else {
                    Button("Mit ChatGPT verbinden") {
                        Task {
                            chatgptError = nil
                            do { try await chatgpt.login() } catch WebAuth.Cancelled.cancelled {} catch { chatgptError = error.localizedDescription }
                        }
                    }
                    if let chatgptError { Text(chatgptError).font(.caption).foregroundStyle(Color.ink) }
                }
            }
            Section("Stundenpläne") {
                ForEach(tt.list) { t in
                    VStack(alignment: .leading) {
                        HStack {
                            Text(t.name)
                            if t.id == tt.active?.id { Image(systemName: "checkmark").foregroundStyle(brand) }
                        }
                        Text(t.url).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { tt.activeId = t.id }
                }
                .onDelete { idx in idx.map { tt.list[$0].id }.forEach(tt.remove) }
                Button { showAddTimetable = true } label: { Label("Hinzufügen", systemImage: "plus") }
            }
            Section {
                TextField("my-mensa.de-Link", text: $mensaUrl)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .onSubmit {
                        Task {
                            mensaError = nil
                            do { try await mensa.setUrl(mensaUrl) } catch { mensaError = error.localizedDescription }
                        }
                    }
                if let mensaError { Text(mensaError).font(.caption).foregroundStyle(Color.ink) }
            } header: { Text("Mensa") } footer: {
                Text("Link der Mensa-Seite auf my-mensa.de, z. B. …/mensatogo.php?mensa=mensa_fallenbrunnen")
            }
            Section("Chadoodle-Zugang") {
                Button("Passkey-Sitzung beenden", role: .destructive) { Task { await gate.logout() } }
            }
            Section {} footer: {
                Text("Chadoodle \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")")
                    .frame(maxWidth: .infinity)
            }
        }
        .navigationTitle("Einstellungen")
        .task { await notifier.refreshAuthorization() }
        .confirmationDialog("Von Moodle abmelden?", isPresented: $confirmLogout, titleVisibility: .visible) {
            Button("Abmelden und Dateien löschen", role: .destructive) { app.signOut(deleteFiles: true) }
            Button("Abmelden, Dateien behalten") { app.signOut(deleteFiles: false) }
        }
        .sheet(isPresented: $showAddTimetable) { AddTimetableView() }
        .onAppear { mensaUrl = mensa.url }
        .task { await assistant.loadModels() }
    }
}
