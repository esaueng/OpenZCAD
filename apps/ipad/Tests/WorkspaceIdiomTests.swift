import XCTest
import UIKit
import WebKit
@testable import ZCADiPad

final class WorkspaceIdiomTests: XCTestCase {
    func testPhoneAndTabletShellDecisions() {
        XCTAssertEqual(WorkspaceIdiom(.phone), .phone)
        XCTAssertEqual(WorkspaceIdiom(.pad), .tablet)
        XCTAssertEqual(WorkspaceIdiom(.unspecified), .tablet)

        XCTAssertFalse(WorkspaceIdiom.phone.prefersStatusBarHidden)
        XCTAssertEqual(WorkspaceIdiom.phone.supportedOrientations, .allButUpsideDown)
        XCTAssertEqual(WorkspaceIdiom.phone.documentStartScripts, [WorkspaceIdiom.seedCompactLayout])

        XCTAssertTrue(WorkspaceIdiom.tablet.prefersStatusBarHidden)
        XCTAssertEqual(WorkspaceIdiom.tablet.supportedOrientations, .all)
        XCTAssertEqual(WorkspaceIdiom.tablet.documentStartScripts, [])
    }

    func testWorkspaceFollowsTheHostDevice() {
        let phone = UIDevice.current.userInterfaceIdiom == .phone
        let controller = WorkspaceViewController()
        XCTAssertEqual(controller.prefersStatusBarHidden, !phone)
        XCTAssertTrue(controller.prefersHomeIndicatorAutoHidden)
        XCTAssertEqual(controller.supportedInterfaceOrientations, phone ? .allButUpsideDown : .all)
    }

    func testInfoPlistOrientationsMatchTheShell() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "Info", withExtension: "plist"))
        let info = try XCTUnwrap(PropertyListSerialization.propertyList(
            from: Data(contentsOf: url), format: nil) as? [String: Any])
        func mask(_ key: String) throws -> UIInterfaceOrientationMask {
            let names = try XCTUnwrap(info[key] as? [String], key)
            XCTAssertEqual(Set(names).count, names.count, key)
            return names.reduce(into: []) { mask, name in
                switch name {
                case "UIInterfaceOrientationPortrait": mask.insert(.portrait)
                case "UIInterfaceOrientationPortraitUpsideDown": mask.insert(.portraitUpsideDown)
                case "UIInterfaceOrientationLandscapeLeft": mask.insert(.landscapeLeft)
                case "UIInterfaceOrientationLandscapeRight": mask.insert(.landscapeRight)
                default: XCTFail("Unexpected orientation \(name) in \(key)")
                }
            }
        }
        XCTAssertEqual(try mask("UISupportedInterfaceOrientations~iphone"), WorkspaceIdiom.phone.supportedOrientations)
        XCTAssertEqual(try mask("UISupportedInterfaceOrientations~ipad"), WorkspaceIdiom.tablet.supportedOrientations)
        XCTAssertEqual(info["UIDeviceFamily"] as? [Int], [1, 2])
    }

    @MainActor
    func testPhoneSeedsTheCompactLayoutOnceOnTheWorkspaceOrigin() async throws {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(BlankPage(), forURLScheme: BundleServer.scheme)
        for source in WorkspaceIdiom.phone.documentStartScripts {
            configuration.userContentController.addUserScript(WKUserScript(
                source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        let web = WKWebView(frame: .zero, configuration: configuration)
        let navigation = LoadProbe()
        web.navigationDelegate = navigation
        func load(_ start: (WKWebView) -> Void) async {
            navigation.loaded = expectation(description: "page loaded")
            start(web)
            await fulfillment(of: [navigation.loaded!], timeout: 10)
        }
        func layout() async throws -> String? {
            try await web.callAsyncJavaScript(
                "return localStorage.getItem(key);", arguments: ["key": WorkspaceIdiom.layoutPreferenceKey],
                in: nil, contentWorld: .page) as? String
        }

        await load { $0.load(URLRequest(url: BundleServer.origin)) }
        let seeded = try await layout()
        XCTAssertEqual(seeded, "compact")

        // A choice the person made is never replaced.
        _ = try await web.callAsyncJavaScript(
            "localStorage.setItem(key, 'full');", arguments: ["key": WorkspaceIdiom.layoutPreferenceKey],
            in: nil, contentWorld: .page)
        await load { $0.load(URLRequest(url: BundleServer.origin)) }
        let kept = try await layout()
        XCTAssertEqual(kept, "full")

        // The earlier prototype's origin is only read during its storage copy.
        await load { $0.loadHTMLString("<!doctype html><html><body></body></html>", baseURL: PrototypeStorage.legacyOrigin) }
        let legacy = try await layout()
        XCTAssertNil(legacy)
    }

    @MainActor
    func testCompactLayoutSeedToleratesUnavailableStorage() async throws {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(BlankPage(), forURLScheme: BundleServer.scheme)
        let web = WKWebView(frame: .zero, configuration: configuration)
        let navigation = LoadProbe()
        web.navigationDelegate = navigation
        navigation.loaded = expectation(description: "page loaded")
        web.load(URLRequest(url: BundleServer.origin))
        await fulfillment(of: [navigation.loaded!], timeout: 10)
        let result = try await web.callAsyncJavaScript("""
            const run = (storage, place = {protocol: 'zcad-ipad:', host: 'app', pathname: '/'}) => {
                new Function('localStorage', 'location', source)(storage, place);
            };
            const writes = [];
            const recording = value => ({ getItem: () => value, setItem: (...pair) => writes.push(pair.join('=')) });
            run(recording(null));
            run(recording('automatic'));
            run(recording(null), {protocol: 'http:', host: '127.0.0.1:27183', pathname: '/'});
            // The bootstrap page that restores the earlier prototype's storage.
            run(recording(null), {protocol: 'zcad-ipad:', host: 'app', pathname: '/__native_bootstrap__'});
            run({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } });
            run({ getItem: () => null, setItem() { throw new Error('quota'); } });
            return writes;
            """, arguments: ["source": WorkspaceIdiom.seedCompactLayout], in: nil, contentWorld: .page)
        XCTAssertEqual(result as? [String], ["\(WorkspaceIdiom.layoutPreferenceKey)=compact"])
    }
}

private final class BlankPage: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let url = urlSchemeTask.request.url!
        let bytes = Data("<!doctype html><html><body>Workspace</body></html>".utf8)
        urlSchemeTask.didReceive(URLResponse(url: url, mimeType: "text/html", expectedContentLength: bytes.count, textEncodingName: "utf-8"))
        urlSchemeTask.didReceive(bytes)
        urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

private final class LoadProbe: NSObject, WKNavigationDelegate {
    var loaded: XCTestExpectation?
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }
}
