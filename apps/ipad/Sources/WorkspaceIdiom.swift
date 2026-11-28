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

    /// The web workspace's zoom for the person's iOS text size. The web app
    /// sets its type in CSS pixels, so the text size reaches it only through
    /// the page's zoom: the default size (Large, a 17 pt body) is 1, and each
    /// larger size zooms by its body size over 17. Smaller sizes stay at 1,
    /// which keeps every control at its full touch size. Zoom narrows the
    /// page as well, so it stops where the page would be narrower than the
    /// 320 CSS px the compact layout is built down to, and at 1.5 on any
    /// device: the largest accessibility sizes (a 53 pt body) get as much as
    /// a CAD workspace can hold, not their full size.
    static func pageZoom(bodyPointSize: CGFloat, shortSide: CGFloat) -> CGFloat {
        let wanted = bodyPointSize / defaultBodyPointSize
        let ceiling = min(maximumPageZoom, shortSide / minimumPageWidth)
        let zoom = min(max(wanted, 1), max(ceiling, 1))
        return (zoom * 100).rounded() / 100
    }

    /// The zoom for a text size, read from the system's own body font.
    static func pageZoom(for category: UIContentSizeCategory, shortSide: CGFloat) -> CGFloat {
        let traits = UITraitCollection(preferredContentSizeCategory: category)
        let body = UIFont.preferredFont(forTextStyle: .body, compatibleWith: traits).pointSize
        return pageZoom(bodyPointSize: body, shortSide: shortSide)
    }

    static let defaultBodyPointSize: CGFloat = 17
    static let minimumPageWidth: CGFloat = 320
    static let maximumPageZoom: CGFloat = 1.5

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
