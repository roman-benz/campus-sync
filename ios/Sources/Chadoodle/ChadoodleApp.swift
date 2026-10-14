// Chadoodle fürs iPhone: native App für die Moodle-Kurse – lokal synchronisiert, mit PDF-Viewer,
// Volltextsuche, Stundenplan, Mensa und ChatGPT-Lernassistent. Gleicher Ablauf wie die Desktop-App:
// erst Passkey-Zugang (chadoodle.romanbenz.com), dann Moodle-Anmeldung, danach arbeitet alles auf der lokalen Kopie.
import SwiftUI

let brand = Color(red: 0.06, green: 0.42, blue: 0.75)

@main
struct ChadoodleApp: App {
    @StateObject private var gate = AccessGate()
    @StateObject private var app = AppModel()
    @StateObject private var assistant = Assistant()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(gate)
                .environmentObject(app)
                .environmentObject(app.index)
                .environmentObject(app.timetables)
                .environmentObject(app.mensa)
                .environmentObject(app.chatgpt)
                .environmentObject(assistant)
                .tint(brand)
                .onAppear { assistant.attach(app) }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var gate: AccessGate
    @EnvironmentObject private var app: AppModel
    @Environment(\.scenePhase) private var phase

    var body: some View {
        Group {
            switch gate.state {
            case .checking:
                ProgressView()
            case .signedOut:
                GateLoginView()
            case .signedIn:
                if app.signedIn { MainTabs() } else { MoodleLoginView() }
            }
        }
        .task { await gate.restore() }
        .onChange(of: phase) { _, p in
            guard p == .active, gate.state == .signedIn, app.signedIn else { return }
            Task {
                await app.syncIfStale()
                await app.chatgpt.keepAlive()
            }
        }
    }
}

struct MainTabs: View {
    @EnvironmentObject private var app: AppModel
    @StateObject private var router = TabRouter()

    var body: some View {
        TabView(selection: $router.tab) {
            HomeView().tabItem { Label("Heute", systemImage: "sun.max.fill") }.tag(TabRouter.Tab.home)
            CoursesView().tabItem { Label("Kurse", systemImage: "books.vertical.fill") }.tag(TabRouter.Tab.courses)
            TimetableView().tabItem { Label("Stundenplan", systemImage: "calendar") }.tag(TabRouter.Tab.timetable)
            MensaView().tabItem { Label("Mensa", systemImage: "fork.knife") }.tag(TabRouter.Tab.mensa)
            AssistantView().tabItem { Label("Assistent", systemImage: "sparkles") }.tag(TabRouter.Tab.assistant)
        }
        .environmentObject(router)
        .task { await app.syncIfStale() }
    }
}

// ---------- Passkey-Zugang ----------
struct GateLoginView: View {
    @EnvironmentObject private var gate: AccessGate

    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            AppLogo(size: 96)
            Text("Chadoodle").font(.largeTitle.bold())
            Text("Melde dich mit demselben Passkey an wie auf chadoodle.romanbenz.com.")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button {
                Task { await gate.login() }
            } label: {
                HStack {
                    if gate.busy { ProgressView().tint(.white) }
                    Label("Mit Passkey anmelden", systemImage: "person.badge.key.fill")
                }
                .frame(maxWidth: .infinity).padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .disabled(gate.busy)
            if let e = gate.error {
                Text(e).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
            }
            Spacer()
            Text("Noch kein Passkey? Den Einladungslink bekommst du vom Admin.")
                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .padding(28)
        .frame(maxWidth: 480)
    }
}

// ---------- Moodle-Anmeldung ----------
struct MoodleLoginView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var gate: AccessGate
    @AppStorage("siteUrl") private var siteUrl = "https://elearning.dhbw-ravensburg.de"
    @State private var username = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @State private var ssoOnly = false
    @State private var sso = MoodleSSO()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 14) {
                        AppLogo(size: 52)
                        VStack(alignment: .leading) {
                            Text("Bei Moodle anmelden").font(.title3.bold())
                            Text("Chadoodle lädt deine Kurse und Dateien auf dieses iPhone.").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    .listRowBackground(Color.clear)
                }
                Section("Moodle-Adresse") {
                    TextField("https://moodle.hochschule.de", text: $siteUrl)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .onSubmit { Task { await checkSite() } }
                }
                if !ssoOnly {
                    Section("Mit Kennwort") {
                        TextField("Benutzername", text: $username).textContentType(.username)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        SecureField("Kennwort", text: $password).textContentType(.password)
                        Button {
                            Task { await run { try await moodleLoginWithPassword(siteUrl: siteUrl, username: username, password: password) } }
                        } label: { Text("Anmelden").frame(maxWidth: .infinity) }
                            .disabled(busy || username.isEmpty || password.isEmpty)
                    }
                }
                Section {
                    Button {
                        Task { await run { try await sso.login(siteUrl: siteUrl) } }
                    } label: { Label("Über den Browser anmelden (SSO)", systemImage: "safari") }
                        .disabled(busy)
                } footer: {
                    Text("Für Hochschul-Logins wie Shibboleth oder Microsoft. Nach der Anmeldung kehrt Moodle automatisch in die App zurück.")
                }
                if busy { Section { HStack { ProgressView(); Text("Anmelden…") } } }
                if let error { Section { Text(error).foregroundStyle(.red) } }
                Section {
                    Button("Chadoodle-Zugang abmelden", role: .destructive) { Task { await gate.logout() } }
                }
            }
            .navigationTitle("Chadoodle")
            .task { await checkSite() }
        }
    }

    private func checkSite() async {
        if let cfg = try? await moodlePublicConfig(siteUrl) {
            let t = jInt(cfg["typeoflogin"]) ?? 1 // 1 = App, 2 = Browser, 3 = eingebetteter Browser
            ssoOnly = t == 2 || t == 3
        }
    }

    private func run(_ f: () async throws -> MoodleAccount) async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            let a = try await f()
            app.signIn(a)
        } catch let e as MoodleError where e.code == "cancelled" {
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct AppLogo: View {
    var size: CGFloat

    var body: some View {
        Group {
            if let img = Bundle.main.appIcon {
                Image(uiImage: img).resizable()
            } else {
                Image(systemName: "graduationcap.fill").resizable().scaledToFit().padding(size * 0.2)
                    .foregroundStyle(.white).background(brand)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
    }
}

extension Bundle {
    // Das von xtool eingebaute App-Icon (CFBundleIcons → CFBundlePrimaryIcon)
    var appIcon: UIImage? {
        guard let icons = infoDictionary?["CFBundleIcons"] as? [String: Any],
              let primary = icons["CFBundlePrimaryIcon"] as? [String: Any],
              let files = primary["CFBundleIconFiles"] as? [String],
              let last = files.last else { return UIImage(named: "AppIcon") }
        return UIImage(named: last)
    }
}
