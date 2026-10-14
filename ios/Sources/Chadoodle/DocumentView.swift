// Dokumente in der App: PDFs mit PDFKit (Zoom, Seitensprung, Suche, markierbarer Text),
// alles andere (Word, PowerPoint, Excel, Bilder, …) mit QuickLook.
import PDFKit
import QuickLook
import SwiftUI

struct DocumentView: View {
    @EnvironmentObject private var app: AppModel
    let fileId: String
    var page: Int?

    @State private var file: LocalFile?
    @State private var error: String?
    @StateObject private var pdf = PDFController()
    @State private var searching = false
    @State private var query = ""

    var body: some View {
        Group {
            if let file {
                if file.ext == "pdf" {
                    PDFKitView(url: file.localURL, page: page, controller: pdf)
                        .ignoresSafeArea(edges: .bottom)
                } else {
                    QuickLookView(url: file.localURL).ignoresSafeArea(edges: .bottom)
                }
            } else if let error {
                ContentUnavailableView("Datei nicht verfügbar", systemImage: "exclamationmark.icloud", description: Text(error))
            } else {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Lade \(app.cache.files[fileId]?.filename ?? "Datei")…").font(.callout).foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle(app.cache.files[fileId]?.filename ?? "Dokument")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let file {
                if file.ext == "pdf" {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { searching.toggle() } label: { Image(systemName: "magnifyingglass") }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: file.localURL) { Image(systemName: "square.and.arrow.up") }
                }
            }
        }
        .safeAreaInset(edge: .top) {
            if searching {
                HStack {
                    TextField("Im Dokument suchen", text: $query).textFieldStyle(.roundedBorder).submitLabel(.search)
                        .onSubmit { pdf.find(query) }
                    Button { pdf.find(query, backwards: true) } label: { Image(systemName: "chevron.up") }
                    Button { pdf.find(query) } label: { Image(systemName: "chevron.down") }
                    Text(pdf.status).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                .padding(.horizontal).padding(.vertical, 8)
                .background(.bar)
            }
        }
        .task(id: fileId) {
            do { file = try await app.ensureFile(fileId) } catch { self.error = error.localizedDescription }
        }
    }
}

@MainActor
final class PDFController: ObservableObject {
    weak var view: PDFView?
    @Published var status = ""
    private var lastQuery = ""
    private var results: [PDFSelection] = []
    private var current = -1

    func find(_ q: String, backwards: Bool = false) {
        guard let view, let doc = view.document, !q.isEmpty else { return }
        if q != lastQuery {
            lastQuery = q
            results = doc.findString(q, withOptions: [.caseInsensitive, .diacriticInsensitive])
            current = -1
        }
        guard !results.isEmpty else {
            status = "0"
            return
        }
        current = backwards ? (current - 1 + results.count) % results.count : (current + 1) % results.count
        let sel = results[current]
        sel.color = .systemYellow
        view.setCurrentSelection(sel, animate: true)
        view.go(to: sel)
        status = "\(current + 1)/\(results.count)"
    }
}

struct PDFKitView: UIViewRepresentable {
    let url: URL
    let page: Int?
    let controller: PDFController

    func makeUIView(context: Context) -> PDFView {
        let v = PDFView()
        v.autoScales = true
        v.displayMode = .singlePageContinuous
        v.displayDirection = .vertical
        v.usePageViewController(false)
        v.pageShadowsEnabled = true
        v.document = PDFDocument(url: url)
        controller.view = v
        if let page, let p = v.document?.page(at: max(0, page - 1)) {
            DispatchQueue.main.async { v.go(to: p) }
        }
        return v
    }

    func updateUIView(_ v: PDFView, context: Context) {}
}

struct QuickLookView: UIViewControllerRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let vc = QLPreviewController()
        vc.dataSource = context.coordinator
        return vc
    }

    func updateUIViewController(_ vc: QLPreviewController, context: Context) {}

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}
