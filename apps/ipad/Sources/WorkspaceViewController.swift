import UIKit
import WebKit

final class WorkspaceViewController: UIViewController, WKNavigationDelegate, WKDownloadDelegate,
    UIDocumentPickerDelegate {
    private var webView: WKWebView!
    private var server: BundleServer?
    private var downloads: [ObjectIdentifier: URL] = [:]
    private var exportedFile: URL?
    private enum Bootstrap { case legacy, copy, workspace }
    private var bootstrap: Bootstrap = .workspace
    private var pendingSnapshot: String?
    private var migrationDefaultsKey = PrototypeStorage.marker
    private var failureLabel: UILabel?
    private var bootstrapGeneration = 0
    private var processRecoveries = 0
    private var textZoom: CGFloat = 1
    private var bridge: NativeBridge?
    private var bridgeInstalled = false
    private var testing = false
    /// The web app's device-local cloud switch, which builds before the
    /// native session forced off on every load. Released once, so a choice
    /// the person makes afterwards stands.
    private static let cloudSwitchKey = "openzcad-cloud-functions-enabled:v1"
    private static let cloudSwitchReleased = "openzcad.cloud-switch-released:v1"

    private let idiom = WorkspaceIdiom.current

    override var prefersStatusBarHidden: Bool { idiom.prefersStatusBarHidden }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { idiom.supportedOrientations }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        guard let root = Bundle.main.url(forResource: "Web", withExtension: nil) else {
            showFailure("The bundled CAD files are missing. Run pnpm prepare:ipad, then rebuild the app.")
            return
        }
        let configuration = WKWebViewConfiguration()
        let testing = ProcessInfo.processInfo.arguments.contains("--ui-testing")
            || ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
            || NSClassFromString("XCTestCase") != nil
        configuration.websiteDataStore = testing
            ? WKWebsiteDataStore(forIdentifier: PrototypeStorage.testStore) : .default()
        if testing { migrationDefaultsKey += "-tests" }
        self.testing = testing
        let server = BundleServer(root: root)
        self.server = server
        // The cloud session (ADR-026). UI tests keep theirs in memory so
        // they never touch this device's Keychain item.
        let store: RefreshTokenStore = testing ? MemoryRefreshTokenStore() : KeychainRefreshTokenStore()
        if !testing { KeychainRefreshTokenStore.removeLeftoverAfterInstall(store: store) }
        let session = NativeSession(store: store)
        let proxy = ApiProxy(session: session)
        proxy.admits = { [weak self] candidate in self?.admitsNative(candidate) ?? false }
        server.proxy = proxy
        let signIn = NativeSignIn()
        signIn.presenter = self
        let bridge = NativeBridge(session: session, signIn: signIn)
        bridge.admits = { [weak self] candidate in self?.admitsNative(candidate) ?? false }
        self.bridge = bridge
        configuration.setURLSchemeHandler(server, forURLScheme: BundleServer.scheme)
        installUserScripts(in: configuration.userContentController)
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.translatesAutoresizingMaskIntoConstraints = false
        #if DEBUG
        webView.isInspectable = true
        #endif
        view.addSubview(webView)
        // The workspace ends at the keyboard's top. Left full height, the
        // keyboard covered its lower half and WebKit scrolled the whole page
        // up to show a focused field: the header went offscreen and Undo and
        // Redo slid under the status bar. Resized instead, the page lays out
        // above the keyboard and nothing scrolls. Without a keyboard the
        // guide sits at the view's bottom edge, under the home indicator,
        // which the page clears with its own safe-area insets.
        view.keyboardLayoutGuide.usesBottomSafeArea = false
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)
        ])
        // The person's text size, now and whenever it changes in Settings.
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) {
            (controller: WorkspaceViewController, _: UITraitCollection) in
            controller.applyTextSize()
        }
        if UserDefaults.standard.bool(forKey: migrationDefaultsKey) {
            installBridge()
            webView.load(URLRequest(url: BundleServer.origin))
        } else {
            bootstrap = .legacy
            // The bootstrap HTML is supplied by native code. Its base URL
            // selects the earlier IndexedDB origin without making an HTTP
            // request or accepting any content from a loopback process.
            webView.loadHTMLString("<!doctype html><html><body></body></html>", baseURL: PrototypeStorage.legacyOrigin)
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        applyTextSize()
    }

    /// The scripts every workspace document starts with. The viewport one
    /// carries the text size's zoom, so they are installed again when it
    /// changes, for the documents loaded after.
    private func installUserScripts(in controller: WKUserContentController) {
        controller.removeAllUserScripts()
        // Tests stay offline: they keep the switch forced off.
        if testing || !UserDefaults.standard.bool(forKey: Self.cloudSwitchReleased) {
            controller.addUserScript(WKUserScript(
                source: testing ? "localStorage.setItem('\(Self.cloudSwitchKey)', 'false');"
                    : "localStorage.removeItem('\(Self.cloudSwitchKey)');",
                injectionTime: .atDocumentStart, forMainFrameOnly: true
            ))
        }
        for source in idiom.documentStartScripts {
            controller.addUserScript(WKUserScript(
                source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true
            ))
        }
        controller.addUserScript(WKUserScript(
            source: WorkspaceIdiom.viewportScript(zoom: textZoom),
            injectionTime: .atDocumentEnd, forMainFrameOnly: true
        ))
    }

    /// Zooms the workspace for the iOS text size (`WorkspaceIdiom.pageZoom`),
    /// in the document on screen and in every one loaded after. The shorter
    /// side keeps the zoom the same in both orientations.
    private func applyTextSize() {
        guard let webView, view.bounds.width > 0 else { return }
        let zoom = WorkspaceIdiom.pageZoom(
            for: traitCollection.preferredContentSizeCategory,
            shortSide: min(view.bounds.width, view.bounds.height)
        )
        guard zoom != textZoom else { return }
        textZoom = zoom
        installUserScripts(in: webView.configuration.userContentController)
        webView.evaluateJavaScript(WorkspaceIdiom.viewportScript(zoom: zoom))
    }

    private func showFailure(_ message: String) {
        failureLabel?.removeFromSuperview()
        let label = UILabel()
        failureLabel = label
        label.text = message
        label.numberOfLines = 0
        label.textAlignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24)
        ])
    }

    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if bootstrap == .legacy && (url.scheme == "about" || (url.scheme == "http" && url.host == "127.0.0.1" && url.port == 27183 && url.path == "/")) {
            decisionHandler(.allow)
            return
        }
        if navigationAction.shouldPerformDownload &&
            (url.scheme == "blob" || Self.isWorkspaceURL(url)) {
            decisionHandler(.download)
        } else {
            // `/api/*` is data for fetch, never a document.
            decisionHandler(Self.isWorkspaceURL(url) && !BundleServer.isApiRequest(url) ? .allow : .cancel)
        }
    }

    /// The native session's admission: the workspace's own web view, past
    /// its bootstrap, showing the workspace origin.
    private func admitsNative(_ candidate: WKWebView) -> Bool {
        candidate === webView && bootstrap == .workspace && bridgeInstalled
            && candidate.url.map(Self.isWorkspaceURL) == true
    }

    /// Registers the message handler, only for the workspace and only in
    /// the page's content world. Never in the legacy loopback bootstrap.
    private func installBridge() {
        guard !bridgeInstalled, bootstrap == .workspace, let bridge else { return }
        webView.configuration.userContentController.addScriptMessageHandler(
            bridge, contentWorld: .page, name: NativeBridge.name)
        bridgeInstalled = true
    }

    static func isWorkspaceURL(_ url: URL) -> Bool {
        url.scheme == BundleServer.scheme && url.host == "app" && url.port == nil
            && url.user == nil && url.password == nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        failureLabel?.removeFromSuperview()
        failureLabel = nil
        // A zoom that changed while this document was loading.
        if textZoom != 1 { webView.evaluateJavaScript(WorkspaceIdiom.viewportScript(zoom: textZoom)) }
        if !testing, bootstrap == .workspace, webView.url.map(Self.isWorkspaceURL) == true,
           !UserDefaults.standard.bool(forKey: Self.cloudSwitchReleased) {
            UserDefaults.standard.set(true, forKey: Self.cloudSwitchReleased)
            installUserScripts(in: webView.configuration.userContentController)
        }
        guard bootstrap != .workspace else { return }
        let generation = bootstrapGeneration
        Task { @MainActor in
            do {
                switch bootstrap {
                case .legacy:
                    let result = try await webView.callAsyncJavaScript(PrototypeStorage.collect, arguments: [:], in: nil, contentWorld: .page)
                    guard generation == bootstrapGeneration else { return }
                    guard let snapshot = result as? String else { throw URLError(.cannotDecodeContentData) }
                    pendingSnapshot = snapshot
                    bootstrap = .copy
                    webView.load(URLRequest(url: BundleServer.origin.appendingPathComponent(BundleServer.bootstrapPath)))
                case .copy:
                    guard let snapshot = pendingSnapshot else { throw URLError(.cannotDecodeContentData) }
                    _ = try await webView.callAsyncJavaScript(PrototypeStorage.restore, arguments: ["snapshot": snapshot], in: nil, contentWorld: .page)
                    guard generation == bootstrapGeneration else { return }
                    pendingSnapshot = nil
                    UserDefaults.standard.set(true, forKey: migrationDefaultsKey)
                    bootstrap = .workspace
                    installBridge()
                    webView.load(URLRequest(url: BundleServer.origin))
                case .workspace: break
                }
            } catch {
                guard generation == bootstrapGeneration else { return }
                #if DEBUG
                let failure = error as NSError
                print("Prototype bootstrap error", failure.domain, failure.code)
                #endif
                showFailure("Earlier prototype data could not be copied. Its original data is still on this device. Close the app and try again.")
            }
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(
        _ download: WKDownload, decideDestinationUsing response: URLResponse,
        suggestedFilename: String, completionHandler: @escaping (URL?) -> Void
    ) {
        do {
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let name = (suggestedFilename as NSString).lastPathComponent
            let safeName = name.isEmpty || name == "." || name == ".." ? "model.step" : name
            let destination = folder.appendingPathComponent(safeName)
            downloads[ObjectIdentifier(download)] = destination
            completionHandler(destination)
        } catch {
            completionHandler(nil)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        guard presentedViewController == nil else {
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
            return
        }
        exportedFile = file
        let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
        picker.delegate = self
        present(picker, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let file = downloads.removeValue(forKey: ObjectIdentifier(download)) {
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        }
        let alert = UIAlertController(title: "Export failed", message: "The file could not be prepared. Try exporting again.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        if presentedViewController == nil { present(alert, animated: true) }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finishExport() }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finishExport()
    }

    private func finishExport() {
        if let file = exportedFile { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        exportedFile = nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        bootstrapGeneration += 1
        guard processRecoveries < 2 else {
            showFailure("The CAD workspace restarted repeatedly. Your saved data is still on this device. Close the app and try again.")
            return
        }
        processRecoveries += 1
        // Never turn the native-supplied legacy bootstrap into an HTTP reload.
        // Normal recovery returns to the private origin and its durable store.
        switch bootstrap {
        case .legacy:
            webView.loadHTMLString("<!doctype html><html><body></body></html>", baseURL: PrototypeStorage.legacyOrigin)
        case .copy:
            webView.load(URLRequest(url: BundleServer.origin.appendingPathComponent(BundleServer.bootstrapPath)))
        case .workspace:
            webView.load(URLRequest(url: BundleServer.origin))
        }
    }
}
