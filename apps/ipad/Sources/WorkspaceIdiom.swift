import UIKit

/// The shell decisions that differ between an iPhone and an iPad.
/// Every other idiom (Mac Catalyst is off, Vision runs the iPad app) keeps the
/// tablet behaviour the app shipped with.
enum WorkspaceIdiom: Equatable {
    case phone
    case tablet

    init(_ idiom: UIUserInterfaceIdiom) {
        self = idiom == .phone ? .phone : .tablet
    }

    static var current: WorkspaceIdiom { WorkspaceIdiom(UIDevice.current.userInterfaceIdiom) }

    /// The phone shows its status bar so the web content's
    /// `env(safe-area-inset-*)` keeps clear of the notch or Dynamic Island.
    var prefersStatusBarHidden: Bool { self == .tablet }

    /// Matches `UISupportedInterfaceOrientations~iphone` and `~ipad`.
    var supportedOrientations: UIInterfaceOrientationMask {
        self == .phone ? .allButUpsideDown : .all
    }

    /// Scripts injected at document start for this idiom.
    var documentStartScripts: [String] {
        self == .phone ? [Self.seedCompactLayout] : []
    }

    /// The web app's per-device layout preference (`'automatic' | 'compact' |
    /// 'full'`), owned by the web settings code.
    static let layoutPreferenceKey = "openzcad.layout:v1"

    /// Opens the phone in the compact layout unless the person already chose
    /// one. Only the workspace document itself is touched: never the earlier
    /// prototype's origin, and never the native bootstrap page that restores
    /// its storage, so a copy that fails leaves nothing written. A storage
    /// failure leaves the web app on its own default.
    static let seedCompactLayout = """
    try {
        if (location.protocol === '\(BundleServer.scheme):' && location.host === '\(BundleServer.origin.host!)'
            && location.pathname !== '/\(BundleServer.bootstrapPath)'
            && localStorage.getItem('\(layoutPreferenceKey)') === null) {
            localStorage.setItem('\(layoutPreferenceKey)', 'compact');
        }
    } catch (error) {}
    """
}
