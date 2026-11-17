import XCTest
import UIKit
import WebKit
@testable import ZCADiPad

final class BundleServerTests: XCTestCase {
    @MainActor
    func testEarlierPrototypeDataCopiesWithoutDeletingTheOriginal() async throws {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: UUID())
        let handler = SchemeProbe()
        configuration.setURLSchemeHandler(handler, forURLScheme: "zcad-probe")
        let web = WKWebView(frame: .zero, configuration: configuration)
        let navigation = NavigationProbe()
        web.navigationDelegate = navigation
        navigation.loaded = expectation(description: "legacy bootstrap")
        web.loadHTMLString("<!doctype html><html><body></body></html>", baseURL: PrototypeStorage.legacyOrigin)
        await fulfillment(of: [navigation.loaded!], timeout: 10)
        _ = try await web.callAsyncJavaScript("""
            const open = indexedDB.open('migration-vector', 3);
            open.onupgradeneeded = () => {
                const store = open.result.createObjectStore('models', {keyPath:'id'});
                store.createIndex('name', 'name', {unique:true});
            };
            const db = await new Promise((resolve,reject) => { open.onsuccess=()=>resolve(open.result); open.onerror=()=>reject(new Error(String(open.error))); });
            const shared = {value:42};
            await new Promise((resolve,reject) => {
                const tx = db.transaction('models','readwrite'); tx.oncomplete=resolve; tx.onerror=event=>reject(new Error(String(event.target.error))); tx.onabort=()=>reject(new Error(String(tx.error)));
                tx.objectStore('models').put({id:'project', name:'Original', date:new Date('2026-11-17T00:00:00Z'),
                    data:new Uint8Array([4,5,6]).subarray(1), file:new File(['source'], 'source.step', {type:'text/plain',lastModified:123}),
                    repeated:[shared,shared], map:new Map([['answer',42]]), big:123n, empty:undefined, negativeZero:-0});
            }); db.close(); localStorage.setItem('last-project','project');
            """, arguments: [:], in: nil, contentWorld: .page)
        let collected = try await web.callAsyncJavaScript(PrototypeStorage.collect, arguments: [:], in: nil, contentWorld: .page)
        let snapshot = try XCTUnwrap(collected as? String)
        navigation.loaded = expectation(description: "private bootstrap")
        web.load(URLRequest(url: URL(string: "zcad-probe://app/")!))
        await fulfillment(of: [navigation.loaded!], timeout: 10)
        _ = try await web.callAsyncJavaScript(PrototypeStorage.restore, arguments: ["snapshot": snapshot], in: nil, contentWorld: .page)
        let verify = """
            const open = indexedDB.open('migration-vector');
            const db = await new Promise((resolve,reject)=>{open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(new Error(String(open.error)));});
            const value = await new Promise((resolve,reject)=>{const r=db.transaction('models').objectStore('models').get('project');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error(String(r.error)));});
            const ok = db.version===3 && value.name==='Original' && value.date.toISOString()==='2026-11-17T00:00:00.000Z'
                && value.data instanceof Uint8Array && value.data.byteOffset===1 && [...value.data].join(',')==='5,6'
                && value.file.name==='source.step' && await value.file.text()==='source' && value.file.lastModified===123
                && value.repeated[0].value===42 && value.repeated[1].value===42 && value.map.get('answer')===42
                && value.big===123n && value.empty===undefined && Object.is(value.negativeZero,-0)
                && db.transaction('models').objectStore('models').index('name').unique && localStorage.getItem('last-project')==='project';
            db.close(); return ok;
            """
        let copied = try await web.callAsyncJavaScript(verify, arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual(copied as? Bool, true)
        // A retry is idempotent and never replaces completed private data.
        _ = try await web.callAsyncJavaScript(PrototypeStorage.restore, arguments: ["snapshot": snapshot], in: nil, contentWorld: .page)
        navigation.loaded = expectation(description: "original storage retained")
        web.loadHTMLString("<!doctype html><html><body></body></html>", baseURL: PrototypeStorage.legacyOrigin)
        await fulfillment(of: [navigation.loaded!], timeout: 10)
        let original = try await web.callAsyncJavaScript(verify, arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual(original as? Bool, true)
        await configuration.websiteDataStore.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
    }

    @MainActor
    func testPrivateSchemeSupportsWorkersAndStorage() async throws {
        let configuration = WKWebViewConfiguration()
        let handler = SchemeProbe()
        configuration.setURLSchemeHandler(handler, forURLScheme: "zcad-probe")
        configuration.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 300, height: 300), configuration: configuration)
        let navigation = NavigationProbe()
        web.navigationDelegate = navigation
        let loaded = expectation(description: "private scheme loaded")
        navigation.loaded = loaded
        web.load(URLRequest(url: URL(string: "zcad-probe://app/")!))
        await fulfillment(of: [loaded], timeout: 10)
        let result = try await web.callAsyncJavaScript("""
            const result = { secure: isSecureContext, worker: false, storage: false };
            try {
                await new Promise((resolve, reject) => {
                    const worker = new Worker('zcad-probe://app/worker.js', { type: 'module' });
                    worker.onmessage = () => { result.worker = true; worker.terminate(); resolve(); };
                    worker.onerror = reject;
                });
            } catch (error) { result.error = String(error); }
            try { await new Promise((resolve, reject) => {
                const db = indexedDB.open('private-scheme-probe');
                db.onsuccess = () => { db.result.close(); result.storage = true; resolve(); };
                db.onerror = reject;
            }); } catch (error) { result.storageError = String(error); }
            return result;
            """, arguments: [:], in: nil, contentWorld: .page)
        let values = try XCTUnwrap(result as? [String: Any])
        XCTAssertEqual(values["secure"] as? Bool, true)
        XCTAssertEqual(values["worker"] as? Bool, true, String(describing: result))
        XCTAssertEqual(values["storage"] as? Bool, true, String(describing: result))
    }

    func testInstalledAppContainsTheIPadHomeScreenIcon() throws {
        let icons = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "CFBundleIcons~ipad") as? [String: Any])
        let primary = try XCTUnwrap(icons["CFBundlePrimaryIcon"] as? [String: Any])
        let files = try XCTUnwrap(primary["CFBundleIconFiles"] as? [String])
        XCTAssertFalse(files.isEmpty)
        for file in files {
            XCTAssertNotNil(UIImage(named: file))
        }
    }

    func testOnlyPackagedRegularFilesAreReadable() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let index = root.appendingPathComponent("index.html")
        try Data("cad".utf8).write(to: index)
        XCTAssertEqual(BundleServer.resource(root: root, target: "/"), index)
        XCTAssertEqual(BundleServer.resource(root: root, target: "/index.html?v=1"), index)
        for path in ["/../Info.plist", "/%2e%2e/Info.plist", "/%2e%2e%2fInfo.plist", "//example.com/x", "/missing", "/%00", "/a\\b", "https://example.com/"] {
            XCTAssertNil(BundleServer.resource(root: root, target: path), path)
        }
        let link = root.appendingPathComponent("escape")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: root.deletingLastPathComponent())
        XCTAssertNil(BundleServer.resource(root: root, target: "/escape"))
        XCTAssertEqual(BundleServer.contentType(URL(fileURLWithPath: "kernel.wasm")), "application/wasm")
        XCTAssertEqual(BundleServer.contentType(URL(fileURLWithPath: "worker.js")), "text/javascript; charset=utf-8")
    }

    func testNavigationStaysOnThePersistentWorkspaceOrigin() {
        XCTAssertTrue(WorkspaceViewController.isWorkspaceURL(BundleServer.origin))
        for value in ["http://127.0.0.1:27183", "zcad-ipad://example.com", "zcad-ipad://app:80", "zcad-ipad://user@app", "file:///etc/passwd"] {
            XCTAssertFalse(WorkspaceViewController.isWorkspaceURL(URL(string: value)!))
        }
    }
}

private final class SchemeProbe: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let url = urlSchemeTask.request.url!
        let worker = url.path == "/worker.js"
        let bytes = Data((worker ? "postMessage('ready');" : "<!doctype html><html><body>Probe</body></html>").utf8)
        urlSchemeTask.didReceive(URLResponse(url: url, mimeType: worker ? "text/javascript" : "text/html", expectedContentLength: bytes.count, textEncodingName: "utf-8"))
        urlSchemeTask.didReceive(bytes)
        urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

private final class NavigationProbe: NSObject, WKNavigationDelegate {
    var loaded: XCTestExpectation?
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }
}
