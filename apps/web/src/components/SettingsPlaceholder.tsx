/**
 * The frame of the Settings page with nothing in it, drawn while a Settings
 * left open before a reload waits for its chunk.
 *
 * A Settings opened by a click keeps the screen it was opened from on view
 * until its page loads. One restored at boot has no such screen: what lay
 * under it was the project library, still loading, and it flashed up for a
 * frame or several before Settings covered it. This stands in instead, built
 * from the page's own layout classes (which load with the app's stylesheet,
 * not the Settings chunk), so the real page lands on the same column and
 * head rather than replacing a different screen. The head keeps the save
 * note's and search field's boxes as well as the title: in a window just over
 * phone width the field wraps the head onto a second line, and without them
 * the rule would drop when the page arrives.
 */
export function SettingsPlaceholder() {
  return (
    <div
      className="settings-page"
      data-settings-placeholder=""
      aria-hidden="true"
    >
      <div className="settings-layout">
        <aside className="settings-nav" />
        <div className="settings-head">
          <span className="settings-head-title">Settings</span>
          <span className="settings-save-message" />
          <span className="settings-search" />
        </div>
      </div>
    </div>
  );
}
