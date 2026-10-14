// KI-Lernassistent (ChatGPT): durchsucht die Unterlagen, Fundstellen öffnen sich im PDF-Viewer an der Seite.
import SwiftUI

struct AssistantView: View {
    @EnvironmentObject private var chatgpt: ChatGPTAuth
    @EnvironmentObject private var assistant: Assistant
    @State private var text = ""
    @State private var doc: DocLink?
    @State private var error: String?
    @FocusState private var focused: Bool

    struct DocLink: Identifiable {
        let fileId: String
        let page: Int?
        var id: String { "\(fileId)#\(page ?? 0)" }
    }

    var body: some View {
        NavigationStack {
            Group {
                if chatgpt.signedIn { chat } else { connect }
            }
            .navigationTitle("Assistent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if chatgpt.signedIn && !assistant.messages.isEmpty {
                    Button { assistant.reset() } label: { Image(systemName: "square.and.pencil") }
                }
            }
            .sheet(item: $doc) { d in
                NavigationStack { DocumentView(fileId: d.fileId, page: d.page).toolbar { Button("Fertig") { doc = nil } } }
            }
        }
    }

    private var connect: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "sparkles").font(.system(size: 48)).foregroundStyle(brand)
            Text("Lernassistent").font(.title2.bold())
            Text("Verbinde dein ChatGPT-Konto (Plus oder Pro). Der Assistent durchsucht deine Unterlagen, liest die passenden Seiten und erklärt sie – ohne API-Key.")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button {
                Task {
                    error = nil
                    do { try await chatgpt.login() } catch WebAuth.Cancelled.cancelled {} catch { self.error = error.localizedDescription }
                }
            } label: {
                HStack {
                    if chatgpt.busy { ProgressView().tint(.white) }
                    Text("Mit ChatGPT verbinden")
                }
                .frame(maxWidth: .infinity).padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .disabled(chatgpt.busy)
            if let error { Text(error).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center) }
            Spacer()
            Text("Nur Inhalte, die der Assistent für eine Antwort liest, gehen an OpenAI. Namen aus Foren und Noten nie. Kläre, ob deine Hochschule die Weitergabe von Kursunterlagen erlaubt.")
                .font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .padding(28)
    }

    private var chat: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if assistant.messages.isEmpty { suggestions }
                    ForEach(assistant.messages) { m in
                        MessageView(message: m, busy: assistant.busy && m.id == assistant.messages.last?.id)
                            .id(m.id)
                    }
                }
                .padding()
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: assistant.messages.last?.text) { _, _ in
                if let id = assistant.messages.last?.id { proxy.scrollTo(id, anchor: .bottom) }
            }
            .environment(\.openURL, OpenURLAction { url in
                guard url.scheme == "doc", let id = url.host else { return .systemAction }
                let page = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "page" }?.value.flatMap(Int.init)
                doc = DocLink(fileId: id, page: page)
                return .handled
            })
            .safeAreaInset(edge: .bottom) { inputBar }
        }
    }

    private var suggestions: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Frag etwas zu deinen Unterlagen").font(.headline)
            ForEach(["Was ist diese Woche fällig?", "Erkläre mir die wichtigsten Formeln aus dem letzten Skript", "Wann habe ich morgen Vorlesung und was gibt es in der Mensa?"], id: \.self) { s in
                Button { assistant.send(s) } label: {
                    Text(s).font(.callout).multilineTextAlignment(.leading).padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, 8)
    }

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Nachricht", text: $text, axis: .vertical)
                .lineLimit(1...5)
                .focused($focused)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
            if assistant.busy {
                Button { assistant.stop() } label: { Image(systemName: "stop.circle.fill").font(.title) }
            } else {
                Button {
                    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !t.isEmpty else { return }
                    text = ""
                    assistant.send(t)
                } label: { Image(systemName: "arrow.up.circle.fill").font(.title) }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(.horizontal).padding(.vertical, 8)
        .background(.bar)
    }
}

struct MessageView: View {
    let message: ChatMessage
    let busy: Bool
    @State private var showThinking = false

    var body: some View {
        if message.role == .user {
            HStack {
                Spacer(minLength: 40)
                Text(message.text).padding(.horizontal, 14).padding(.vertical, 10)
                    .background(brand, in: RoundedRectangle(cornerRadius: 18))
                    .foregroundStyle(.white)
                    .textSelection(.enabled)
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(message.tools.enumerated()), id: \.offset) { _, t in
                    Label(t, systemImage: "wrench.and.screwdriver").font(.caption).foregroundStyle(.secondary)
                }
                if !message.thinking.isEmpty {
                    DisclosureGroup(isExpanded: $showThinking) {
                        Text(message.thinking).font(.caption).foregroundStyle(.secondary)
                    } label: { Label("Überlegungen", systemImage: "brain").font(.caption) }
                }
                if !message.text.isEmpty { MarkdownText(message.text) }
                if busy && message.text.isEmpty { ProgressView().padding(.vertical, 4) }
                if let e = message.error { Label(e, systemImage: "exclamationmark.triangle.fill").font(.callout).foregroundStyle(.orange) }
            }
        }
    }
}

// Schlichtes Markdown: Überschriften, Listen, Code-Blöcke und Inline-Formatierung (fett, kursiv, Code, Links)
struct MarkdownText: View {
    let blocks: [(kind: String, text: String)]

    init(_ md: String) {
        var out: [(String, String)] = []
        var code: [String]?
        for line in md.components(separatedBy: "\n") {
            if line.hasPrefix("```") {
                if let c = code { out.append(("code", c.joined(separator: "\n"))); code = nil } else { code = [] }
                continue
            }
            if code != nil { code!.append(line); continue }
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { out.append(("space", "")) }
            else if let m = t.range(of: "^#{1,6}\\s+", options: .regularExpression) { out.append(("h", String(t[m.upperBound...]))) }
            else if let m = t.range(of: "^[-*•]\\s+", options: .regularExpression) { out.append(("li", String(t[m.upperBound...]))) }
            else if t.range(of: "^\\d+[.)]\\s+", options: .regularExpression) != nil { out.append(("ol", t)) }
            else { out.append(("p", line)) }
        }
        if let c = code { out.append(("code", c.joined(separator: "\n"))) }
        blocks = out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in
                switch b.kind {
                case "h": Text(inline(b.text)).font(.headline).padding(.top, 4)
                case "li": HStack(alignment: .firstTextBaseline, spacing: 6) { Text("•"); Text(inline(b.text)) }
                case "ol": Text(inline(b.text))
                case "code":
                    ScrollView(.horizontal) { Text(b.text).font(.system(.caption, design: .monospaced)).padding(10) }
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
                case "space": Color.clear.frame(height: 2)
                default: Text(inline(b.text))
                }
            }
        }
        .textSelection(.enabled)
    }

    private func inline(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}
