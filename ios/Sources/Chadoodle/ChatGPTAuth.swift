// „Sign in with ChatGPT“ mit ChatGPT-Plan-Nutzung (OAuth 2.0 + PKCE, Loopback-Redirect), wie src/main/chatgpt-auth.js.
// Erste Anmeldung registriert die App dynamisch (dynamic_agent_client); die vergebene client_id
// wird pro Konto gespeichert und bei späteren Anmeldungen wiederverwendet.
// Doku: https://developers.openai.com/siwc/token-sharing-open-source
import CryptoKit
import Foundation

private let issuer = "https://auth.openai.com"
private let authURL = "\(issuer)/api/accounts/authorize"
private let tokenURL = "\(issuer)/api/accounts/oauth/token"
private let resource = "https://api.openai.com/v1"
private let scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
let planScope = "chatgpt.tokens.use.direct"
private let refreshFail: Set<String> = ["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_invalidated", "refresh_token_reused"]

struct ChatGPTAccount: Codable {
    var clientId: String
    var sub: String?
    var email: String?
    var name: String?
    var idToken: String?
    var accessToken: String?
    var refreshToken: String?
    var expiresAt: Double = 0
    var lastRefresh: Double = 0
    var scope: String = ""
}

struct OAuthError: LocalizedError {
    let message: String
    var code: String?
    var errorDescription: String? { message }
}

@MainActor
final class ChatGPTAuth: ObservableObject {
    @Published private(set) var account: ChatGPTAccount?
    @Published private(set) var busy = false
    private var refreshing: Task<String, Error>?
    private var web: WebAuth?

    init() {
        account = Keychain.getJSON("chatgptAccount", as: ChatGPTAccount.self)
    }

    var signedIn: Bool { account?.refreshToken != nil }
    var planUsage: Bool { account?.scope.split(separator: " ").contains(Substring(planScope)) ?? false }

    private var hostId: String {
        if let id = UserDefaults.standard.string(forKey: "chatgptHostId") { return id }
        let id = "urn:uuid:\(UUID().uuidString.lowercased())"
        UserDefaults.standard.set(id, forKey: "chatgptHostId")
        return id
    }

    private func save(_ a: ChatGPTAccount?) {
        account = a
        Keychain.setJSON("chatgptAccount", a)
    }

    // Liefert der Code-Tausch invalid_grant, wird – wie von OpenAI empfohlen – mit der bereits
    // vergebenen client_id einmal automatisch neu autorisiert.
    func login() async throws {
        busy = true
        defer { busy = false }
        var prev = account
        for attempt in 1...2 {
            do {
                try await authorizeOnce(prev)
                return
            } catch let e as OAuthError where e.code == "invalid_grant" && attempt == 1 {
                prev = account // enthält jetzt die vergebene client_id
            }
        }
    }

    private func authorizeOnce(_ prev: ChatGPTAccount?) async throws {
        let verifier = b64url(randomBytes(48))
        let challenge = b64url(Data(sha256(Data(verifier.utf8))))
        let state = b64url(randomBytes(24))
        let nonce = b64url(randomBytes(24))
        let reuse = prev != nil
        var redirectUri = ""

        let web = WebAuth()
        self.web = web
        defer { self.web = nil }
        let q = try await web.run(callbackPath: "/auth/callback", ports: [1455, 1456, 1457, 1458, 1459, 0]) { port in
            redirectUri = "http://127.0.0.1:\(port)/auth/callback"
            var c = URLComponents(string: authURL)!
            var items = [
                URLQueryItem(name: "client_id", value: prev?.clientId ?? "dynamic_agent_client"),
                URLQueryItem(name: "response_type", value: "code"),
                URLQueryItem(name: "redirect_uri", value: redirectUri),
                URLQueryItem(name: "scope", value: scopes),
                URLQueryItem(name: "resource", value: resource),
                URLQueryItem(name: "state", value: state),
                URLQueryItem(name: "nonce", value: nonce),
                URLQueryItem(name: "code_challenge_method", value: "S256"),
                URLQueryItem(name: "code_challenge", value: challenge),
                URLQueryItem(name: "ext_agent_host_id", value: hostId),
            ]
            if let prev {
                if let t = prev.idToken { items.append(URLQueryItem(name: "id_token_hint", value: t)) }
                if let e = prev.email { items.append(URLQueryItem(name: "login_hint", value: e)) }
            } else {
                items.append(URLQueryItem(name: "agent_name_hint", value: "Chadoodle"))
            }
            c.queryItems = items
            // „+“ in Werten (z. B. Scopes) sicher kodieren
            c.percentEncodedQuery = c.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
            return c.url!
        }
        if let err = q["error"] { throw OAuthError(message: q["error_description"] ?? err, code: err) }
        guard q["state"] == state, let code = q["code"] else { throw OAuthError(message: "Ungültiger OAuth-Rückruf") }

        // Neue Registrierung liefert die vergebene client_id im Rückruf – niemals dynamic_agent_client speichern
        let cbClient = q["client_id"].flatMap { $0 == "dynamic_agent_client" ? nil : $0 }
        guard let clientId = cbClient ?? (reuse ? prev!.clientId : nil) else { throw OAuthError(message: "Keine client_id von OpenAI erhalten") }
        if !reuse || clientId != prev!.clientId { save(ChatGPTAccount(clientId: clientId)) }

        let tok = try await tokenRequest([("grant_type", "authorization_code"), ("client_id", clientId), ("code", code),
                                          ("code_verifier", verifier), ("redirect_uri", redirectUri), ("resource", resource)])
        // Das ID-Token kommt direkt per TLS vom Token-Endpunkt (OIDC Core 3.1.3.7); geprüft werden Aussteller, Zielgruppe und nonce.
        guard let idToken = tok["id_token"] as? String else { throw OAuthError(message: "Kein ID-Token erhalten") }
        let parts = idToken.split(separator: ".")
        guard parts.count == 3, let payload = fromB64url(String(parts[1])),
              let claims = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any] else { throw OAuthError(message: "Ungültiges ID-Token") }
        let aud = (claims["aud"] as? [String]) ?? [(claims["aud"] as? String) ?? ""]
        guard claims["iss"] as? String == issuer else { throw OAuthError(message: "ID-Token: falscher Aussteller") }
        guard aud.contains(clientId) else { throw OAuthError(message: "ID-Token: falsche Zielgruppe") }
        guard claims["nonce"] as? String == nonce else { throw OAuthError(message: "ID-Token: nonce passt nicht") }

        let scope = (tok["scope"] as? String) ?? q["scope"] ?? ""
        let now = Date().timeIntervalSince1970 * 1000
        save(ChatGPTAccount(clientId: clientId, sub: claims["sub"] as? String, email: claims["email"] as? String,
                            name: (claims["name"] as? String) ?? (claims["email"] as? String), idToken: idToken,
                            accessToken: tok["access_token"] as? String, refreshToken: tok["refresh_token"] as? String,
                            expiresAt: now + (jDouble(tok["expires_in"]) ?? 3600) * 1000, lastRefresh: now, scope: scope))
        if !scope.split(separator: " ").contains(Substring(planScope)) {
            throw OAuthError(message: "Die Nutzung deines ChatGPT-Plans wurde nicht freigegeben (oder dein Plan ist dafür nicht berechtigt).", code: "no_plan_scope")
        }
    }

    private func tokenRequest(_ form: [(String, String)]) async throws -> [String: Any] {
        var req = URLRequest(url: URL(string: tokenURL)!, timeoutInterval: 30)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.httpBody = formEncode(form)
        let (data, res) = try await URLSession.shared.data(for: req)
        let d = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let status = (res as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw OAuthError(message: (d["error_description"] as? String) ?? (d["error"] as? String) ?? "Token-Anfrage fehlgeschlagen (HTTP \(status))", code: d["error"] as? String)
        }
        return d
    }

    // Gültiges Access-Token (wird bei Bedarf – serialisiert – erneuert)
    func accessToken(force: Bool = false) async throws -> String {
        guard let a = account, let refresh = a.refreshToken else { throw OAuthError(message: "Nicht mit ChatGPT angemeldet.", code: "auth_required") }
        if !force, let t = a.accessToken, a.expiresAt - 120_000 > Date().timeIntervalSince1970 * 1000 { return t }
        if let r = refreshing { return try await r.value }
        let task = Task { () throws -> String in
            do {
                let tok = try await tokenRequest([("grant_type", "refresh_token"), ("client_id", a.clientId), ("refresh_token", refresh), ("resource", resource)])
                var next = a
                next.accessToken = tok["access_token"] as? String
                next.refreshToken = (tok["refresh_token"] as? String) ?? refresh
                next.idToken = (tok["id_token"] as? String) ?? a.idToken
                next.expiresAt = Date().timeIntervalSince1970 * 1000 + (jDouble(tok["expires_in"]) ?? 3600) * 1000
                next.lastRefresh = Date().timeIntervalSince1970 * 1000
                next.scope = (tok["scope"] as? String) ?? a.scope
                save(next)
                return next.accessToken ?? ""
            } catch let e as OAuthError where refreshFail.contains(e.code ?? "") {
                var next = a
                next.accessToken = nil
                next.refreshToken = nil
                save(next)
                throw OAuthError(message: "Deine ChatGPT-Anmeldung ist abgelaufen – bitte erneut anmelden.", code: "auth_required")
            }
        }
        refreshing = task
        defer { refreshing = nil }
        return try await task.value
    }

    // Angemeldet bleiben: OpenAIs Refresh-Token verfällt nach 30 Tagen ohne Nutzung → spätestens alle 5 Tage erneuern
    func keepAlive() async {
        guard let a = account, a.refreshToken != nil, Date().timeIntervalSince1970 * 1000 - a.lastRefresh > 5 * 86_400_000 else { return }
        _ = try? await accessToken(force: true)
    }

    // Abmelden: Refresh-Token widerrufen, Registrierung (client_id) für die nächste Anmeldung behalten
    func logout() async {
        guard let a = account else { return }
        if let rt = a.refreshToken,
           let resp = try? await URLSession.shared.data(from: URL(string: "\(issuer)/.well-known/openid-configuration")!),
           let cfg = (try? JSONSerialization.jsonObject(with: resp.0)) as? [String: Any],
           let rev = cfg["revocation_endpoint"] as? String, let url = URL(string: rev) {
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            req.httpBody = formEncode([("token", rt), ("token_type_hint", "refresh_token"), ("client_id", a.clientId)])
            _ = try? await URLSession.shared.data(for: req)
        }
        save(ChatGPTAccount(clientId: a.clientId, sub: a.sub, email: a.email, name: a.name, idToken: a.idToken))
    }
}

private func sha256(_ d: Data) -> SHA256.Digest { SHA256.hash(data: d) }
