// Moodle-Webservice-Client (gleiche Schnittstelle wie die offizielle Moodle-App, wie src/main/moodle.js).
import AuthenticationServices
import CryptoKit
import Foundation

let moodleService = "moodle_mobile_app"
let moodleScheme = "moodlemobile"

struct MoodleError: LocalizedError {
    let message: String
    var code: String? = nil
    var errorDescription: String? { message }
}

func normalizeSite(_ url: String) -> String {
    var u = url.trimmingCharacters(in: .whitespacesAndNewlines)
    if u.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) == nil { u = "https://" + u }
    while u.hasSuffix("/") { u.removeLast() }
    return u
}

// Moodle erwartet Arrays/Objekte in PHP-Notation: courseids[0]=1&options[0][name]=x
private func encodeParams(_ value: Any, _ prefix: String, _ out: inout [(String, String)]) {
    switch value {
    case let d as [String: Any]:
        for (k, v) in d { encodeParams(v, prefix.isEmpty ? k : "\(prefix)[\(k)]", &out) }
    case let a as [Any]:
        for (i, v) in a.enumerated() { encodeParams(v, "\(prefix)[\(i)]", &out) }
    case let b as Bool:
        out.append((prefix, b ? "1" : "0"))
    default:
        out.append((prefix, "\(value)"))
    }
}

struct MoodleAccount: Codable {
    var siteUrl: String
    var token: String
    var privateToken: String?
}

struct MoodleClient {
    let siteUrl: String
    let token: String
    let privateToken: String?
    var userid: Int?

    init(_ a: MoodleAccount) {
        siteUrl = normalizeSite(a.siteUrl)
        token = a.token
        privateToken = a.privateToken
    }

    func call(_ wsfunction: String, _ params: [String: Any] = [:]) async throws -> Any {
        var body: [(String, String)] = []
        encodeParams(params, "", &body)
        body.append(("wstoken", token))
        body.append(("wsfunction", wsfunction))
        var req = URLRequest(url: URL(string: "\(siteUrl)/webservice/rest/server.php?moodlewsrestformat=json&wsfunction=\(wsfunction)")!, timeoutInterval: 60)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.httpBody = formEncode(body)
        let (data, res) = try await URLSession.shared.data(for: req)
        if let http = res as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw MoodleError(message: "HTTP \(http.statusCode) bei \(wsfunction)", code: "http")
        }
        let json = try JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed)
        if let d = json as? [String: Any], d["exception"] != nil {
            throw MoodleError(message: (d["message"] as? String) ?? (d["errorcode"] as? String) ?? "Moodle-Fehler", code: d["errorcode"] as? String)
        }
        return json
    }

    // Gehört die URL zu dieser Moodle-Seite? (https://moodle.x.de.evil.com beginnt auch mit https://moodle.x.de)
    func isSiteUrl(_ url: String) -> Bool {
        guard let u = URL(string: url), let site = URL(string: siteUrl) else { return false }
        let base = site.path.hasSuffix("/") ? String(site.path.dropLast()) : site.path
        return u.scheme == site.scheme && u.host == site.host && u.port == site.port &&
            (base.isEmpty || u.path == base || u.path.hasPrefix(base + "/"))
    }

    // pluginfile.php → webservice/pluginfile.php mit Token; das Token geht nie an fremde Server
    func fileUrl(_ url: String) throws -> URL {
        guard isSiteUrl(url) else { throw MoodleError(message: "Adresse gehört nicht zu dieser Moodle-Seite", code: "foreignurl") }
        guard url.contains("/pluginfile.php/") else { return URL(string: url)! }
        var u = url.replacingOccurrences(of: "/pluginfile.php/", with: "/webservice/pluginfile.php/")
        u = u.replacingOccurrences(of: "/webservice/webservice/", with: "/webservice/")
        let t = token.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? token
        return URL(string: u + (u.contains("?") ? "&" : "?") + "token=" + t)!
    }

    func download(_ url: String, to dest: URL) async throws {
        let (tmp, res) = try await URLSession.shared.download(from: try fileUrl(url))
        let http = res as? HTTPURLResponse
        guard let http, (200..<300).contains(http.statusCode) else {
            throw MoodleError(message: "Download fehlgeschlagen (HTTP \(http?.statusCode ?? 0))", code: "http")
        }
        // Moodle liefert Fehler als JSON statt als Datei
        if (http.value(forHTTPHeaderField: "Content-Type") ?? "").contains("application/json") {
            let d = (try? JSONSerialization.jsonObject(with: Data(contentsOf: tmp))) as? [String: Any] ?? [:]
            throw MoodleError(message: (d["error"] as? String) ?? (d["message"] as? String) ?? "Download verweigert", code: d["errorcode"] as? String)
        }
        let fm = FileManager.default
        try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? fm.removeItem(at: dest)
        try fm.moveItem(at: tmp, to: dest)
    }

    // Ein-Klick-Login im Browser für Seiten, die es nur online gibt (Tests, Abgaben)
    func autologinUrl(_ target: String) async -> URL? {
        guard let privateToken, let userid else { return URL(string: target) }
        do {
            let r = try await call("tool_mobile_get_autologin_key", ["privatetoken": privateToken]) as? [String: Any]
            guard let base = r?["autologinurl"] as? String, let key = r?["key"] as? String, var c = URLComponents(string: base) else { return URL(string: target) }
            c.queryItems = (c.queryItems ?? []) + [
                URLQueryItem(name: "userid", value: String(userid)),
                URLQueryItem(name: "key", value: key),
                URLQueryItem(name: "urltogo", value: target),
            ]
            return c.url
        } catch {
            return URL(string: target) // Moodle drosselt Autologin (max. 1x alle 6 Minuten)
        }
    }
}

func moodlePublicConfig(_ siteUrl: String) async throws -> [String: Any] {
    let args = #"[{"index":0,"methodname":"tool_mobile_get_public_config","args":{}}]"#
    let q = args.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
    var req = URLRequest(url: URL(string: "\(normalizeSite(siteUrl))/lib/ajax/service-nologin.php?args=\(q)")!, timeoutInterval: 20)
    req.httpMethod = "POST"
    let (data, _) = try await URLSession.shared.data(for: req)
    guard let arr = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]], let first = arr.first,
          (first["error"] as? Bool) != true, let cfg = first["data"] as? [String: Any] else {
        throw MoodleError(message: "Keine Moodle-Seite oder Mobile-Dienst deaktiviert")
    }
    return cfg
}

func moodleLoginWithPassword(siteUrl: String, username: String, password: String) async throws -> MoodleAccount {
    var req = URLRequest(url: URL(string: "\(normalizeSite(siteUrl))/login/token.php")!, timeoutInterval: 30)
    req.httpMethod = "POST"
    req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    req.httpBody = formEncode([("username", username), ("password", password), ("service", moodleService)])
    let (data, _) = try await URLSession.shared.data(for: req)
    let d = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    guard let token = d["token"] as? String else {
        throw MoodleError(message: (d["error"] as? String) ?? "Anmeldung fehlgeschlagen", code: d["errorcode"] as? String)
    }
    return MoodleAccount(siteUrl: normalizeSite(siteUrl), token: token, privateToken: d["privatetoken"] as? String)
}

// SSO (Shibboleth, Microsoft, …): Moodle-Login im Systembrowser; launch.php leitet danach auf
// moodlemobile://token=BASE64 um – das fängt ASWebAuthenticationSession direkt ab.
// Moodle signiert die Antwort mit md5(wwwroot + passport); ohne passende Signatur wird das Token verworfen.
@MainActor
final class MoodleSSO {
    private var session: ASWebAuthenticationSession?
    private let anchor = PresentationAnchor()

    func login(siteUrl: String) async throws -> MoodleAccount {
        let site = normalizeSite(siteUrl)
        let passport = randomBytes(16).map { String(format: "%02x", $0) }.joined()
        var roots: Set<String> = [site]
        if let cfg = try? await moodlePublicConfig(site) {
            for key in ["wwwroot", "httpswwwroot"] {
                if var r = cfg[key] as? String {
                    while r.hasSuffix("/") { r.removeLast() }
                    roots.insert(r)
                }
            }
        }
        let valid = Set(roots.map { md5Hex($0 + passport) })
        let launch = URL(string: "\(site)/admin/tool/mobile/launch.php?service=\(moodleService)&passport=\(passport)&urlscheme=\(moodleScheme)")!

        let callback: URL = try await withCheckedThrowingContinuation { cont in
            let s = ASWebAuthenticationSession(url: launch, callbackURLScheme: moodleScheme) { url, err in
                if let url { cont.resume(returning: url) } else {
                    cont.resume(throwing: (err as? ASWebAuthenticationSessionError)?.code == .canceledLogin
                        ? MoodleError(message: "Anmeldung abgebrochen", code: "cancelled")
                        : (err ?? MoodleError(message: "Anmeldung fehlgeschlagen")))
                }
            }
            s.presentationContextProvider = anchor
            s.prefersEphemeralWebBrowserSession = false
            session = s
            if !s.start() { cont.resume(throwing: MoodleError(message: "Anmeldefenster konnte nicht geöffnet werden")) }
        }
        session = nil
        let (token, priv) = try parseLaunchToken(callback.absoluteString, valid: valid)
        return MoodleAccount(siteUrl: site, token: token, privateToken: priv)
    }
}

func md5Hex(_ s: String) -> String {
    Insecure.MD5.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
}

func parseLaunchToken(_ url: String, valid: Set<String>) throws -> (String, String?) {
    guard let r = url.range(of: "^moodlemobile://token=([^&#]+)", options: [.regularExpression, .caseInsensitive]) else {
        throw MoodleError(message: "Moodle hat kein Zugriffstoken geliefert.", code: "notoken")
    }
    let raw = String(url[r]).replacingOccurrences(of: "moodlemobile://token=", with: "", options: .caseInsensitive)
    let b64 = raw.removingPercentEncoding ?? raw
    var padded = b64
    while padded.count % 4 != 0 { padded += "=" }
    guard let data = Data(base64Encoded: padded), let decoded = String(data: data, encoding: .utf8) else {
        throw MoodleError(message: "Antwort der Anmeldung ist ungültig.", code: "badsignature")
    }
    let parts = decoded.components(separatedBy: ":::")
    guard let sig = parts.first, valid.contains(sig) else {
        throw MoodleError(message: "Antwort der Anmeldung ist ungültig (Signatur passt nicht). Bitte erneut versuchen.", code: "badsignature")
    }
    guard parts.count > 1, !parts[1].isEmpty else { throw MoodleError(message: "Moodle hat kein Zugriffstoken geliefert.", code: "notoken") }
    return (parts[1], parts.count > 2 && !parts[2].isEmpty ? parts[2] : nil)
}

// ---------- Lockeres Lesen von JSON (Moodle liefert Zahlen mal als Zahl, mal als Text) ----------
func jInt(_ v: Any?) -> Int? {
    switch v {
    case let i as Int: return i
    case let d as Double: return Int(d)
    case let s as String: return Int(s)
    case let b as Bool: return b ? 1 : 0
    default: return nil
    }
}

func jDouble(_ v: Any?) -> Double? {
    switch v {
    case let d as Double: return d
    case let i as Int: return Double(i)
    case let s as String: return Double(s.replacingOccurrences(of: ",", with: "."))
    default: return nil
    }
}

func jStr(_ v: Any?) -> String? {
    switch v {
    case let s as String: return s
    case let i as Int: return String(i)
    case let d as Double: return String(d)
    default: return nil
    }
}

func jBool(_ v: Any?) -> Bool {
    switch v {
    case let b as Bool: return b
    case let i as Int: return i != 0
    case let s as String: return s == "1" || s == "true"
    default: return false
    }
}
