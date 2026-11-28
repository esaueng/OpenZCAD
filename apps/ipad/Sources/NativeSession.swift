import CryptoKit
import Foundation
import Security

/// The cloud account the app signs in to (ADR-026, "Session"). The app reuses
/// the macOS app's PKCE device authorization at `/api/auth/desktop/*` under
/// its own client id. The refresh token lives in the Keychain and the access
/// token in this process's memory; neither ever enters the WebView.
enum NativeAPI {
    /// One app, on `zcad.app` only (owner decision, 2026-11-26).
    static let origin = URL(string: "https://zcad.app")!
    static let clientId = "openzcad-ios"
    static let refreshSkew: TimeInterval = 30
    static let maxPrepared = 64
}

/// The session's failures, each with copy the web app can show as is.
struct NativeSessionError: LocalizedError, Equatable {
    let message: String
    var errorDescription: String? { message }
    static let unreachable = NativeSessionError(message: "The OpenZCAD cloud service could not be reached.")
    static let invalidResponse = NativeSessionError(message: "The OpenZCAD sign-in response was invalid.")
    static let keychain = NativeSessionError(message: "OpenZCAD could not use the Keychain on this device.")
}

/// Where the refresh token is kept: the Keychain in the app, memory in tests.
protocol RefreshTokenStore: AnyObject {
    func load() throws -> String?
    func save(_ token: String) throws
    func delete() throws
}

/// A generic-password item for this bundle, `ios-refresh`, readable after the
/// first unlock and never synchronised or restored to another device.
final class KeychainRefreshTokenStore: RefreshTokenStore {
    private let service: String
    private let account = "ios-refresh"

    init(service: String = Bundle.main.bundleIdentifier ?? "app.esau.openzcad.ios") {
        self.service = service
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: false]
    }

    func load() throws -> String? {
        var item = query
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(item as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let token = String(data: data, encoding: .utf8) else { throw NativeSessionError.keychain }
        return token
    }

    func save(_ token: String) throws {
        let data = Data(token.utf8)
        let update: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item.merge(update) { _, new in new }
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw NativeSessionError.keychain }
    }

    func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw NativeSessionError.keychain }
    }

    /// Keychain items outlive the app. A first launch after an install
    /// (no marker yet) deletes one an earlier install left behind.
    static func removeLeftoverAfterInstall(defaults: UserDefaults = .standard, store: RefreshTokenStore) {
        let marker = "openzcad.native-session.installed:v1"
        guard !defaults.bool(forKey: marker) else { return }
        try? store.delete()
        defaults.set(true, forKey: marker)
    }
}

/// A refresh token held in memory only: UI tests and unit tests.
final class MemoryRefreshTokenStore: RefreshTokenStore {
    private var token: String?
    func load() throws -> String? { token }
    func save(_ token: String) throws { self.token = token }
    func delete() throws { token = nil }
}

/// A sign-in attempt between `start` and its exchange. The verifier never
/// leaves this process.
struct PendingSignIn {
    let attemptId: String
    let state: String
    let verifier: String
    let userCode: String
    let browserURL: URL
    let expiresAt: TimeInterval
}

@MainActor
final class NativeSession {
    private struct Access { let token: String; let expiresAt: TimeInterval }
    private struct Prepared { let token: String; let expiresAt: TimeInterval; let generation: Int; let issued: Int }

    let store: RefreshTokenStore
    let http: NativeHTTP
    private let now: () -> TimeInterval
    /// Each sign-in and each sign-out starts a new generation. A refresh or
    /// a readied credential from an earlier one never touches the current.
    private(set) var generation = 0
    private var access: Access?
    private var refreshing: (generation: Int, task: Task<String?, Error>)?
    private var prepared: [String: Prepared] = [:]
    private var issued = 0

    init(store: RefreshTokenStore, http: NativeHTTP = NativeHTTP(),
         now: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 }) {
        self.store = store
        self.http = http
        self.now = now
    }

    /// Signed in while a refresh token is held. Says nothing else.
    var signedIn: Bool { access != nil || ((try? store.load()) ?? nil) != nil }

    /// Ends the session in memory: the access token, readied credentials and
    /// any refresh in flight belong to the old generation from here on.
    func endSession() {
        generation += 1
        access = nil
        prepared.removeAll()
        refreshing = nil
    }

    /// Ends the session and deletes the refresh token, whether or not the
    /// server heard about it.
    func forgetSession() {
        endSession()
        try? store.delete()
    }

    // MARK: Sign-in

    func start() async throws -> PendingSignIn {
        let verifier = Self.randomSecret()
        let state = Self.randomSecret()
        let (data, response) = try await http.postJSON("/api/auth/desktop/start", [
            "clientId": NativeAPI.clientId, "state": state, "codeChallenge": Self.pkceChallenge(verifier)
        ])
        guard (200..<300).contains(response.statusCode) else {
            throw NativeHTTP.serverError(data, fallback: "Sign-in is unavailable.")
        }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let attemptId = object["attemptId"] as? String,
              let browser = object["browserUrl"] as? String,
              let userCode = object["userCode"] as? String,
              let expiresIn = object["expiresInSeconds"] as? Double, expiresIn > 0, expiresIn <= 3600,
              let browserURL = Self.approvedBrowserURL(browser, attemptId: attemptId)
        else { throw NativeSessionError.invalidResponse }
        return PendingSignIn(attemptId: attemptId, state: state, verifier: verifier, userCode: userCode,
                             browserURL: browserURL, expiresAt: now() + expiresIn)
    }

    /// One exchange attempt: false while the browser has not approved yet,
    /// true once a new session is installed.
    func exchange(_ pending: PendingSignIn) async throws -> Bool {
        guard pending.expiresAt > now() else {
            throw NativeSessionError(message: "The sign-in attempt expired. Start again.")
        }
        let (data, response) = try await http.postJSON("/api/auth/desktop/exchange", [
            "attemptId": pending.attemptId, "clientId": NativeAPI.clientId,
            "state": pending.state, "verifier": pending.verifier
        ])
        if response.statusCode == 202 {
            guard (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["status"] as? String == "pending"
            else { throw NativeSessionError.invalidResponse }
            return false
        }
        guard (200..<300).contains(response.statusCode) else {
            throw NativeHTTP.serverError(data, fallback: "Sign-in failed.")
        }
        // A new session: nothing readied in an earlier one is sent with it.
        endSession()
        try install(data)
        return true
    }

    private func install(_ data: Data) throws {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["status"] as? String == "authorized",
              let accessToken = object["accessToken"] as? String, accessToken.count == 43,
              let refreshToken = object["refreshToken"] as? String, refreshToken.count == 43,
              let accessExpiresAt = object["accessExpiresAt"] as? Double,
              let refreshExpiresAt = object["refreshExpiresAt"] as? Double,
              refreshExpiresAt > accessExpiresAt
        else { throw NativeSessionError.invalidResponse }
        try store.save(refreshToken)
        access = Access(token: accessToken, expiresAt: accessExpiresAt)
    }

    // MARK: Credentials

    /// The access token, refreshed first when it is about to expire; nil
    /// when signed out.
    func currentAccess() async throws -> String? {
        if let access, access.expiresAt > now() + NativeAPI.refreshSkew { return access.token }
        return try await refresh()
    }

    /// One refresh at a time, shared by every caller of the same generation.
    func refresh() async throws -> String? {
        if let refreshing, refreshing.generation == generation { return try await refreshing.task.value }
        let started = generation
        let task = Task { try await self.performRefresh(generation: started) }
        refreshing = (started, task)
        defer { if refreshing?.generation == started { refreshing = nil } }
        return try await task.value
    }

    private func performRefresh(generation started: Int) async throws -> String? {
        if let access, access.expiresAt > now() + NativeAPI.refreshSkew { return access.token }
        guard let refreshToken = try store.load() else { return nil }
        let result: (Data, HTTPURLResponse)
        do {
            result = try await http.postJSON("/api/auth/desktop/refresh",
                                             ["clientId": NativeAPI.clientId, "refreshToken": refreshToken])
        } catch {
            // A stale failure never touches the newer session's credential.
            guard started == generation else { return nil }
            throw error
        }
        guard started == generation else { return nil }
        let (data, response) = result
        if response.statusCode == 401 || response.statusCode == 403 {
            forgetSession()
            return nil
        }
        guard (200..<300).contains(response.statusCode) else {
            throw NativeHTTP.serverError(data, fallback: "Cloud session refresh failed.")
        }
        try install(data)
        return access?.token
    }

    /// Readies the credential for one project request under a new handle,
    /// refreshing it first. Nil when signed out or when the session changed
    /// while it was readied.
    func prepare() async throws -> String? {
        let started = generation
        guard let token = try await currentAccess(), started == generation,
              let access, access.token == token else { return nil }
        let timestamp = now()
        prepared = prepared.filter { $0.value.expiresAt > timestamp }
        while prepared.count >= NativeAPI.maxPrepared,
              let oldest = prepared.min(by: { $0.value.issued < $1.value.issued })?.key {
            prepared.removeValue(forKey: oldest)
        }
        let handle = Self.randomSecret()
        issued += 1
        prepared[handle] = Prepared(token: token, expiresAt: access.expiresAt, generation: started, issued: issued)
        return handle
    }

    /// Exactly the credential readied under `handle`, once, while it is
    /// unexpired and its session lasts; never refreshed.
    func takePrepared(_ handle: String) -> String? {
        guard let entry = prepared.removeValue(forKey: handle),
              entry.generation == generation, entry.expiresAt > now() else { return nil }
        return entry.token
    }

    /// Drops the credential the account refused, unless another replaced it.
    func forget(_ token: String) {
        if access?.token == token { access = nil }
    }

    // MARK: Helpers

    nonisolated static func randomSecret() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            fatalError("The system random number generator failed.")
        }
        return base64url(Data(bytes))
    }

    nonisolated static func pkceChallenge(_ verifier: String) -> String {
        base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    nonisolated static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    /// The approval page exactly: `https://zcad.app/?desktopAuth=<attempt>`
    /// and nothing that names another attempt.
    nonisolated static func approvedBrowserURL(_ value: String, attemptId: String) -> URL? {
        guard let components = URLComponents(string: value),
              components.scheme == "https", components.host == NativeAPI.origin.host,
              components.port == nil, components.user == nil, components.password == nil,
              components.path == "/", components.fragment == nil,
              let items = components.queryItems,
              items.contains(where: { $0.name == "desktopAuth" && $0.value == attemptId }),
              !items.contains(where: { $0.name == "desktopAuth" && $0.value != attemptId }),
              !items.contains(where: { $0.name.lowercased() == "code" || $0.name.lowercased() == "usercode" })
        else { return nil }
        return components.url
    }
}

/// The app's only HTTP client for the cloud: an ephemeral session with no
/// cookies, no cache and no redirects.
final class NativeHTTP: NSObject {
    let session: URLSession

    init(configuration: URLSessionConfiguration = .ephemeral) {
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let delegate = RedirectRefusal()
        session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        super.init()
    }

    func postJSON(_ path: String, _ body: [String: String]) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: NativeAPI.origin.appendingPathComponent(String(path.dropFirst())))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(request)
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw NativeSessionError.unreachable }
            return (data, http)
        } catch let error as NativeSessionError {
            throw error
        } catch {
            throw NativeSessionError.unreachable
        }
    }

    static func serverError(_ data: Data, fallback: String) -> NativeSessionError {
        let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
        return NativeSessionError(message: message.map { String($0.prefix(300)) } ?? fallback)
    }
}

/// Answers every redirect with "do not follow": the response is the 3xx.
final class RedirectRefusal: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
