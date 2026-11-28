import Foundation
import WebKit

/// Where one `/api/*` request goes (ADR-026, "How the session reaches
/// requests"). It mirrors `renderer_api_destination`, `share_link_destination`
/// and `blob_stream_destination` in `apps/desktop/src-tauri/src/desktop_auth.rs`.
struct ApiDestination: Equatable {
    let url: URL
    /// Sent without the account's credential.
    let isPublic: Bool
    let isLogout: Bool
    let maxResponseBytes: Int

    static let bufferedLimit = 50 * 1024 * 1024
    static let blobLimit = 168 * 1024 * 1024
    static let artifactLimit = 256 * 1024 * 1024
    static let accountExportLimit = 512 * 1024 * 1024
    static let maxBodyBytes = 34 * 1024 * 1024

    struct Refused: Error, Equatable { let reason: String }

    /// `path` is the request's percent-encoded path and query, as sent.
    static func resolve(method: String, path: String, shareToken: String?) throws -> ApiDestination {
        if let shareToken { return try shareLink(method: method, path: path, token: shareToken) }
        let url = try apiURL(path)
        let routePath = url.path(percentEncoded: true)
        if lifecyclePath(routePath) || lifecyclePath(decodedRepeatedly(routePath)) {
            throw Refused(reason: "The sign-in lifecycle is native only.")
        }
        var target = url
        switch routePath {
        case "/api/auth/config": target = try apiURL("/api/auth/desktop/config")
        case "/api/auth/logout": target = try apiURL("/api/auth/desktop/logout")
        default: break
        }
        let finalPath = target.path(percentEncoded: true)
        let isPublic = finalPath == "/api/health" || finalPath == "/api/auth/desktop/config"
            || anonymousShareRead(finalPath)
        return ApiDestination(url: target, isPublic: isPublic, isLogout: finalPath == "/api/auth/desktop/logout",
                              maxResponseBytes: method == "GET" ? streamLimit(finalPath, query: url.query) : bufferedLimit)
    }

    /// Whether a request without the prepared header is refused: a write that
    /// names a project (`PROJECT_ROUTE` in `projectWriteGate.ts`). The web
    /// app sends every project request with the header, empty when nothing
    /// was readied, so omitting it cannot reach the current credential.
    static func requiresPreparedHeader(method: String, path: String) -> Bool {
        guard !["GET", "HEAD", "OPTIONS"].contains(method) else { return false }
        let segments = routeSegments(path)
        let project: String
        if segments.count >= 3, segments[0] == "api", segments[1] == "projects" {
            project = segments[2]
        } else if segments.count >= 4, segments[0] == "api", segments[1] == "e2ee", segments[2] == "projects" {
            project = segments[3]
        } else {
            return false
        }
        // `UNSCOPED` there: account-wide routes under the same prefix.
        return !project.isEmpty && project != "reorder" && project != "purge"
    }

    private static func shareLink(method: String, path: String, token: String) throws -> ApiDestination {
        guard method == "GET", plainSegment(token) else { throw Refused(reason: "The share-link request is not allowed.") }
        let url = try apiURL(path)
        guard url.query == nil, tokenFreeShareRead(url.path(percentEncoded: true)), url.path(percentEncoded: true) == path
        else { throw Refused(reason: "The share-link request is not allowed.") }
        return ApiDestination(url: url, isPublic: true, isLogout: false,
                              maxResponseBytes: streamLimit(path, query: nil, shareToken: true))
    }

    static func apiURL(_ path: String) throws -> URL {
        guard path.hasPrefix("/api/"), !path.contains("\0"), !path.contains("\\"), !path.contains("#"),
              path.unicodeScalars.allSatisfy({ $0.value > 0x20 && $0.value < 0x7f }),
              let url = URL(string: NativeAPI.origin.absoluteString + path),
              url.scheme == "https", url.host == NativeAPI.origin.host, url.port == nil,
              url.user == nil, url.password == nil
        else { throw Refused(reason: "The API path is not allowed.") }
        let segments = url.path(percentEncoded: true).split(separator: "/", omittingEmptySubsequences: false).dropFirst()
        // No dot segments or separators hidden in a segment, encoded or not,
        // which a server could normalise into another route.
        for segment in segments {
            let decoded = decodedRepeatedly(String(segment))
            if decoded == "." || decoded == ".." || decoded.contains("/") || decoded.contains("\\") {
                throw Refused(reason: "The API path is not allowed.")
            }
        }
        return url
    }

    private static func lifecyclePath(_ path: String) -> Bool {
        (path == "/api/auth/desktop" || path.hasPrefix("/api/auth/desktop/"))
            && path != "/api/auth/desktop/config" && path != "/api/auth/desktop/logout"
    }

    /// Percent-decodes until nothing changes, as a deny check only.
    static func decodedRepeatedly(_ value: String) -> String {
        var current = value
        for _ in 0..<8 {
            guard let next = current.removingPercentEncoding, next != current else { break }
            current = next
        }
        return current
    }

    private static func plainSegment(_ segment: Substring) -> Bool { plainSegment(String(segment)) }

    static func plainSegment(_ segment: String) -> Bool {
        !segment.isEmpty && segment.utf8.count <= 256
            && segment.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5a)
                || ($0 >= 0x61 && $0 <= 0x7a) || $0 == 0x2d || $0 == 0x5f }
    }

    private static func blobId(_ segment: String) -> Bool {
        segment.utf8.count == 32 && segment.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }

    private static func routeSegments(_ path: String) -> [String] {
        let routePath = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
        return routePath.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init)
    }

    private static func anonymousShareRead(_ path: String) -> Bool {
        let segments = routeSegments(path)
        guard segments.count >= 4, segments[0] == "api", segments[1] == "e2ee", segments[2] == "share" else { return false }
        let rest = Array(segments.dropFirst(3))
        switch rest.count {
        case 1: return plainSegment(rest[0])
        case 3: return plainSegment(rest[0]) && rest[1] == "blobs" && plainSegment(rest[2])
        default: return false
        }
    }

    private static func tokenFreeShareRead(_ path: String) -> Bool {
        let segments = routeSegments(path)
        switch segments.count {
        case 2: return segments == ["api", "share"]
        case 3: return segments == ["api", "e2ee", "share"]
        case 4: return segments[0] == "api" && segments[1] == "share"
            && (segments[2] == "assets" || segments[2] == "sources") && !segments[3].isEmpty && segments[3].utf8.count <= 256
        case 5: return segments[0] == "api" && segments[1] == "e2ee" && segments[2] == "share"
            && segments[3] == "blobs" && plainSegment(segments[4])
        default: return false
        }
    }

    /// The larger ceilings of the routes the desktop streams.
    private static func streamLimit(_ path: String, query: String?, shareToken: Bool = false) -> Int {
        guard query == nil else { return bufferedLimit }
        let s = routeSegments(path)
        if shareToken {
            return s.count == 5 && s[3] == "blobs" && blobId(s[4]) ? blobLimit : bufferedLimit
        }
        if s.count == 6, s[0] == "api", s[1] == "e2ee", s[2] == "share" || s[2] == "projects",
           plainSegment(s[3]), s[4] == "blobs", blobId(s[5]) { return blobLimit }
        if s.count == 4, s[0] == "api", s[1] == "artifacts", plainSegment(s[2]), s[3] == "download" { return artifactLimit }
        if s == ["api", "account", "export"] { return accountExportLimit }
        return bufferedLimit
    }

    /// API responses are same-origin data, never documents or scripts.
    static let responseTypes: Set<String> = [
        "application/json", "application/octet-stream", "text/plain",
        "application/vnd.openzcad.legacy-project-frame", "application/vnd.openzcad.e2ee-frame",
        "application/vnd.openzcad.mesh-payload", "application/step", "application/zip", "application/pdf"
    ]

    static func responseHeaders(upstream: HTTPURLResponse) -> [String: String] {
        let raw = upstream.value(forHTTPHeaderField: "content-type") ?? ""
        let media = raw.split(separator: ";", maxSplits: 1).first.map {
            $0.trimmingCharacters(in: .whitespaces).lowercased()
        } ?? ""
        let safe = responseTypes.contains(media) && raw.count <= 128
            && !raw.contains("\r") && !raw.contains("\n")
        return [
            "Content-Type": safe ? raw : "application/octet-stream",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Cache-Control": "no-store"
        ]
    }

    /// A successful profile or full data deletion ends the session, as on
    /// the desktop (`request_deletes_cloud_profile`).
    static func deletesCloudProfile(method: String, path: String, body: Data?) -> Bool {
        guard method == "POST", path == "/api/account/delete-data", let body,
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let scope = object["scope"] as? String else { return false }
        return scope == "profile" || scope == "all"
    }
}

/// Forwards the workspace's `/api/*` scheme requests to the cloud with the
/// native credential. The token never enters the WebView.
@MainActor
final class ApiProxy: NSObject, URLSessionDataDelegate {
    static let preparedHeader = "x-openzcad-prepared"
    static let shareTokenHeader = "x-openzcad-share-token"
    static let methods: Set<String> = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]

    private final class Exchange {
        let schemeTask: WKURLSchemeTask
        let destination: ApiDestination
        let method: String
        let path: String
        let body: Data?
        let contentType: String?
        let shareToken: String?
        var token: String?
        var retryable: Bool
        var upstream: URLSessionDataTask?
        var buffering401 = false
        var buffered = Data()
        var received = 0
        var stopped = false
        var finished = false

        init(schemeTask: WKURLSchemeTask, destination: ApiDestination, method: String, path: String, body: Data?,
             contentType: String?, shareToken: String?, retryable: Bool) {
            self.schemeTask = schemeTask
            self.destination = destination
            self.method = method
            self.path = path
            self.body = body
            self.contentType = contentType
            self.shareToken = shareToken
            self.retryable = retryable
        }
    }

    let session: NativeSession
    /// Whether the web view's committed document is the workspace, checked
    /// before any credential is attached.
    var admits: (WKWebView) -> Bool = { _ in false }
    private var transport: URLSession!
    private var exchanges: [ObjectIdentifier: Exchange] = [:]
    private var upstreams: [Int: Exchange] = [:]

    init(session: NativeSession, configuration: URLSessionConfiguration = .ephemeral) {
        self.session = session
        super.init()
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        transport = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
    }

    func start(_ task: WKURLSchemeTask, in webView: WKWebView) {
        let request = task.request
        let method = (request.httpMethod ?? "GET").uppercased()
        guard let url = request.url, WorkspaceViewController.isWorkspaceURL(url), Self.methods.contains(method),
              admits(webView),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return refuse(task) }
        let path = components.percentEncodedPath + (components.percentEncodedQuery.map { "?" + $0 } ?? "")
        let shareToken = request.value(forHTTPHeaderField: Self.shareTokenHeader)
        let prepared = request.value(forHTTPHeaderField: Self.preparedHeader)
        let contentType = request.value(forHTTPHeaderField: "content-type")
        if let contentType, contentType.count > 128 || contentType.contains("\r") || contentType.contains("\n") {
            return refuse(task)
        }
        guard let destination = try? ApiDestination.resolve(method: method, path: path, shareToken: shareToken),
              prepared != nil || !ApiDestination.requiresPreparedHeader(method: method, path: path),
              let body = Self.body(of: request), (body?.count ?? 0) <= ApiDestination.maxBodyBytes
        else { return refuse(task) }
        let exchange = Exchange(schemeTask: task, destination: destination, method: method, path: path, body: body,
                                contentType: contentType, shareToken: shareToken,
                                retryable: prepared == nil && !destination.isPublic && !destination.isLogout)
        exchanges[ObjectIdentifier(task)] = exchange
        Task { await run(exchange, prepared: prepared) }
    }

    func stop(_ task: WKURLSchemeTask) {
        guard let exchange = exchanges.removeValue(forKey: ObjectIdentifier(task)) else { return }
        exchange.stopped = true
        exchange.upstream?.cancel()
    }

    private func run(_ exchange: Exchange, prepared: String?) async {
        let destination = exchange.destination
        if destination.isLogout {
            let token = try? await session.currentAccess()
            var result: (Data, HTTPURLResponse)?
            if let token, let request = upstreamRequest(exchange, token: token) {
                result = try? await session.http.send(request)
            }
            session.forgetSession()
            if let (data, response) = result {
                respond(exchange, status: response.statusCode, headers: ApiDestination.responseHeaders(upstream: response), body: data)
            } else {
                respond(exchange, status: 200, body: Data(#"{"ok":true}"#.utf8))
            }
            return
        }
        if destination.isPublic { return send(exchange, token: nil) }
        let token: String?
        if let prepared {
            token = prepared.isEmpty ? nil : session.takePrepared(prepared)
        } else {
            token = try? await session.currentAccess()
        }
        guard let token else {
            return respond(exchange, status: 401, body: Data(#"{"error":"Authentication required.","code":"AUTH_REQUIRED"}"#.utf8))
        }
        send(exchange, token: token)
    }

    private func upstreamRequest(_ exchange: Exchange, token: String?) -> URLRequest? {
        var request = URLRequest(url: exchange.destination.url)
        request.httpMethod = exchange.method
        request.httpShouldHandleCookies = false
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        if let shareToken = exchange.shareToken {
            guard ApiDestination.plainSegment(shareToken) else { return nil }
            request.setValue(shareToken, forHTTPHeaderField: Self.shareTokenHeader)
        }
        if let contentType = exchange.contentType { request.setValue(contentType, forHTTPHeaderField: "content-type") }
        request.httpBody = exchange.body
        return request
    }

    private func send(_ exchange: Exchange, token: String?) {
        guard !exchange.stopped, let request = upstreamRequest(exchange, token: token) else {
            return fail(exchange)
        }
        exchange.token = token
        exchange.buffering401 = false
        exchange.buffered = Data()
        exchange.received = 0
        let task = transport.dataTask(with: request)
        exchange.upstream = task
        upstreams[task.taskIdentifier] = exchange
        task.resume()
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                                newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                                completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let id = dataTask.taskIdentifier
        let disposition: URLSession.ResponseDisposition = MainActor.assumeIsolated {
            guard let exchange = upstreams[id], !exchange.stopped, let http = response as? HTTPURLResponse else { return .cancel }
            if http.statusCode == 401, let token = exchange.token {
                self.session.forget(token)
                if exchange.retryable {
                    exchange.buffering401 = true
                    return .allow
                }
            }
            if http.expectedContentLength > Int64(exchange.destination.maxResponseBytes) {
                fail(exchange)
                return .cancel
            }
            if (200..<300).contains(http.statusCode),
               ApiDestination.deletesCloudProfile(method: exchange.method, path: exchange.path, body: exchange.body) {
                self.session.forgetSession()
            }
            exchange.schemeTask.didReceive(HTTPURLResponse(url: exchange.schemeTask.request.url!, statusCode: http.statusCode,
                httpVersion: "HTTP/1.1", headerFields: ApiDestination.responseHeaders(upstream: http))!)
            return .allow
        }
        completionHandler(disposition)
    }

    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let id = dataTask.taskIdentifier
        MainActor.assumeIsolated {
            guard let exchange = upstreams[id], !exchange.stopped, !exchange.finished else { return }
            exchange.received += data.count
            if exchange.buffering401 {
                if exchange.received <= 64 * 1024 { exchange.buffered.append(data) }
                return
            }
            guard exchange.received <= exchange.destination.maxResponseBytes else {
                dataTask.cancel()
                return fail(exchange)
            }
            exchange.schemeTask.didReceive(data)
        }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let id = task.taskIdentifier
        MainActor.assumeIsolated {
            guard let exchange = upstreams.removeValue(forKey: id), !exchange.stopped, !exchange.finished else { return }
            if exchange.buffering401 {
                // An ordinary request's 401: refresh, then send it once more.
                exchange.retryable = false
                let refused = exchange.buffered
                let response = task.response as? HTTPURLResponse
                Task {
                    if let token = try? await self.session.refresh(), !exchange.stopped {
                        self.send(exchange, token: token)
                    } else if let response {
                        self.respond(exchange, status: 401, headers: ApiDestination.responseHeaders(upstream: response), body: refused)
                    } else {
                        self.fail(exchange)
                    }
                }
                return
            }
            if error != nil { return fail(exchange) }
            exchange.finished = true
            exchanges.removeValue(forKey: ObjectIdentifier(exchange.schemeTask))
            exchange.schemeTask.didFinish()
        }
    }

    private func respond(_ exchange: Exchange, status: Int, headers: [String: String]? = nil, body: Data) {
        guard !exchange.stopped, !exchange.finished, let url = exchange.schemeTask.request.url else { return }
        exchange.finished = true
        exchanges.removeValue(forKey: ObjectIdentifier(exchange.schemeTask))
        let fields = headers ?? [
            "Content-Type": "application/json", "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "no-store"
        ]
        exchange.schemeTask.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: fields)!)
        exchange.schemeTask.didReceive(body)
        exchange.schemeTask.didFinish()
    }

    private func fail(_ exchange: Exchange) {
        guard !exchange.stopped, !exchange.finished else { return }
        exchange.finished = true
        exchanges.removeValue(forKey: ObjectIdentifier(exchange.schemeTask))
        exchange.upstream?.cancel()
        exchange.schemeTask.didFailWithError(URLError(.cannotLoadFromNetwork))
    }

    private func refuse(_ task: WKURLSchemeTask) {
        task.didFailWithError(URLError(.unsupportedURL))
    }

    /// The request body: WebKit passes string and byte bodies as `httpBody`
    /// (a Blob arrives empty, so the web side never sends one). `.some(nil)`
    /// is no body; nil is a body over the limit.
    private static func body(of request: URLRequest) -> Data?? {
        if let body = request.httpBody { return .some(body) }
        guard let stream = request.httpBodyStream else { return .some(nil) }
        var data = Data()
        stream.open()
        defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 65536)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read < 0 { return nil }
            if read == 0 { break }
            data.append(buffer, count: read)
            if data.count > ApiDestination.maxBodyBytes { return nil }
        }
        return .some(data)
    }
}
