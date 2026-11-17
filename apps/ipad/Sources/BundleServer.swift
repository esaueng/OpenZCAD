import Foundation
import WebKit

/// Resolves immutable bundled resources inside this app's WebKit process.
/// No socket, user-document endpoint, write API, or remote origin is exposed.
final class BundleServer: NSObject, WKURLSchemeHandler {
    static let scheme = "zcad-ipad"
    static let origin = URL(string: "zcad-ipad://app")!
    private let root: URL

    init(root: URL) { self.root = root }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url,
              WorkspaceViewController.isWorkspaceURL(url),
              task.request.httpMethod == "GET" || task.request.httpMethod == "HEAD" else {
            task.didFailWithError(URLError(.unsupportedURL))
            return
        }
        let bootstrap = url.path == "/__native_bootstrap__"
        let resource = Self.resource(root: root, target: url.path.isEmpty ? "/" : url.path)
        let data = bootstrap ? Data("<!doctype html><html><body></body></html>".utf8)
            : resource.flatMap { try? Data(contentsOf: $0, options: .mappedIfSafe) }
        let policy = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; "
            + "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
            + "font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; "
            + "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
        let response = HTTPURLResponse(url: url, statusCode: data == nil ? 404 : 200,
            httpVersion: "HTTP/1.1", headerFields: [
                "Content-Type": bootstrap ? "text/html" : resource.map(Self.contentType) ?? "text/plain",
                "Content-Length": String(data?.count ?? 0),
                "Content-Security-Policy": policy,
                "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"
            ])!
        // Synchronous completion means no callback can outlive a cancelled task.
        task.didReceive(response)
        if task.request.httpMethod != "HEAD", let data { task.didReceive(data) }
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    static func resource(root: URL, target: String) -> URL? {
        guard target.hasPrefix("/"), !target.hasPrefix("//"),
              let path = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
                .first.flatMap({ String($0).removingPercentEncoding }),
              !path.contains("\0"), !path.contains("\\"),
              !path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else {
            return nil
        }
        let canonicalRoot = root.resolvingSymlinksInPath().standardizedFileURL
        let relative = path == "/" ? "index.html" : String(path.dropFirst())
        let candidate = canonicalRoot.appendingPathComponent(relative)
            .resolvingSymlinksInPath().standardizedFileURL
        guard candidate.path.hasPrefix(canonicalRoot.path + "/"),
              (try? candidate.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else {
            return nil
        }
        return candidate
    }

    static func contentType(_ url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "wasm": return "application/wasm"
        case "json", "webmanifest": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "pdf": return "application/pdf"
        default: return "application/octet-stream"
        }
    }

}
