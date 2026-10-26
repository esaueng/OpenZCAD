//! Opens a fixed set of external pages in the system browser.
//!
//! The workspace's `target="_blank"` anchors do nothing in WKWebView: the shell
//! registers no new-window handler, so Wry returns no webview for them. Links
//! the app must be able to open go through this command instead. It hands the
//! system browser only an exact URL from the allowlist below, never a URL the
//! renderer composed, so a compromised renderer cannot use it to launch other
//! schemes, file paths or arbitrary sites.

use reqwest::Url;
use std::process::Command;

/// Every page the desktop app may open in the system browser, exactly.
const APPROVED_EXTERNAL_URLS: &[&str] = &[
    // The hosted service's privacy policy (Settings > Privacy & data, sign-in).
    "https://zcad.app/privacy",
    // Assistant provider data policies (Settings > Assistant).
    "https://openrouter.ai/docs/guides/privacy/provider-logging",
    "https://developers.openai.com/api/docs/guides/your-data",
];

pub(crate) fn approved_external_url(value: &str) -> Result<Url, String> {
    let refused = || "That link is not an approved OpenZCAD link.".to_string();
    let url = Url::parse(value).map_err(|_| refused())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !APPROVED_EXTERNAL_URLS.contains(&url.as_str())
    {
        return Err(refused());
    }
    Ok(url)
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let approved = approved_external_url(&url)?;
    // The URL is one argument to `open`; no shell sees it.
    Command::new("/usr/bin/open")
        .arg(approved.as_str())
        .spawn()
        .map_err(|_| "OpenZCAD could not open the system browser.".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{approved_external_url, APPROVED_EXTERNAL_URLS};

    #[test]
    fn accepts_each_allowlisted_page_exactly() {
        for url in APPROVED_EXTERNAL_URLS {
            assert_eq!(
                approved_external_url(url).map(|value| value.to_string()),
                Ok((*url).to_string())
            );
        }
    }

    #[test]
    fn refuses_other_schemes() {
        for url in [
            "http://zcad.app/privacy",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hello",
            "tauri://localhost/privacy",
            "ftp://zcad.app/privacy",
            "zcad.app/privacy",
            "//zcad.app/privacy",
            "",
        ] {
            assert!(approved_external_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn refuses_other_hosts_and_paths() {
        for url in [
            "https://evil.example/privacy",
            "https://zcad.app.evil.example/privacy",
            "https://evilzcad.app/privacy",
            "https://beta.zcad.app/privacy",
            "https://zcad.app/",
            "https://zcad.app/privacy/",
            "https://zcad.app/privacy.html",
            "https://zcad.app/api/auth/logout",
            "https://openrouter.ai/",
            "https://zcad.app/../privacy/../api",
        ] {
            assert!(approved_external_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn refuses_credentials_ports_queries_and_fragments() {
        for url in [
            "https://user@zcad.app/privacy",
            "https://user:secret@zcad.app/privacy",
            "https://:secret@zcad.app/privacy",
            "https://zcad.app@evil.example/privacy",
            "https://zcad.app:8443/privacy",
            "https://zcad.app/privacy?next=https://evil.example",
            "https://zcad.app/privacy?",
            "https://zcad.app/privacy#section",
            "https://zcad.app/privacy#",
        ] {
            assert!(approved_external_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn refuses_values_that_could_become_extra_arguments() {
        for url in [
            "-a Calculator",
            "--args https://zcad.app/privacy",
            " https://zcad.app/privacy -a Terminal",
            "https://zcad.app/privacy https://evil.example",
        ] {
            assert!(approved_external_url(url).is_err(), "{url}");
        }
    }
}
