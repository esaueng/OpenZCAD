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

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

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
        let server = BundleServer(root: root)
        self.server = server
        configuration.setURLSchemeHandler(server, forURLScheme: BundleServer.scheme)
        // A bounded local-only prototype. Reuse the app's existing cloud gate
        // before any module reads it; no credentials or E2EE contracts change.
        configuration.userContentController.addUserScript(WKUserScript(
            source: "localStorage.setItem('openzcad-cloud-functions-enabled:v1', 'false');",
            injectionTime: .atDocumentStart, forMainFrameOnly: true
        ))
        configuration.userContentController.addUserScript(WKUserScript(
            source: """
            const viewport = document.querySelector('meta[name="viewport"]');
            if (viewport && !viewport.content.includes('viewport-fit=')) {
                viewport.content += ', viewport-fit=cover';
            }
            """,
            injectionTime: .atDocumentEnd, forMainFrameOnly: true
        ))
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.translatesAutoresizingMaskIntoConstraints = false
        #if DEBUG
        webView.isInspectable = true
        #endif
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        if UserDefaults.standard.bool(forKey: migrationDefaultsKey) {
            webView.load(URLRequest(url: BundleServer.origin))
        } else {
            bootstrap = .legacy
            // The bootstrap HTML is supplied by native code. Its base URL
            // selects the earlier IndexedDB origin without making an HTTP
            // request or accepting any content from a loopback process.
            webView.loadHTMLString("<!doctype html><html><body></body></html>", baseURL: PrototypeStorage.legacyOrigin)
        }
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
            decisionHandler(Self.isWorkspaceURL(url) ? .allow : .cancel)
        }
    }

    static func isWorkspaceURL(_ url: URL) -> Bool {
        url.scheme == BundleServer.scheme && url.host == "app" && url.port == nil
            && url.user == nil && url.password == nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        failureLabel?.removeFromSuperview()
        failureLabel = nil
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
                    webView.load(URLRequest(url: BundleServer.origin.appendingPathComponent("__native_bootstrap__")))
                case .copy:
                    guard let snapshot = pendingSnapshot else { throw URLError(.cannotDecodeContentData) }
                    _ = try await webView.callAsyncJavaScript(PrototypeStorage.restore, arguments: ["snapshot": snapshot], in: nil, contentWorld: .page)
                    guard generation == bootstrapGeneration else { return }
                    pendingSnapshot = nil
                    UserDefaults.standard.set(true, forKey: migrationDefaultsKey)
                    bootstrap = .workspace
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
            webView.load(URLRequest(url: BundleServer.origin.appendingPathComponent("__native_bootstrap__")))
        case .workspace:
            webView.load(URLRequest(url: BundleServer.origin))
        }
    }
}
