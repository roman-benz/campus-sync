// Zugang zur App mit demselben Passkey wie auf chadoodle.romanbenz.com (wie src/main/web-access.js).
// /app-login läuft in einer ASWebAuthenticationSession (dort funktionieren Passkeys), der Einmal-Code
// kommt an einen lokalen Rückruf auf 127.0.0.1 und wird (PKCE) gegen ein Sitzungstoken getauscht.
// Das Token liegt im Schlüsselbund. Widerruft der Admin die Sitzung, sperrt sich die App beim nächsten Start.
import AuthenticationServices
import CryptoKit
import Foundation
import Network
import SwiftUI

private let gateBase = URL(string: "https://chadoodle.romanbenz.com")!

@MainActor
final class AccessGate: ObservableObject {
    enum State { case checking, signedOut, signedIn }

    @Published private(set) var state: State = .checking
    @Published private(set) var busy = false
    @Published var error: String?

    private var auth: WebAuth?

    // Gespeicherte Sitzung prüfen. Ohne Netz bleibt die App offen (offline nutzbar); nur 401 sperrt.
    func restore() async {
        guard let token = Keychain.get("webSession") else {
            state = .signedOut
            return
        }
        state = .signedIn
        do {
            _ = try await gateAPI("/api/auth/me", token: token)
        } catch let e as HTTPError where e.status == 401 {
            Keychain.set("webSession", nil)
            state = .signedOut
        } catch {}
    }

    func login() async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let verifier = b64url(randomBytes(48))
            let challenge = b64url(Data(SHA256.hash(data: Data(verifier.utf8))))
            let state = b64url(randomBytes(24))
            let auth = WebAuth()
            self.auth = auth
            defer { self.auth = nil }
            let q = try await auth.run(callbackPath: "/callback") { port in
                var c = URLComponents(url: gateBase.appendingPathComponent("app-login"), resolvingAgainstBaseURL: false)!
                c.fragment = "port=\(port)&state=\(state)&challenge=\(challenge)"
                return c.url!
            }
            guard q["state"] == state, let code = q["code"], !code.isEmpty else {
                throw HTTPError(status: 0, message: "Ungültige Antwort der Anmeldung. Bitte erneut versuchen.")
            }
            let res = try await gateAPI("/api/auth/app/token", body: ["code": code, "verifier": verifier])
            guard let token = res["token"] as? String else { throw HTTPError(status: 0, message: "Kein Token erhalten") }
            Keychain.set("webSession", token)
            self.state = .signedIn
        } catch WebAuth.Cancelled.cancelled {
            // abgebrochen
        } catch {
            self.error = error.localizedDescription
        }
    }

    func logout() async {
        let token = Keychain.get("webSession")
        Keychain.set("webSession", nil)
        state = .signedOut
        if let token { _ = try? await gateAPI("/api/auth/logout", token: token, body: [:]) }
    }

    private func gateAPI(_ path: String, token: String? = nil, body: [String: String]? = nil) async throws -> [String: Any] {
        var req = URLRequest(url: URL(string: path, relativeTo: gateBase)!, timeoutInterval: 15)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, res) = try await URLSession.shared.data(for: req)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let status = (res as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw HTTPError(status: status, message: json["error"] as? String ?? "Fehler \(status)")
        }
        return json
    }
}

// ---------- Anmeldung im Systembrowser mit Rückruf an 127.0.0.1 ----------
// Für den Chadoodle-Zugang und „Sign in with ChatGPT“: Die Seite leitet nach der Anmeldung auf
// http://127.0.0.1:PORT/… um; ein kleiner Server in der App nimmt die Parameter entgegen.
@MainActor
final class WebAuth {
    enum Cancelled: Error { case cancelled }

    private var session: ASWebAuthenticationSession?
    private let anchor = PresentationAnchor()

    func run(callbackPath: String, ports: [UInt16] = [0], url makeURL: (UInt16) -> URL) async throws -> [String: String] {
        let server = LoopbackServer()
        var port: UInt16 = 0
        var lastError: Error?
        for p in ports {
            do {
                port = try await server.start(port: p)
                break
            } catch {
                lastError = error
            }
        }
        if port == 0 { throw lastError ?? HTTPError(status: 0, message: "Lokaler Rückruf konnte nicht gestartet werden") }
        defer { server.stop() }
        let url = makeURL(port)

        return try await withCheckedThrowingContinuation { cont in
            var done = false
            let finish: (Result<[String: String], Error>) -> Void = { [weak self] r in
                guard !done else { return }
                done = true
                self?.session?.cancel()
                self?.session = nil
                cont.resume(with: r)
            }
            server.onRequest = { path in
                guard let u = URLComponents(string: "http://127.0.0.1\(path)"), u.path == callbackPath else { return (404, "") }
                let q = Dictionary(u.queryItems?.map { ($0.name, $0.value ?? "") } ?? [], uniquingKeysWith: { a, _ in a })
                DispatchQueue.main.async { finish(.success(q)) }
                let ok = q["error"] == nil
                return (200, callbackPage(ok ? "Zurück zur App …" : "Anmeldung nicht abgeschlossen",
                                          ok ? "Chadoodle schließt die Anmeldung ab." : "Bitte in Chadoodle erneut versuchen.", ok: ok))
            }
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: "chadoodle-callback") { _, err in
                DispatchQueue.main.async {
                    if let e = err as? ASWebAuthenticationSessionError, e.code == .canceledLogin {
                        finish(.failure(Cancelled.cancelled))
                    } else {
                        finish(.failure(err ?? Cancelled.cancelled))
                    }
                }
            }
            s.presentationContextProvider = anchor
            s.prefersEphemeralWebBrowserSession = false
            session = s
            if !s.start() { finish(.failure(HTTPError(status: 0, message: "Anmeldefenster konnte nicht geöffnet werden"))) }
        }
    }
}

// ---------- Hilfen ----------

struct HTTPError: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
}

func randomBytes(_ n: Int) -> Data {
    var d = Data(count: n)
    _ = d.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, n, $0.baseAddress!) }
    return d
}

func b64url(_ d: Data) -> String {
    d.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

func fromB64url(_ s: String) -> Data? {
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while t.count % 4 != 0 { t += "=" }
    return Data(base64Encoded: t)
}

func formEncode(_ params: [(String, String)]) -> Data {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    return Data(params.map { "\($0.0.addingPercentEncoding(withAllowedCharacters: allowed)!)=\($0.1.addingPercentEncoding(withAllowedCharacters: allowed)!)" }
        .joined(separator: "&").utf8)
}

private func callbackPage(_ title: String, _ text: String, ok: Bool = true) -> String {
    """
    <!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>\(title)</title>
    <style>body{font-family:-apple-system,system-ui,sans-serif;background:#f4f6f9;color:#1d2125;display:grid;place-items:center;height:100vh;margin:0}
    .c{background:#fff;border:1px solid #e2e6ec;border-radius:18px;padding:32px 28px;max-width:420px;text-align:center}
    .i{width:52px;height:52px;border-radius:50%;margin:0 auto 14px;display:grid;place-items:center;font-size:26px;color:#fff;background:\(ok ? "#357a32" : "#ca3120")}
    h1{font-size:20px;margin:0 0 6px}p{color:#5f6871;margin:0}</style></head>
    <body><div class="c"><div class="i">\(ok ? "✓" : "!")</div><h1>\(title)</h1><p>\(text)</p></div></body></html>
    """
}

final class PresentationAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}

// Minimaler HTTP-Server auf 127.0.0.1 für Anmelde-Rückrufe
final class LoopbackServer: @unchecked Sendable {
    var onRequest: ((String) -> (Int, String))?
    private var listener: NWListener?

    func start(port: UInt16) async throws -> UInt16 {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: port == 0 ? .any : NWEndpoint.Port(rawValue: port)!)
        params.allowLocalEndpointReuse = true
        let listener = try NWListener(using: params)
        self.listener = listener
        listener.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
        return try await withCheckedThrowingContinuation { cont in
            var resumed = false
            listener.stateUpdateHandler = { state in
                guard !resumed else { return }
                switch state {
                case .ready:
                    resumed = true
                    cont.resume(returning: listener.port?.rawValue ?? port)
                case .failed(let e), .waiting(let e):
                    resumed = true
                    listener.cancel()
                    cont.resume(throwing: e)
                default: break
                }
            }
            listener.start(queue: .main)
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func handle(_ conn: NWConnection) {
        conn.start(queue: .main)
        conn.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] data, _, _, _ in
            let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let parts = (text.components(separatedBy: "\r\n").first ?? "").split(separator: " ")
            let path = parts.count > 1 ? String(parts[1]) : "/"
            let (status, body) = self?.onRequest?(path) ?? (404, "")
            let bytes = Data(body.utf8)
            let reason = status == 200 ? "OK" : "Not Found"
            let head = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(bytes.count)\r\nConnection: close\r\n\r\n"
            conn.send(content: Data(head.utf8) + bytes, completion: .contentProcessed { _ in conn.cancel() })
        }
    }
}

enum Keychain {
    private static func query(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "de.rbenz.chadoodle",
            kSecAttrAccount as String: account,
        ]
    }

    static func get(_ account: String) -> String? {
        var q = query(account)
        q[kSecReturnData as String] = true
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    static func set(_ account: String, _ value: String?) {
        SecItemDelete(query(account) as CFDictionary)
        guard let value else { return }
        var q = query(account)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(q as CFDictionary, nil)
    }

    static func getJSON<T: Decodable>(_ account: String, as: T.Type) -> T? {
        get(account).flatMap { try? JSONDecoder().decode(T.self, from: Data($0.utf8)) }
    }

    static func setJSON<T: Encodable>(_ account: String, _ value: T?) {
        set(account, value.flatMap { try? String(data: JSONEncoder().encode($0), encoding: .utf8) })
    }
}
