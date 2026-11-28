import XCTest
import WebKit
@testable import ZCADiPad

/// The native session, proxy rules and bridge schema of ADR-026, against a
/// stubbed cloud. Nothing here reaches the network or the Keychain.
final class NativeSessionTests: XCTestCase {
    override func tearDown() {
        StubCloud.reset()
        super.tearDown()
    }

    // MARK: Sign-in helpers

    func testPkceChallengeMatchesRfc7636() {
        XCTAssertEqual(NativeSession.pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
                       "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        XCTAssertEqual(NativeSession.randomSecret().count, 43)
    }

    func testApprovalPageMustBeExactlyTheAttemptsOwn() {
        let attempt = "0b9f0d7e-2c55-4a2d-9b8c-3f5f1e3f9a10"
        XCTAssertNotNil(NativeSession.approvedBrowserURL("https://zcad.app/?desktopAuth=\(attempt)", attemptId: attempt))
        for value in [
            "http://zcad.app/?desktopAuth=\(attempt)",
            "https://zcad.app.attacker.example/?desktopAuth=\(attempt)",
            "https://zcad.app:8443/?desktopAuth=\(attempt)",
            "https://user@zcad.app/?desktopAuth=\(attempt)",
            "https://zcad.app/approve?desktopAuth=\(attempt)",
            "https://zcad.app/?desktopAuth=other",
            "https://zcad.app/?desktopAuth=\(attempt)&desktopAuth=other",
            "https://zcad.app/?desktopAuth=\(attempt)&code=ABCD1234",
            "https://zcad.app/?desktopAuth=\(attempt)#x"
        ] {
            XCTAssertNil(NativeSession.approvedBrowserURL(value, attemptId: attempt), value)
        }
    }

    // MARK: Proxy destinations

    func testLifecycleRoutesAreNativeOnlyEvenWhenEncoded() {
        for path in ["/api/auth/desktop/exchange", "/api/auth/desktop/refresh", "/api/auth/desktop/start",
                     "/api/auth/desktop", "/api/auth/%64esktop/refresh", "/api/auth/desktop%2Fexchange",
                     "/api/auth/%2564esktop/refresh"] {
            XCTAssertThrowsError(try ApiDestination.resolve(method: "POST", path: path, shareToken: nil), path)
        }
    }

    func testAuthRoutesMapToTheNativeEndpoints() throws {
        let config = try ApiDestination.resolve(method: "GET", path: "/api/auth/config", shareToken: nil)
        XCTAssertEqual(config.url.absoluteString, "https://zcad.app/api/auth/desktop/config")
        XCTAssertTrue(config.isPublic)
        let logout = try ApiDestination.resolve(method: "POST", path: "/api/auth/logout", shareToken: nil)
        XCTAssertEqual(logout.url.absoluteString, "https://zcad.app/api/auth/desktop/logout")
        XCTAssertTrue(logout.isLogout)
        let session = try ApiDestination.resolve(method: "GET", path: "/api/session", shareToken: nil)
        XCTAssertFalse(session.isPublic)
        XCTAssertEqual(session.url.absoluteString, "https://zcad.app/api/session")
    }

    func testOnlyAPlainApiPathOnTheCloudOriginIsSent() {
        for path in ["/assets/app.js", "/api/../index.html", "/api/projects/%2e%2e/x", "/api/projects/a%2Fb",
                     "/api/projects/a\\b", "//attacker.example/api/x", "/api/x#y", "/api/x y"] {
            XCTAssertThrowsError(try ApiDestination.resolve(method: "GET", path: path, shareToken: nil), path)
        }
        XCTAssertNoThrow(try ApiDestination.resolve(method: "GET", path: "/api/projects?cursor=a%20b", shareToken: nil))
    }

    func testShareLinkReadsStayAnonymous() throws {
        let token = String(repeating: "s", count: 32)
        let read = try ApiDestination.resolve(method: "GET", path: "/api/share", shareToken: token)
        XCTAssertTrue(read.isPublic)
        let blob = try ApiDestination.resolve(method: "GET", path: "/api/e2ee/share/blobs/\(String(repeating: "a", count: 32))",
                                              shareToken: token)
        XCTAssertEqual(blob.maxResponseBytes, ApiDestination.blobLimit)
        XCTAssertThrowsError(try ApiDestination.resolve(method: "POST", path: "/api/share", shareToken: token))
        XCTAssertThrowsError(try ApiDestination.resolve(method: "GET", path: "/api/session", shareToken: token))
        XCTAssertThrowsError(try ApiDestination.resolve(method: "GET", path: "/api/share?x=1", shareToken: token))
        XCTAssertThrowsError(try ApiDestination.resolve(method: "GET", path: "/api/share", shareToken: "a\r\nb"))
        let pathToken = try ApiDestination.resolve(method: "GET", path: "/api/e2ee/share/\(token)", shareToken: nil)
        XCTAssertTrue(pathToken.isPublic)
    }

    func testDownloadCeilingsFollowTheDesktopStreams() throws {
        let blob = String(repeating: "0", count: 32)
        XCTAssertEqual(try ApiDestination.resolve(method: "GET", path: "/api/e2ee/projects/p1/blobs/\(blob)",
                                                  shareToken: nil).maxResponseBytes, ApiDestination.blobLimit)
        XCTAssertEqual(try ApiDestination.resolve(method: "GET", path: "/api/artifacts/a1/download",
                                                  shareToken: nil).maxResponseBytes, ApiDestination.artifactLimit)
        XCTAssertEqual(try ApiDestination.resolve(method: "GET", path: "/api/account/export",
                                                  shareToken: nil).maxResponseBytes, ApiDestination.accountExportLimit)
        XCTAssertEqual(try ApiDestination.resolve(method: "POST", path: "/api/account/export",
                                                  shareToken: nil).maxResponseBytes, ApiDestination.bufferedLimit)
        XCTAssertEqual(try ApiDestination.resolve(method: "GET", path: "/api/projects/p1",
                                                  shareToken: nil).maxResponseBytes, ApiDestination.bufferedLimit)
    }

    func testNamedProjectWritesNeedThePreparedHeader() {
        XCTAssertTrue(ApiDestination.requiresPreparedHeader(method: "PUT", path: "/api/projects/p1/document"))
        XCTAssertTrue(ApiDestination.requiresPreparedHeader(method: "DELETE", path: "/api/projects/p1"))
        XCTAssertTrue(ApiDestination.requiresPreparedHeader(method: "PUT", path: "/api/e2ee/projects/p1/frame"))
        XCTAssertFalse(ApiDestination.requiresPreparedHeader(method: "GET", path: "/api/projects/p1"))
        XCTAssertFalse(ApiDestination.requiresPreparedHeader(method: "POST", path: "/api/projects"))
        XCTAssertFalse(ApiDestination.requiresPreparedHeader(method: "POST", path: "/api/projects/reorder"))
        XCTAssertFalse(ApiDestination.requiresPreparedHeader(method: "POST", path: "/api/projects/purge"))
        XCTAssertFalse(ApiDestination.requiresPreparedHeader(method: "PATCH", path: "/api/settings"))
    }

    func testResponsesAreNeverExecutable() {
        let html = HTTPURLResponse(url: NativeAPI.origin, statusCode: 200, httpVersion: nil,
                                   headerFields: ["Content-Type": "text/html", "Set-Cookie": "a=b"])!
        let headers = ApiDestination.responseHeaders(upstream: html)
        XCTAssertEqual(headers["Content-Type"], "application/octet-stream")
        XCTAssertEqual(headers["X-Content-Type-Options"], "nosniff")
        XCTAssertEqual(headers["Content-Security-Policy"], "default-src 'none'; sandbox")
        XCTAssertNil(headers["Set-Cookie"])
        let json = HTTPURLResponse(url: NativeAPI.origin, statusCode: 200, httpVersion: nil,
                                   headerFields: ["Content-Type": "application/json; charset=utf-8"])!
        XCTAssertEqual(ApiDestination.responseHeaders(upstream: json)["Content-Type"], "application/json; charset=utf-8")
        XCTAssertTrue(ApiDestination.deletesCloudProfile(method: "POST", path: "/api/account/delete-data",
                                                         body: Data(#"{"scope":"all"}"#.utf8)))
        XCTAssertFalse(ApiDestination.deletesCloudProfile(method: "POST", path: "/api/account/delete-data",
                                                          body: Data(#"{"scope":"projects"}"#.utf8)))
    }

    func testWorkspacePolicyRefusesFramesAndAllowsOnlyTheRoomSocket() {
        XCTAssertTrue(BundleServer.policy.contains("frame-src 'none'"))
        XCTAssertTrue(BundleServer.policy.contains("child-src 'none'"))
        XCTAssertTrue(BundleServer.policy.contains("connect-src 'self' wss://zcad.app;"))
        XCTAssertFalse(BundleServer.policy.contains("https:"))
    }

    // MARK: Bridge schema

    @MainActor
    func testBridgeAcceptsOnlySchemaVersionOne() {
        XCTAssertEqual(NativeBridge.operation(["v": 1, "op": "session.status"]), .status)
        XCTAssertEqual(NativeBridge.operation(["v": 1, "op": "capabilities"]), .capabilities)
        XCTAssertNil(NativeBridge.operation(["v": 2, "op": "session.status"]))
        XCTAssertNil(NativeBridge.operation(["v": true, "op": "session.status"]))
        XCTAssertNil(NativeBridge.operation(["v": "1", "op": "session.status"]))
        XCTAssertNil(NativeBridge.operation(["v": 1, "op": "session.status", "token": "x"]))
        XCTAssertNil(NativeBridge.operation(["v": 1, "op": "passkey.get"]))
        XCTAssertNil(NativeBridge.operation(["v": 1, "op": "session.token"]))
        XCTAssertNil(NativeBridge.operation("session.status"))
    }

    @MainActor
    func testBridgeAdmitsOnlyTheWorkspaceMainFrame() {
        let workspace = URL(string: "zcad-ipad://app/")
        XCTAssertTrue(NativeBridge.admitsFrame(isMainFrame: true, originScheme: "zcad-ipad", originHost: "app",
                                               originPort: 0, requestURL: workspace))
        XCTAssertFalse(NativeBridge.admitsFrame(isMainFrame: false, originScheme: "zcad-ipad", originHost: "app",
                                                originPort: 0, requestURL: workspace))
        XCTAssertFalse(NativeBridge.admitsFrame(isMainFrame: true, originScheme: "https", originHost: "zcad.app",
                                                originPort: 0, requestURL: URL(string: "https://zcad.app/")))
        XCTAssertFalse(NativeBridge.admitsFrame(isMainFrame: true, originScheme: "zcad-ipad", originHost: "app",
                                                originPort: 8080, requestURL: workspace))
        XCTAssertFalse(NativeBridge.admitsFrame(isMainFrame: true, originScheme: "zcad-ipad", originHost: "app",
                                                originPort: 0, requestURL: URL(string: "zcad-ipad://other/")))
    }

    // MARK: Session

    @MainActor
    private func session(store: MemoryRefreshTokenStore = MemoryRefreshTokenStore(),
                         clock: @escaping () -> TimeInterval = { 1_000 }) -> NativeSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubCloud.self]
        return NativeSession(store: store, http: NativeHTTP(configuration: configuration), now: clock)
    }

    private static func tokens(_ seed: Character, access: Double = 2_000) -> Data {
        Data("""
            {"status":"authorized","session":{"userId":"u"},"accessToken":"\(String(repeating: seed, count: 43))",
             "accessExpiresAt":\(access),"refreshToken":"\(String(repeating: seed.uppercased().first!, count: 43))",
             "refreshExpiresAt":99999}
            """.utf8)
    }

    @MainActor
    func testSignInRedeemsTheAttemptWithItsVerifier() async throws {
        let attempt = "0b9f0d7e-2c55-4a2d-9b8c-3f5f1e3f9a10"
        StubCloud.respond("/api/auth/desktop/start", 201, """
            {"attemptId":"\(attempt)","browserUrl":"https://zcad.app/?desktopAuth=\(attempt)","expiresInSeconds":600,"userCode":"ABCD1234"}
            """)
        StubCloud.respond("/api/auth/desktop/exchange", 202, #"{"status":"pending"}"#)
        StubCloud.respond("/api/auth/desktop/exchange", 200, Self.tokens("a"))
        let store = MemoryRefreshTokenStore()
        let session = session(store: store)
        let pending = try await session.start()
        XCTAssertEqual(pending.userCode, "ABCD1234")
        let start = try XCTUnwrap(StubCloud.bodies.first)
        XCTAssertEqual(start["clientId"], "openzcad-ios")
        XCTAssertEqual(start["codeChallenge"], NativeSession.pkceChallenge(pending.verifier))
        XCTAssertNil(start["verifier"])
        let firstExchange = try await session.exchange(pending)
        XCTAssertFalse(firstExchange)
        let secondExchange = try await session.exchange(pending)
        XCTAssertTrue(secondExchange)
        XCTAssertEqual(StubCloud.bodies.last?["verifier"], pending.verifier)
        XCTAssertEqual(try store.load(), String(repeating: "A", count: 43))
        let access = try await session.currentAccess()
        XCTAssertEqual(access, String(repeating: "a", count: 43))
        XCTAssertTrue(session.signedIn)
    }

    @MainActor
    func testPreparedCredentialIsSentOnceAndDiesWithItsSession() async throws {
        let store = MemoryRefreshTokenStore()
        try store.save(String(repeating: "R", count: 43))
        StubCloud.respond("/api/auth/desktop/refresh", 200, Self.tokens("a"))
        let session = session(store: store)
        let handle = try await XCTUnwrapAsync(await session.prepare())
        XCTAssertEqual(session.takePrepared(handle), String(repeating: "a", count: 43))
        XCTAssertNil(session.takePrepared(handle), "a handle is single-use")
        let next = try await XCTUnwrapAsync(await session.prepare())
        session.endSession()
        XCTAssertNil(session.takePrepared(next), "a handle never outlives its session")
        XCTAssertNil(session.takePrepared("unknown"))
    }

    @MainActor
    func testExpiredPreparedCredentialSendsNothing() async throws {
        var now: TimeInterval = 1_000
        let store = MemoryRefreshTokenStore()
        try store.save(String(repeating: "R", count: 43))
        StubCloud.respond("/api/auth/desktop/refresh", 200, Self.tokens("a", access: 1_100))
        let session = session(store: store, clock: { now })
        let handle = try await XCTUnwrapAsync(await session.prepare())
        now = 1_200
        XCTAssertNil(session.takePrepared(handle))
    }

    @MainActor
    func testConcurrentRefreshesShareOneRequest() async throws {
        let store = MemoryRefreshTokenStore()
        try store.save(String(repeating: "R", count: 43))
        StubCloud.respond("/api/auth/desktop/refresh", 200, Self.tokens("a"), delay: 0.2)
        let session = session(store: store)
        async let first = session.refresh()
        async let second = session.refresh()
        let tokens = try await [first, second]
        XCTAssertEqual(tokens, [String(repeating: "a", count: 43), String(repeating: "a", count: 43)])
        XCTAssertEqual(StubCloud.requests.filter { $0 == "/api/auth/desktop/refresh" }.count, 1)
    }

    @MainActor
    func testARefreshFromAnEndedSessionChangesNothing() async throws {
        let store = MemoryRefreshTokenStore()
        try store.save(String(repeating: "R", count: 43))
        StubCloud.respond("/api/auth/desktop/refresh", 401, #"{"error":"expired"}"#, delay: 0.2)
        let session = session(store: store)
        async let stale = session.refresh()
        try await Task.sleep(nanoseconds: 50_000_000)
        // Signed in again meanwhile: the old refresh's 401 must not delete
        // the new session's token.
        session.endSession()
        try store.save(String(repeating: "N", count: 43))
        let result = try await stale
        XCTAssertNil(result)
        XCTAssertEqual(try store.load(), String(repeating: "N", count: 43))
    }

    @MainActor
    func testARefusedRefreshSignsOut() async throws {
        let store = MemoryRefreshTokenStore()
        try store.save(String(repeating: "R", count: 43))
        StubCloud.respond("/api/auth/desktop/refresh", 401, #"{"error":"expired"}"#)
        let session = session(store: store)
        let access = try await session.currentAccess()
        XCTAssertNil(access)
        XCTAssertNil(try store.load())
        XCTAssertFalse(session.signedIn)
    }
}

private func XCTUnwrapAsync<T>(_ value: T?, file: StaticString = #filePath, line: UInt = #line) throws -> T {
    try XCTUnwrap(value, file: file, line: line)
}

/// A scripted cloud: each path answers its queued responses in order.
final class StubCloud: URLProtocol {
    private static let lock = NSLock()
    private static var scripted: [String: [(Int, Data, TimeInterval)]] = [:]
    private(set) static var requests: [String] = []
    private(set) static var bodies: [[String: String]] = []
    private(set) static var headers: [[String: String]] = []

    static func reset() {
        lock.withLock { scripted = [:]; requests = []; bodies = []; headers = []; extraHeaders = [:] }
    }

    static func respond(_ path: String, _ status: Int, _ body: String, delay: TimeInterval = 0) {
        respond(path, status, Data(body.utf8), delay: delay)
    }

    static func respond(_ path: String, _ status: Int, _ body: Data, delay: TimeInterval = 0) {
        lock.withLock { scripted[path, default: []].append((status, body, delay)) }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                body.append(buffer, count: read)
            }
            stream.close()
        }
        let next: (Int, Data, TimeInterval)? = Self.lock.withLock {
            Self.requests.append(path)
            Self.headers.append(Dictionary(uniqueKeysWithValues: (request.allHTTPHeaderFields ?? [:]).map {
                ($0.key.lowercased(), $0.value) }))
            if let json = try? JSONSerialization.jsonObject(with: body) as? [String: String] { Self.bodies.append(json) }
            guard var queue = Self.scripted[path], !queue.isEmpty else { return nil }
            let first = queue.removeFirst()
            Self.scripted[path] = queue.isEmpty ? [first] : queue
            return first
        }
        let (status, data, delay) = next ?? (404, Data(#"{"error":"unscripted"}"#.utf8), 0)
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [self] in
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
                httpVersion: "HTTP/1.1", headerFields: Self.lock.withLock { Self.extraHeaders[path] }
                    ?? ["Content-Type": "application/json"])!,
                cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}

    static func respond(_ path: String, _ status: Int, _ body: String, headers extra: [String: String]) {
        respond(path, status, Data(body.utf8))
        lock.withLock { extraHeaders[path] = extra }
    }

    static var extraHeaders: [String: [String: String]] = [:]
}

/// The proxy end to end: a real page on the private origin fetching `/api/*`
/// through `BundleServer` and `ApiProxy` to the stubbed cloud.
final class ApiProxyIntegrationTests: XCTestCase {
    override func tearDown() {
        StubCloud.reset()
        super.tearDown()
    }

    @MainActor
    private func workspace(signedIn: Bool = true, admitted: Bool = true) async throws -> WKWebView {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("<!doctype html><html><body>Workspace</body></html>".utf8).write(to: root.appendingPathComponent("index.html"))
        let cloud = URLSessionConfiguration.ephemeral
        cloud.protocolClasses = [StubCloud.self]
        let store = MemoryRefreshTokenStore()
        if signedIn {
            try store.save(String(repeating: "R", count: 43))
            StubCloud.respond("/api/auth/desktop/refresh", 200, """
                {"status":"authorized","accessToken":"\(String(repeating: "a", count: 43))","accessExpiresAt":9999999999,
                 "refreshToken":"\(String(repeating: "B", count: 43))","refreshExpiresAt":99999999999}
                """)
        }
        let session = NativeSession(store: store, http: NativeHTTP(configuration: cloud.copy() as! URLSessionConfiguration))
        let proxy = ApiProxy(session: session, configuration: cloud)
        proxy.admits = { _ in admitted }
        let server = BundleServer(root: root)
        server.proxy = proxy
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: UUID())
        configuration.setURLSchemeHandler(server, forURLScheme: BundleServer.scheme)
        let web = WKWebView(frame: .zero, configuration: configuration)
        let navigation = LoadWait()
        web.navigationDelegate = navigation
        navigation.loaded = expectation(description: "workspace")
        web.load(URLRequest(url: BundleServer.origin))
        await fulfillment(of: [navigation.loaded!], timeout: 60)
        objc_setAssociatedObject(web, &ApiProxyIntegrationTests.retained, [server, proxy, navigation], .OBJC_ASSOCIATION_RETAIN)
        return web
    }

    private static var retained = 0

    @MainActor
    private func fetch(_ web: WKWebView, _ script: String) async throws -> String {
        let result = try await web.callAsyncJavaScript("""
            try { \(script) } catch (error) { return 'rejected:' + error.name; }
            """, arguments: [:], in: nil, contentWorld: .page)
        return try XCTUnwrap(result as? String)
    }

    @MainActor
    func testAttachesTheBearerUpstreamAndNeverTheCookieOrOrigin() async throws {
        StubCloud.respond("/api/session", 200, "<script>alert(1)</script>",
                          headers: ["Content-Type": "text/html", "Set-Cookie": "__Host-openzcad_session=x"])
        let web = try await workspace()
        let seen = try await fetch(web, """
            const response = await fetch('/api/session', {credentials: 'include'});
            return [response.status, response.headers.get('content-type'), response.headers.get('x-content-type-options'),
                    response.headers.get('content-security-policy'), String(response.headers.get('set-cookie'))].join('|');
            """)
        XCTAssertEqual(seen, "200|application/octet-stream|nosniff|default-src 'none'; sandbox|null")
        let index = try XCTUnwrap(StubCloud.requests.firstIndex(of: "/api/session"))
        let upstream = StubCloud.headers[index]
        XCTAssertEqual(upstream["authorization"], "Bearer \(String(repeating: "a", count: 43))")
        XCTAssertNil(upstream["cookie"])
        XCTAssertNil(upstream["origin"])
        XCTAssertNil(upstream["referer"])
    }

    @MainActor
    func testPublicRoutesStayBearerFree() async throws {
        StubCloud.respond("/api/auth/desktop/config", 200, #"{"desktopAuthEnabled":true}"#)
        let web = try await workspace()
        let seen = try await fetch(web, "return String((await fetch('/api/auth/config')).status);")
        XCTAssertEqual(seen, "200")
        let index = try XCTUnwrap(StubCloud.requests.firstIndex(of: "/api/auth/desktop/config"))
        XCTAssertNil(StubCloud.headers[index]["authorization"])
    }

    @MainActor
    func testAProjectWriteWithoutItsHandleSendsNothing() async throws {
        let web = try await workspace()
        let missing = try await fetch(web, "return String((await fetch('/api/projects/p1/document', {method: 'PUT', body: '{}'})).status);")
        XCTAssertEqual(missing, "rejected:TypeError")
        let empty = try await fetch(web, """
            return String((await fetch('/api/projects/p1/document', {method: 'PUT', body: '{}',
                headers: {'x-openzcad-prepared': ''}})).status);
            """)
        XCTAssertEqual(empty, "401")
        let unknown = try await fetch(web, """
            return String((await fetch('/api/projects/p1/document', {method: 'PUT', body: '{}',
                headers: {'x-openzcad-prepared': '\(String(repeating: "x", count: 43))'}})).status);
            """)
        XCTAssertEqual(unknown, "401")
        XCTAssertFalse(StubCloud.requests.contains("/api/projects/p1/document"))
    }

    @MainActor
    func testTheSignInLifecycleIsUnreachableFromThePage() async throws {
        let web = try await workspace()
        let seen = try await fetch(web, "return String((await fetch('/api/auth/desktop/refresh', {method: 'POST', body: '{}'})).status);")
        XCTAssertEqual(seen, "rejected:TypeError")
        XCTAssertFalse(StubCloud.requests.contains("/api/auth/desktop/refresh"))
    }

    @MainActor
    func testAnUnadmittedPageReachesNothing() async throws {
        let web = try await workspace(admitted: false)
        let seen = try await fetch(web, "return String((await fetch('/api/session')).status);")
        XCTAssertEqual(seen, "rejected:TypeError")
        XCTAssertTrue(StubCloud.requests.isEmpty)
    }
}

private final class LoadWait: NSObject, WKNavigationDelegate {
    var loaded: XCTestExpectation?
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }
}
