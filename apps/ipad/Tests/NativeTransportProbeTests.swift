import XCTest
import WebKit
@testable import ZCADiPad

/// Establishes the two WebKit behaviours ADR-026 left unverified before the
/// native session and proxy rely on them: whether the private origin is a
/// secure context with WebCrypto (ADR-024 needs it), and which request bodies
/// a `WKURLSchemeTask` receives (the `/api/*` proxy forwards them).
final class NativeTransportProbeTests: XCTestCase {
    @MainActor
    func testPrivateOriginIsASecureContextWithWebCrypto() async throws {
        let (web, _) = try await loadedProbe()
        let result = try await web.callAsyncJavaScript("""
            try {
            const pair = await crypto.subtle.generateKey({name:'ECDH', namedCurve:'P-256'}, false, ['deriveBits']);
            const aes = await crypto.subtle.generateKey({name:'AES-GCM', length:256}, false, ['encrypt']);
            const db = await new Promise((resolve, reject) => {
                const open = indexedDB.open('secure-context-probe', 1);
                open.onupgradeneeded = () => open.result.createObjectStore('keys');
                open.onsuccess = () => resolve(open.result);
                open.onerror = () => reject(open.error);
            });
            await new Promise((resolve, reject) => {
                const tx = db.transaction('keys', 'readwrite');
                tx.objectStore('keys').put(pair.privateKey, 'device');
                tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
            });
            db.close();
            return [isSecureContext, location.origin, pair.privateKey.extractable, aes.type].join('|');
            } catch (error) {
                return 'error:' + String(error) + ' secure=' + isSecureContext + ' subtle=' + typeof crypto.subtle;
            }
            """, arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual(result as? String, "true|zcad-ipad://app|false|secret")
    }

    /// String and byte bodies reach the scheme handler whole; a Blob does not.
    @MainActor
    func testSchemeTaskReceivesEveryRequestBodyShape() async throws {
        let (web, probe) = try await loadedProbe()
        let result = try await web.callAsyncJavaScript("""
            const big = new Uint8Array(8 * 1024 * 1024); big[big.length - 1] = 7;
            const cases = {
                string: JSON.stringify({a: 'b'.repeat(1000)}),
                uint8: new Uint8Array([1, 2, 3, 4]),
                arrayBuffer: new Uint8Array(65536).buffer,
                blob: new Blob([new Uint8Array(1024 * 1024)], {type: 'application/octet-stream'}),
                large: big,
            };
            const out = {};
            for (const [name, body] of Object.entries(cases)) {
                const response = await fetch('/api/probe/' + name, {method: 'POST', body,
                    headers: {'content-type': 'application/octet-stream', 'x-openzcad-probe': name}});
                out[name] = await response.text();
            }
            return JSON.stringify(out);
            """, arguments: [:], in: nil, contentWorld: .page)
        let echoed = try JSONDecoder().decode([String: String].self, from: Data(XCTUnwrap(result as? String).utf8))
        XCTAssertEqual(echoed["string"], "1008|probe:string")
        XCTAssertEqual(echoed["uint8"], "4|probe:uint8")
        XCTAssertEqual(echoed["arrayBuffer"], "65536|probe:arrayBuffer")
        // WebKit hands a scheme task no body at all for a Blob: neither
        // `httpBody` nor `httpBodyStream`. The web transport therefore sends
        // every body as bytes (`nativeShell.ts`), never as a Blob.
        XCTAssertEqual(echoed["blob"], "0|probe:blob")
        XCTAssertEqual(echoed["large"], "8388608|probe:large")
        // Recorded for the PR evidence: which carrier WebKit used per shape.
        print("Scheme body carriers:", probe.carriers.sorted { $0.key < $1.key })
    }

    @MainActor
    private func loadedProbe() async throws -> (WKWebView, BodyProbe) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: UUID())
        let probe = BodyProbe()
        configuration.setURLSchemeHandler(probe, forURLScheme: BundleServer.scheme)
        let web = WKWebView(frame: .zero, configuration: configuration)
        let navigation = LoadProbe()
        web.navigationDelegate = navigation
        navigation.loaded = expectation(description: "probe page")
        web.load(URLRequest(url: BundleServer.origin))
        await fulfillment(of: [navigation.loaded!], timeout: 60)
        return (web, probe)
    }
}

private final class BodyProbe: NSObject, WKURLSchemeHandler {
    var carriers: [String: String] = [:]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let request = task.request
        let url = request.url!
        var text = "<!doctype html><html><body>Probe</body></html>"
        var type = "text/html"
        if url.path.hasPrefix("/api/") {
            var body = request.httpBody ?? Data()
            var carrier = request.httpBody == nil ? "none" : "httpBody"
            if request.httpBody == nil, let stream = request.httpBodyStream {
                carrier = "stream"
                stream.open()
                var buffer = [UInt8](repeating: 0, count: 65536)
                while stream.hasBytesAvailable {
                    let read = stream.read(&buffer, maxLength: buffer.count)
                    if read <= 0 { break }
                    body.append(buffer, count: read)
                }
                stream.close()
            }
            let name = request.value(forHTTPHeaderField: "x-openzcad-probe") ?? "?"
            carriers[name] = carrier
            text = "\(body.count)|probe:\(name)"
            type = "text/plain"
        }
        let bytes = Data(text.utf8)
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": type, "Content-Length": String(bytes.count)])!)
        task.didReceive(bytes)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

private final class LoadProbe: NSObject, WKNavigationDelegate {
    var loaded: XCTestExpectation?
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }
}
