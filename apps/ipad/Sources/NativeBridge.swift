import AuthenticationServices
import UIKit
import WebKit

/// The one message handler the workspace may call (ADR-026, "Bridge flow"),
/// version 1, session operations only. Passkey operations arrive with the
/// passkey step; until then `capabilities` says passkeys are unsupported and
/// every `passkey.*` request is refused.
@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "openzcadNative"

    enum Operation: String { case capabilities, status = "session.status", signIn = "session.signIn",
        signOut = "session.signOut", prepare = "session.prepare" }

    let session: NativeSession
    let signIn: NativeSignIn
    /// The workspace's own web view, and whether it is past its bootstrap.
    var admits: (WKWebView) -> Bool = { _ in false }

    init(session: NativeSession, signIn: NativeSignIn) {
        self.session = session
        self.signIn = signIn
    }

    /// The validated operation, or nil for anything outside schema version 1:
    /// another version, an unknown op, or any extra key.
    nonisolated static func operation(_ body: Any) -> Operation? {
        guard let object = body as? [String: Any], object.count == 2,
              let version = object["v"] as? NSNumber, version == 1, CFGetTypeID(version) != CFBooleanGetTypeID(),
              let op = object["op"] as? String else { return nil }
        return Operation(rawValue: op)
    }

    /// The main frame of the workspace's private origin, and nothing else.
    nonisolated static func admitsFrame(isMainFrame: Bool, originScheme: String, originHost: String, originPort: Int,
                            requestURL: URL?) -> Bool {
        guard isMainFrame, originScheme == BundleServer.scheme, originHost == "app", originPort == 0,
              let requestURL, WorkspaceViewController.isWorkspaceURL(requestURL) else { return false }
        return true
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let frame = message.frameInfo
        guard let webView = message.webView, admits(webView),
              Self.admitsFrame(isMainFrame: frame.isMainFrame, originScheme: frame.securityOrigin.protocol,
                               originHost: frame.securityOrigin.host, originPort: frame.securityOrigin.port,
                               requestURL: frame.request.url)
        else { return replyHandler(Self.failure("SecurityError", "This request is not allowed."), nil) }
        guard let operation = Self.operation(message.body) else {
            return replyHandler(Self.failure("NotSupportedError", "This request is not supported."), nil)
        }
        Task { replyHandler(await handle(operation, from: webView), nil) }
    }

    private func handle(_ operation: Operation, from webView: WKWebView) async -> [String: Any] {
        switch operation {
        case .capabilities:
            return Self.success(["bridge": 1, "passkeys": "unsupported", "realm": "stable",
                                 "apiHost": NativeAPI.origin.host ?? ""])
        case .status:
            return Self.success(["signedIn": session.signedIn])
        case .prepare:
            do {
                let handle = try await session.prepare()
                return Self.success(["handle": handle ?? NSNull()])
            } catch {
                return Self.failure("NetworkError", error.localizedDescription)
            }
        case .signOut:
            await signOut()
            return Self.success(["signedIn": false])
        case .signIn:
            do {
                let signedIn = try await signIn.run(session: session)
                return signedIn ? Self.success(["signedIn": true])
                    : Self.failure("NotAllowedError", "Sign-in was cancelled.")
            } catch {
                return Self.failure("NetworkError", error.localizedDescription)
            }
        }
    }

    /// Tells the server, then forgets the session whether or not it heard.
    private func signOut() async {
        if let token = try? await session.currentAccess() {
            var request = URLRequest(url: NativeAPI.origin.appendingPathComponent("api/auth/desktop/logout"))
            request.httpMethod = "POST"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
            _ = try? await session.http.send(request)
        }
        session.forgetSession()
    }

    static func success(_ result: [String: Any]) -> [String: Any] { ["ok": true, "result": result] }

    static func failure(_ name: String, _ message: String) -> [String: Any] {
        ["ok": false, "error": ["name": name, "message": message]]
    }
}

/// Runs one sign-in: shows the code, opens the approval page in a private
/// `ASWebAuthenticationSession` sheet, and redeems the attempt with its PKCE
/// verifier while the sheet is open. No callback URL carries anything.
@MainActor
final class NativeSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    weak var presenter: UIViewController?
    private var running = false

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        presenter?.view.window ?? ASPresentationAnchor()
    }

    /// True once signed in; false when the person cancelled.
    func run(session: NativeSession) async throws -> Bool {
        guard !running, let presenter else {
            throw NativeSessionError(message: "A sign-in is already in progress.")
        }
        running = true
        defer { running = false }
        let pending = try await session.start()
        guard await confirmCode(pending.userCode, on: presenter) else { return false }
        // A sheet that has to stay open while the exchange is polled.
        var sheetClosed = false
        let sheet = ASWebAuthenticationSession(url: pending.browserURL,
                                               callbackURLScheme: "openzcad-ios-sign-in-unused") { _, _ in
            sheetClosed = true
        }
        sheet.prefersEphemeralWebBrowserSession = true
        sheet.presentationContextProvider = self
        guard sheet.start() else { throw NativeSessionError(message: "The sign-in page could not be opened.") }
        defer { sheet.cancel() }
        while Date().timeIntervalSince1970 < pending.expiresAt {
            try await Task.sleep(nanoseconds: 1_000_000_000)
            if try await session.exchange(pending) { return true }
            // Closing the sheet after approving still signs in on this last try.
            if sheetClosed { return try await session.exchange(pending) }
        }
        throw NativeSessionError(message: "The sign-in attempt expired. Start again.")
    }

    /// Shows the 8-character code before the page asks for it. Continuing
    /// copies it to this device's pasteboard for ten minutes.
    private func confirmCode(_ code: String, on presenter: UIViewController) async -> Bool {
        let display = code.count == 8 ? "\(code.prefix(4)) \(code.suffix(4))" : code
        return await withCheckedContinuation { continuation in
            let alert = UIAlertController(
                title: "Your sign-in code",
                message: "\(display)\n\nSign in with your email on the next page, then enter this code to connect the app.",
                preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in continuation.resume(returning: false) })
            alert.addAction(UIAlertAction(title: "Copy Code and Continue", style: .default) { _ in
                UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: code]], options: [
                    .localOnly: true, .expirationDate: Date().addingTimeInterval(600)])
                continuation.resume(returning: true)
            })
            presenter.present(alert, animated: true)
        }
    }
}
