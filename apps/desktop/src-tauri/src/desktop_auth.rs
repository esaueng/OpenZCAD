use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use reqwest::{redirect::Policy, Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    future::Future,
    process::Command,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::State;
use tokio::sync::{
    mpsc::{self, error::TryRecvError},
    Mutex as AsyncMutex,
};
use tokio::time::Instant;

const API_ORIGIN: &str = "https://zcad.app";
// `SHARE_LINK_TOKEN_HEADER` (packages/shared/src/share-link-token.ts): a share
// link's token travels here, not in the URL that request logs record.
const SHARE_TOKEN_HEADER: &str = "x-openzcad-share-token";
const DESKTOP_CLIENT_ID: &str = "openzcad-macos";
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "app.esau.openzcad";
#[cfg(target_os = "macos")]
const KEYCHAIN_ACCOUNT: &str = "desktop-refresh";
// At least `MAX_CLOUD_PROJECT_WRITE_BYTES` (packages/shared): a browser-split
// document write carries its payloads base64-encoded beside the document.
const MAX_NATIVE_API_BODY_BYTES: usize = 34 * 1024 * 1024;
const MAX_NATIVE_API_RESPONSE_BYTES: usize = 50 * 1024 * 1024;
// Encrypted content blobs stream instead (`desktop_blob_stream_*`): the most
// ciphertext the renderer accepts for the largest blob, a 128 MiB import source
// or mesh payload (`maxCiphertextBytes`: 1.3 times the plaintext plus 1 MiB,
// about 167.4 MiB), rounded up.
const MAX_NATIVE_BLOB_STREAM_BYTES: u64 = 168 * 1024 * 1024;
// Plaintext archived files use the project backup's existing 256 MiB ceiling.
const MAX_NATIVE_ARTIFACT_STREAM_BYTES: u64 = 256 * 1024 * 1024;
// Account metadata shares the browser data archive's 512 MiB ceiling.
const MAX_NATIVE_ACCOUNT_EXPORT_STREAM_BYTES: u64 = 512 * 1024 * 1024;
// Bytes one renderer read takes before it returns (plus one network chunk).
const NATIVE_BLOB_READ_BYTES: usize = 1024 * 1024;
// Network chunks a stream holds before it waits for the renderer to read.
const NATIVE_BLOB_BUFFERED_CHUNKS: usize = 16;
const MAX_NATIVE_BLOB_STREAMS: usize = 4;
// A stream the renderer stopped reading (a reloaded page) is let go after this.
const NATIVE_BLOB_STREAM_UNREAD: Duration = Duration::from_secs(60);
const NATIVE_BLOB_REAP_INTERVAL: Duration = Duration::from_secs(5);
// No progress for this long fails a download, as the renderer's idle budget
// does (`SOURCE_DOWNLOAD_IDLE_MS`); a slow but live transfer still completes.
const NATIVE_BLOB_IDLE: Duration = Duration::from_secs(30);
const BLOB_STREAM_TOO_LARGE: &str = "The OpenZCAD cloud download is too large.";
const BLOB_STREAM_STOPPED: &str = "The OpenZCAD cloud download stopped.";
const TOKEN_REFRESH_SKEW_SECONDS: u64 = 30;
// Credentials readied for project requests and not yet sent; past this the
// oldest is dropped, and its request is answered locally with a 401.
const MAX_PREPARED_ACCESS: usize = 64;
#[cfg(target_os = "macos")]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

#[derive(Clone)]
struct PendingAuthorization {
    attempt_id: String,
    state: String,
    verifier: String,
    expires_at: u64,
}

#[derive(Clone)]
struct AccessCredential {
    token: String,
    expires_at: u64,
}

/// One credential readied for one project request (`desktop_prepare_access`),
/// immutable once readied: the request is sent with exactly this token, or
/// answered locally with a 401 when the signed-in session it was readied in
/// has ended or it expired. Never the credential the state holds at the send.
#[derive(Clone, Debug, PartialEq)]
struct PreparedAccess {
    token: String,
    expires_at: u64,
    /// `DesktopAuthState::session` when it was readied.
    session: u64,
    /// Readying order, so a full table drops its oldest entry.
    issued: u64,
}

pub struct DesktopAuthState {
    client: Client,
    // No total timeout: a 168 MiB blob on a slow link outlasts any fixed one.
    // Connecting and every read get the idle budget instead.
    blob_client: Client,
    pending: Mutex<Option<PendingAuthorization>>,
    access: Mutex<Option<AccessCredential>>,
    refresh_guard: AsyncMutex<()>,
    blob_streams: Arc<Mutex<HashMap<String, BlobStream>>>,
    /// The signed-in session's generation: moved on every sign-in, sign-out,
    /// refused refresh and profile deletion, never by a refresh of the same
    /// session. A readied credential from an earlier generation is not sent.
    session: AtomicU64,
    /// Credentials readied for project requests, by opaque handle; each is
    /// taken (removed) by the one send it was readied for.
    prepared: Mutex<HashMap<String, PreparedAccess>>,
    prepared_issued: AtomicU64,
}

impl DesktopAuthState {
    pub fn new() -> Self {
        let blob_streams = Arc::new(Mutex::new(HashMap::new()));
        tauri::async_runtime::spawn(reap_blob_streams(Arc::downgrade(&blob_streams)));
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(30))
                .redirect(Policy::none())
                .build()
                .expect("desktop HTTPS client configuration is valid"),
            blob_client: Client::builder()
                .connect_timeout(NATIVE_BLOB_IDLE)
                .read_timeout(NATIVE_BLOB_IDLE)
                .redirect(Policy::none())
                .build()
                .expect("desktop HTTPS download client configuration is valid"),
            pending: Mutex::new(None),
            access: Mutex::new(None),
            refresh_guard: AsyncMutex::new(()),
            blob_streams,
            session: AtomicU64::new(0),
            prepared: Mutex::new(HashMap::new()),
            prepared_issued: AtomicU64::new(0),
        }
    }
}

/// Ends the signed-in session here: drops the credential, moves the session
/// generation, and drops every credential readied in the session that ended,
/// so no project request readied before is sent with it or a later one's.
fn end_session(state: &DesktopAuthState) -> Result<(), String> {
    *state
        .access
        .lock()
        .map_err(|_| "Desktop auth state is unavailable.")? = None;
    state.session.fetch_add(1, Ordering::SeqCst);
    state
        .prepared
        .lock()
        .map_err(|_| "Desktop auth state is unavailable.")?
        .clear();
    Ok(())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAuthSession {
    user_id: String,
    display_name: String,
    email: Option<String>,
    mode: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAuthStartResult {
    expires_in_seconds: u64,
    user_code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAuthPollResult {
    status: &'static str,
    session: Option<DesktopAuthSession>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartResponse {
    attempt_id: String,
    browser_url: String,
    expires_in_seconds: u64,
    user_code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenResponse {
    status: String,
    session: DesktopAuthSession,
    access_token: String,
    access_expires_at: u64,
    refresh_token: String,
    refresh_expires_at: u64,
}

#[derive(Deserialize)]
struct PendingResponse {
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollaborationTicketResponse {
    ticket: String,
    expires_at: u64,
}

#[derive(Deserialize)]
struct ErrorResponse {
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeApiRequest {
    method: String,
    path: String,
    content_type: Option<String>,
    body: Option<Vec<u8>>,
    /// A share link's capability token for a token-free share read, sent as
    /// `SHARE_TOKEN_HEADER` rather than in the URL (`share_link_destination`).
    share_token: Option<String>,
    /// A project request (`sendNativeProjectRequest` in `desktopBridge.ts`):
    /// the handle `desktop_prepare_access` returned for it. Sent with that
    /// readied credential only, or answered locally with a 401 when the
    /// handle is unknown (empty: none was readied), used, expired or from a
    /// session that has ended; a 401 is handed back to the renderer instead
    /// of being refreshed and replayed here, so the renderer checks its
    /// project gate before every send.
    #[serde(default)]
    prepared: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeApiResponse {
    status: u16,
    content_type: Option<String>,
    body: Vec<u8>,
}

fn now_seconds() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| "The system clock is not valid.".to_string())
}

fn random_secret() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Secure random generation is unavailable.".to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn api_url(path: &str) -> Result<Url, String> {
    if !path.starts_with("/api/") || path.contains('\0') {
        return Err("The desktop API path is not allowed.".to_string());
    }
    let url = Url::parse(&format!("{API_ORIGIN}{path}"))
        .map_err(|_| "The desktop API path is not valid.".to_string())?;
    if url.origin().ascii_serialization() != API_ORIGIN || !url.path().starts_with("/api/") {
        return Err("The desktop API path is not allowed.".to_string());
    }
    Ok(url)
}

struct RendererApiDestination {
    url: Url,
    public: bool,
    logout: bool,
}

fn renderer_lifecycle_path(path: &str) -> bool {
    (path == "/api/auth/desktop" || path.starts_with("/api/auth/desktop/"))
        && !matches!(
            path,
            "/api/auth/desktop/config" | "/api/auth/desktop/logout"
        )
}

/// A token or id in a route: what `encodeURIComponent` leaves unescaped of a
/// base64url or slug value, never an escape, dot segment or separator.
fn plain_route_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 256
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// An encrypted share link's anonymous reads (`/api/e2ee/share/{token}` and
/// `/api/e2ee/share/{token}/blobs/{blob_id}`): a signed-out visitor opens
/// them, and they never carry the account's credentials. Anything else under the
/// prefix, or an escaped segment, stays an ordinary authenticated request.
fn anonymous_share_read(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/api/e2ee/share/") else {
        return false;
    };
    let plain = plain_route_segment;
    match rest.split('/').collect::<Vec<_>>().as_slice() {
        [token] => plain(token),
        [token, "blobs", blob_id] => plain(token) && plain(blob_id),
        _ => false,
    }
}

fn renderer_api_destination(path: &str) -> Result<RendererApiDestination, String> {
    let mut url = api_url(path)?;
    // Classify the parsed destination before reading or refreshing native credentials.
    // Percent decoding is only a conservative deny check; it never rewrites a cloud request.
    if renderer_lifecycle_path(url.path()) {
        return Err("The desktop API path is not allowed.".to_string());
    }
    let mut decoded = Vec::with_capacity(url.path().len());
    for byte in url.path().bytes() {
        decoded.push(byte);
        // Collapse nested escapes as they arrive, in linear time even for deeply encoded input.
        while let Some(index) = decoded.len().checked_sub(3) {
            if decoded[index] != b'%' {
                break;
            }
            let hex = |byte: u8| (byte as char).to_digit(16).map(|value| value as u8);
            let (Some(high), Some(low)) = (hex(decoded[index + 1]), hex(decoded[index + 2])) else {
                break;
            };
            decoded.truncate(index);
            decoded.push(high * 16 + low);
        }
    }
    if let Ok(decoded) = String::from_utf8(decoded) {
        if let Ok(normalized) = Url::parse(&format!("{API_ORIGIN}{decoded}")) {
            if renderer_lifecycle_path(normalized.path()) {
                return Err("The desktop API path is not allowed.".to_string());
            }
        }
    }
    match url.path() {
        "/api/auth/config" => url.set_path("/api/auth/desktop/config"),
        "/api/auth/logout" => url.set_path("/api/auth/desktop/logout"),
        _ => {}
    }
    Ok(RendererApiDestination {
        public: matches!(url.path(), "/api/health" | "/api/auth/desktop/config")
            || anonymous_share_read(url.path()),
        logout: url.path() == "/api/auth/desktop/logout",
        url,
    })
}

/// The token-free share-link reads (packages/shared/src/share-link-token.ts):
/// `/api/share`, `/api/share/assets/{id}`, `/api/share/sources/{id}`,
/// `/api/e2ee/share` and `/api/e2ee/share/blobs/{id}`, whose token is the
/// request's `SHARE_TOKEN_HEADER`.
fn token_free_share_read(path: &str) -> bool {
    match path.split('/').collect::<Vec<_>>().as_slice() {
        ["", "api", "share"] | ["", "api", "e2ee", "share"] => true,
        // Ids come from the shared document as `encodeURIComponent` leaves
        // them; the parsed-form check in `share_link_destination` already
        // refuses separators, dot segments and anything the parser rewrote.
        ["", "api", "share", "assets" | "sources", id] => !id.is_empty() && id.len() <= 256,
        ["", "api", "e2ee", "share", "blobs", blob_id] => plain_route_segment(blob_id),
        _ => false,
    }
}

/// A request carrying a share-link token: only a GET of a token-free share
/// read, in its parsed form (no query, fragment, escape rewrite or dot
/// segment), with a token that is one plain route segment (the Worker's
/// `^[A-Za-z0-9_-]{1,256}$`, so never CR, LF or another header). It is
/// anonymous: the token is its whole authorization, and the account's
/// credentials are never sent with it.
fn share_link_destination(
    method: &str,
    path: &str,
    token: &str,
) -> Result<RendererApiDestination, String> {
    let refused = || "The desktop share-link request is not allowed.".to_string();
    if method != "GET" || !plain_route_segment(token) {
        return Err(refused());
    }
    let url = api_url(path)?;
    if url.path() != path || !token_free_share_read(path) {
        return Err(refused());
    }
    Ok(RendererApiDestination {
        url,
        public: true,
        logout: false,
    })
}

/// The destination of a renderer request: a share-link read when it carries a
/// token, otherwise `renderer_api_destination`.
fn request_destination(request: &NativeApiRequest) -> Result<RendererApiDestination, String> {
    match request.share_token.as_deref() {
        Some(token) => share_link_destination(&request.method, &request.path, token),
        None => renderer_api_destination(&request.path),
    }
}

struct BlobStreamDestination {
    url: Url,
    public: bool,
    max_bytes: u64,
}

/// An encrypted share blob streamed with its link's token in
/// `SHARE_TOKEN_HEADER` (`/api/e2ee/share/blobs/{blob_id}`); every other
/// share-token stream is refused.
fn share_link_blob_stream_destination(
    path: &str,
    token: &str,
) -> Result<BlobStreamDestination, String> {
    let refused = || "The desktop download path is not allowed.".to_string();
    let destination = share_link_destination("GET", path, token).map_err(|_| refused())?;
    match path.split('/').collect::<Vec<_>>().as_slice() {
        ["", "api", "e2ee", "share", "blobs", blob_id] if blob_id_segment(blob_id) => {
            Ok(BlobStreamDestination {
                url: destination.url,
                public: true,
                max_bytes: MAX_NATIVE_BLOB_STREAM_BYTES,
            })
        }
        _ => Err(refused()),
    }
}

fn blob_id_segment(segment: &str) -> bool {
    segment.len() == 32
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Stream only anonymous encrypted share blobs, authenticated project blobs,
/// and authenticated archived artifacts/account exports. The path must already be in its
/// parsed form (no query, fragment,
/// escape or dot segment) and classify exactly as `desktop_api_request` would.
fn blob_stream_destination(path: &str) -> Result<BlobStreamDestination, String> {
    let refused = || "The desktop download path is not allowed.".to_string();
    let url = api_url(path)?;
    if url.path() != path {
        return Err(refused());
    }
    let (public, max_bytes) = match path.split('/').collect::<Vec<_>>().as_slice() {
        ["", "api", "e2ee", "share", token, "blobs", blob_id]
            if plain_route_segment(token) && blob_id_segment(blob_id) =>
        {
            (true, MAX_NATIVE_BLOB_STREAM_BYTES)
        }
        ["", "api", "e2ee", "projects", project_id, "blobs", blob_id]
            if plain_route_segment(project_id) && blob_id_segment(blob_id) =>
        {
            (false, MAX_NATIVE_BLOB_STREAM_BYTES)
        }
        ["", "api", "artifacts", artifact_id, "download"] if plain_route_segment(artifact_id) => {
            (false, MAX_NATIVE_ARTIFACT_STREAM_BYTES)
        }
        ["", "api", "account", "export"] => (false, MAX_NATIVE_ACCOUNT_EXPORT_STREAM_BYTES),
        _ => return Err(refused()),
    };
    let general = renderer_api_destination(path)?;
    if general.public != public || general.logout || general.url != url {
        return Err(refused());
    }
    Ok(BlobStreamDestination {
        url,
        public,
        max_bytes,
    })
}

fn collaboration_api_url(project_id: &str, ticket_endpoint: bool) -> Result<Url, String> {
    if project_id.is_empty()
        || project_id.len() > 256
        || !project_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("The collaboration project id is not valid.".to_string());
    }
    api_url(&format!(
        "/api/projects/{project_id}/collaboration{}",
        if ticket_endpoint { "/ticket" } else { "" }
    ))
}

fn collaboration_socket_url(project_id: &str, ticket: &str) -> Result<Url, String> {
    if ticket.len() != 43
        || !ticket
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("The collaboration ticket is invalid.".to_string());
    }
    let mut url = collaboration_api_url(project_id, false)?;
    url.set_scheme("wss")
        .map_err(|_| "The collaboration URL is invalid.".to_string())?;
    url.query_pairs_mut().append_pair("ticket", ticket);
    Ok(url)
}

fn approved_browser_url(value: &str, attempt_id: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "The sign-in URL is invalid.".to_string())?;
    if url.scheme() != "https"
        || url.origin().ascii_serialization() != API_ORIGIN
        || url.path() != "/"
        || url
            .query_pairs()
            .any(|(key, value)| key == "desktopAuth" && value.as_ref() != attempt_id)
        || !url
            .query_pairs()
            .any(|(key, value)| key == "desktopAuth" && value.as_ref() == attempt_id)
    {
        return Err("The sign-in URL is not an approved OpenZCAD URL.".to_string());
    }
    Ok(url)
}

async fn server_error(response: reqwest::Response, fallback: &str) -> String {
    response
        .json::<ErrorResponse>()
        .await
        .ok()
        .and_then(|payload| payload.error)
        .filter(|message| !message.trim().is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

#[cfg(target_os = "macos")]
fn load_refresh_credential() -> Result<Option<String>, String> {
    use security_framework::passwords::get_generic_password;
    match get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "The saved desktop credential is invalid.".to_string()),
        Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
        Err(_) => Err("OpenZCAD could not read its Keychain credential.".to_string()),
    }
}

#[cfg(not(target_os = "macos"))]
fn load_refresh_credential() -> Result<Option<String>, String> {
    Err("Desktop credentials require macOS Keychain.".to_string())
}

#[cfg(target_os = "macos")]
fn save_refresh_credential(token: &str) -> Result<(), String> {
    security_framework::passwords::set_generic_password(
        KEYCHAIN_SERVICE,
        KEYCHAIN_ACCOUNT,
        token.as_bytes(),
    )
    .map_err(|_| "OpenZCAD could not save its Keychain credential.".to_string())
}

#[cfg(not(target_os = "macos"))]
fn save_refresh_credential(_token: &str) -> Result<(), String> {
    Err("Desktop credentials require macOS Keychain.".to_string())
}

#[cfg(target_os = "macos")]
fn delete_refresh_credential() -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    {
        Ok(()) => Ok(()),
        Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
        Err(_) => Err("OpenZCAD could not remove its Keychain credential.".to_string()),
    }
}

#[cfg(not(target_os = "macos"))]
fn delete_refresh_credential() -> Result<(), String> {
    Err("Desktop credentials require macOS Keychain.".to_string())
}

fn install_token_response(
    state: &DesktopAuthState,
    response: &TokenResponse,
) -> Result<(), String> {
    if response.status != "authorized"
        || response.access_token.len() != 43
        || response.refresh_token.len() != 43
        || response.refresh_expires_at <= response.access_expires_at
    {
        return Err("The desktop sign-in server returned an invalid session.".to_string());
    }
    save_refresh_credential(&response.refresh_token)?;
    *state
        .access
        .lock()
        .map_err(|_| "Desktop auth state is unavailable.")? = Some(AccessCredential {
        token: response.access_token.clone(),
        expires_at: response.access_expires_at,
    });
    Ok(())
}

async fn refresh_access(state: &DesktopAuthState) -> Result<Option<String>, String> {
    let _guard = state.refresh_guard.lock().await;
    let now = now_seconds()?;
    if let Some(access) = state
        .access
        .lock()
        .map_err(|_| "Desktop auth state is unavailable.")?
        .clone()
    {
        if access.expires_at > now + TOKEN_REFRESH_SKEW_SECONDS {
            return Ok(Some(access.token));
        }
    }
    let Some(refresh_token) = load_refresh_credential()? else {
        return Ok(None);
    };
    let response = state
        .client
        .post(api_url("/api/auth/desktop/refresh")?)
        .json(&serde_json::json!({
            "clientId": DESKTOP_CLIENT_ID,
            "refreshToken": refresh_token
        }))
        .send()
        .await
        .map_err(|_| "The OpenZCAD cloud service could not be reached.".to_string())?;
    if matches!(
        response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) {
        end_session(state)?;
        delete_refresh_credential()?;
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(server_error(response, "Cloud session refresh failed.").await);
    }
    let tokens = response
        .json::<TokenResponse>()
        .await
        .map_err(|_| "The desktop refresh response was invalid.".to_string())?;
    install_token_response(state, &tokens)?;
    Ok(Some(tokens.access_token))
}

async fn current_access(state: &DesktopAuthState) -> Result<Option<String>, String> {
    let now = now_seconds()?;
    if let Some(access) = state
        .access
        .lock()
        .map_err(|_| "Desktop auth state is unavailable.")?
        .clone()
    {
        if access.expires_at > now + TOKEN_REFRESH_SKEW_SECONDS {
            return Ok(Some(access.token));
        }
    }
    refresh_access(state).await
}

/// Readies the credential for one project request: refreshed first if it
/// is about to expire, then recorded, as it is now, under a new opaque
/// handle bound to the signed-in session. None when signed out, or when the
/// session changed while it was being readied.
async fn prepare_access(state: &DesktopAuthState) -> Result<Option<String>, String> {
    let session = state.session.load(Ordering::SeqCst);
    let Some(token) = current_access(state).await? else {
        return Ok(None);
    };
    let Some(expires_at) = state
        .access
        .lock()
        .map_err(|_| "Desktop auth state is unavailable.")?
        .as_ref()
        .filter(|access| access.token == token)
        .map(|access| access.expires_at)
    else {
        return Ok(None);
    };
    let handle = random_secret()?;
    let now = now_seconds()?;
    let mut prepared = state
        .prepared
        .lock()
        .map_err(|_| "Desktop auth state is unavailable.")?;
    // Checked under the table's lock, which `end_session` clears after it
    // moves the session: an entry is never added for a session that ended.
    if state.session.load(Ordering::SeqCst) != session {
        return Ok(None);
    }
    admit_prepared(
        &mut prepared,
        handle.clone(),
        PreparedAccess {
            token,
            expires_at,
            session,
            issued: state.prepared_issued.fetch_add(1, Ordering::SeqCst),
        },
        now,
    );
    Ok(Some(handle))
}

/// Adds a readied credential, dropping expired ones and, past
/// `MAX_PREPARED_ACCESS`, the oldest: a request whose credential was
/// dropped is answered locally with a 401 and readies another.
fn admit_prepared(
    prepared: &mut HashMap<String, PreparedAccess>,
    handle: String,
    access: PreparedAccess,
    now: u64,
) {
    prepared.retain(|_, entry| entry.expires_at > now);
    while prepared.len() >= MAX_PREPARED_ACCESS {
        let Some(oldest) = prepared
            .iter()
            .min_by_key(|(_, entry)| entry.issued)
            .map(|(handle, _)| handle.clone())
        else {
            break;
        };
        prepared.remove(&oldest);
    }
    prepared.insert(handle, access);
}

/// The credential readied under `handle`, taken so it is sent once: exactly
/// that token, never the one the state holds now, and only while it has not
/// expired and its session has not ended. Never refreshed, so taking it
/// sends nothing.
fn take_prepared_access(state: &DesktopAuthState, handle: &str) -> Result<Option<String>, String> {
    let now = now_seconds()?;
    let Some(access) = state
        .prepared
        .lock()
        .map_err(|_| "Desktop auth state is unavailable.")?
        .remove(handle)
    else {
        return Ok(None);
    };
    if access.session != state.session.load(Ordering::SeqCst) || access.expires_at <= now {
        return Ok(None);
    }
    Ok(Some(access.token))
}

/// Drops the credential the account refused, unless another has replaced it
/// meanwhile.
fn forget_access(state: &DesktopAuthState, token: &str) -> Result<(), String> {
    let mut access = state
        .access
        .lock()
        .map_err(|_| "Desktop auth state is unavailable.")?;
    if access.as_ref().is_some_and(|access| access.token == token) {
        *access = None;
    }
    Ok(())
}

/// Where an authenticated renderer request's credential comes from.
trait AccessSource {
    /// The credential readied earlier under `handle`, without refreshing it.
    fn prepared(&self, handle: &str) -> Result<Option<String>, String>;
    /// The credential, refreshed first when it is about to expire.
    fn current(&self) -> impl Future<Output = Result<Option<String>, String>> + Send;
    /// A fresh credential, after the account refused the one sent.
    fn refreshed(&self) -> impl Future<Output = Result<Option<String>, String>> + Send;
    /// Drops the credential the account refused.
    fn forget(&self, token: &str) -> Result<(), String>;
}

impl AccessSource for DesktopAuthState {
    fn prepared(&self, handle: &str) -> Result<Option<String>, String> {
        take_prepared_access(self, handle)
    }

    async fn current(&self) -> Result<Option<String>, String> {
        current_access(self).await
    }

    async fn refreshed(&self) -> Result<Option<String>, String> {
        refresh_access(self).await
    }

    fn forget(&self, token: &str) -> Result<(), String> {
        forget_access(self, token)
    }
}

/// What an authenticated send came to.
#[derive(Debug, PartialEq)]
enum Authenticated<R> {
    Sent(R),
    /// No credential: nothing was sent.
    SignedOut,
}

/// Sends a request that needs the account's credential. A `prepared` one
/// (a project request) uses exactly the credential readied for it under its
/// handle, and is sent at most once here: without one (unknown, used,
/// expired, or from a session that ended) nothing is sent, and a 401 drops
/// that credential; either goes back to the renderer as a 401, and the
/// renderer readies another and checks its project gate again before any
/// retry. Any other request refreshes an expiring credential first and,
/// after a 401, refreshes it and is sent once more.
async fn send_authenticated<A, R, F, Fut>(
    access: &A,
    prepared: Option<&str>,
    mut send: F,
    status: fn(&R) -> StatusCode,
) -> Result<Authenticated<R>, String>
where
    A: AccessSource,
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<R, String>>,
{
    let token = match prepared {
        Some(handle) => access.prepared(handle)?,
        None => access.current().await?,
    };
    let Some(token) = token else {
        return Ok(Authenticated::SignedOut);
    };
    let response = send(token.clone()).await?;
    if status(&response) != StatusCode::UNAUTHORIZED {
        return Ok(Authenticated::Sent(response));
    }
    access.forget(&token)?;
    if prepared.is_some() {
        return Ok(Authenticated::Sent(response));
    }
    match access.refreshed().await? {
        Some(token) => Ok(Authenticated::Sent(send(token).await?)),
        None => Ok(Authenticated::Sent(response)),
    }
}

/// Readies the credential one project request is then sent with
/// (`desktop_api_request` with `prepared` set to the handle returned here),
/// refreshing it first if it is about to expire. A refresh is a request of
/// its own, so it happens here, before the renderer's last check of the
/// project request, never between that check and the send. The handle
/// names this credential as it is now, for this signed-in session, for one
/// send; null when signed out.
#[tauri::command]
pub async fn desktop_prepare_access(
    state: State<'_, DesktopAuthState>,
) -> Result<Option<String>, String> {
    prepare_access(&state).await
}

#[tauri::command]
pub async fn start_desktop_sign_in(
    state: State<'_, DesktopAuthState>,
) -> Result<DesktopAuthStartResult, String> {
    let verifier = random_secret()?;
    let auth_state = random_secret()?;
    let response = state
        .client
        .post(api_url("/api/auth/desktop/start")?)
        .json(&serde_json::json!({
            "clientId": DESKTOP_CLIENT_ID,
            "state": auth_state,
            "codeChallenge": pkce_challenge(&verifier)
        }))
        .send()
        .await
        .map_err(|_| "The OpenZCAD cloud service could not be reached.".to_string())?;
    if !response.status().is_success() {
        return Err(server_error(response, "Desktop sign-in is unavailable.").await);
    }
    let started = response
        .json::<StartResponse>()
        .await
        .map_err(|_| "The desktop sign-in response was invalid.".to_string())?;
    let browser_url = approved_browser_url(&started.browser_url, &started.attempt_id)?;
    let expires_at = now_seconds()?
        .checked_add(started.expires_in_seconds)
        .ok_or_else(|| "The desktop sign-in expiry is invalid.".to_string())?;
    *state
        .pending
        .lock()
        .map_err(|_| "Desktop auth state is unavailable.")? = Some(PendingAuthorization {
        attempt_id: started.attempt_id,
        state: auth_state,
        verifier,
        expires_at,
    });
    Command::new("/usr/bin/open")
        .arg(browser_url.as_str())
        .spawn()
        .map_err(|_| "OpenZCAD could not open the system browser.".to_string())?;
    Ok(DesktopAuthStartResult {
        expires_in_seconds: started.expires_in_seconds,
        user_code: started.user_code,
    })
}

#[tauri::command]
pub async fn poll_desktop_sign_in(
    state: State<'_, DesktopAuthState>,
) -> Result<DesktopAuthPollResult, String> {
    let pending = state
        .pending
        .lock()
        .map_err(|_| "Desktop auth state is unavailable.")?
        .clone()
        .ok_or_else(|| "No desktop sign-in is in progress.".to_string())?;
    if pending.expires_at < now_seconds()? {
        *state
            .pending
            .lock()
            .map_err(|_| "Desktop auth state is unavailable.")? = None;
        return Err("The desktop sign-in attempt expired. Start again.".to_string());
    }
    let response = state
        .client
        .post(api_url("/api/auth/desktop/exchange")?)
        .json(&serde_json::json!({
            "attemptId": pending.attempt_id,
            "clientId": DESKTOP_CLIENT_ID,
            "state": pending.state,
            "verifier": pending.verifier
        }))
        .send()
        .await
        .map_err(|_| "The OpenZCAD cloud service could not be reached.".to_string())?;
    if response.status() == StatusCode::ACCEPTED {
        let pending_response = response
            .json::<PendingResponse>()
            .await
            .map_err(|_| "The desktop sign-in response was invalid.".to_string())?;
        if pending_response.status != "pending" {
            return Err("The desktop sign-in response was invalid.".to_string());
        }
        return Ok(DesktopAuthPollResult {
            status: "pending",
            session: None,
        });
    }
    if !response.status().is_success() {
        let error = server_error(response, "Desktop sign-in failed.").await;
        *state
            .pending
            .lock()
            .map_err(|_| "Desktop auth state is unavailable.")? = None;
        return Err(error);
    }
    let tokens = response
        .json::<TokenResponse>()
        .await
        .map_err(|_| "The desktop sign-in response was invalid.".to_string())?;
    // A new session: nothing readied in an earlier one is sent with it.
    end_session(&state)?;
    install_token_response(&state, &tokens)?;
    *state
        .pending
        .lock()
        .map_err(|_| "Desktop auth state is unavailable.")? = None;
    Ok(DesktopAuthPollResult {
        status: "authorized",
        session: Some(tokens.session),
    })
}

#[tauri::command]
pub fn cancel_desktop_sign_in(state: State<'_, DesktopAuthState>) -> Result<(), String> {
    *state
        .pending
        .lock()
        .map_err(|_| "Desktop auth state is unavailable.")? = None;
    Ok(())
}

fn local_unauthorized_response() -> NativeApiResponse {
    NativeApiResponse {
        status: 401,
        content_type: Some("application/json".to_string()),
        body: br#"{"error":"Authentication required.","code":"AUTH_REQUIRED"}"#.to_vec(),
    }
}

fn local_signed_out_response() -> NativeApiResponse {
    NativeApiResponse {
        status: 200,
        content_type: Some("application/json".to_string()),
        body: br#"{"ok":true}"#.to_vec(),
    }
}

async fn buffer_api_response(mut response: reqwest::Response) -> Result<NativeApiResponse, String> {
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    if response
        .content_length()
        .is_some_and(|length| length > MAX_NATIVE_API_RESPONSE_BYTES as u64)
    {
        return Err("The OpenZCAD cloud response is too large.".to_string());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The OpenZCAD cloud response ended early.".to_string())?
    {
        if body.len().saturating_add(chunk.len()) > MAX_NATIVE_API_RESPONSE_BYTES {
            return Err("The OpenZCAD cloud response is too large.".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(NativeApiResponse {
        status,
        content_type,
        body,
    })
}

/// Adds a share link's token as `SHARE_TOKEN_HEADER`, the one request header
/// the renderer can name besides the content type, refusing any value that is
/// not a plain route segment.
fn with_share_token(
    builder: reqwest::RequestBuilder,
    share_token: Option<&str>,
) -> Result<reqwest::RequestBuilder, String> {
    let Some(token) = share_token else {
        return Ok(builder);
    };
    if !plain_route_segment(token) {
        return Err("The desktop share-link request is not allowed.".to_string());
    }
    Ok(builder.header(SHARE_TOKEN_HEADER, token))
}

async fn send_api_request(
    state: &DesktopAuthState,
    request: &NativeApiRequest,
    url: &Url,
    access_token: Option<&str>,
) -> Result<reqwest::Response, String> {
    api_request_builder(&state.client, request, url, access_token)?
        .send()
        .await
        .map_err(|_| "The OpenZCAD cloud service could not be reached.".to_string())
}

fn api_request_builder(
    client: &Client,
    request: &NativeApiRequest,
    url: &Url,
    access_token: Option<&str>,
) -> Result<reqwest::RequestBuilder, String> {
    let method = Method::from_bytes(request.method.as_bytes())
        .map_err(|_| "The desktop API method is not allowed.".to_string())?;
    if !matches!(
        method,
        Method::GET | Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) {
        return Err("The desktop API method is not allowed.".to_string());
    }
    let mut builder = client.request(method, url.clone());
    if let Some(token) = access_token {
        builder = builder.bearer_auth(token);
    }
    builder = with_share_token(builder, request.share_token.as_deref())?;
    if let Some(content_type) = request.content_type.as_deref() {
        if content_type.len() > 128 || content_type.contains(['\r', '\n']) {
            return Err("The desktop API content type is invalid.".to_string());
        }
        builder = builder.header("content-type", content_type);
    }
    if let Some(body) = request.body.as_ref() {
        if body.len() > MAX_NATIVE_API_BODY_BYTES {
            return Err("The desktop API request is too large.".to_string());
        }
        builder = builder.body(body.clone());
    }
    Ok(builder)
}

fn request_deletes_cloud_profile(request: &NativeApiRequest) -> bool {
    if request.path != "/api/account/delete-data" || request.method != "POST" {
        return false;
    }
    let Some(body) = request.body.as_deref() else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("scope")
                .and_then(|scope| scope.as_str())
                .map(str::to_owned)
        })
        .is_some_and(|scope| matches!(scope.as_str(), "profile" | "all"))
}

#[tauri::command]
pub async fn desktop_api_request(
    state: State<'_, DesktopAuthState>,
    request: NativeApiRequest,
) -> Result<NativeApiResponse, String> {
    renderer_api_request(&state, request).await
}

async fn renderer_api_request(
    state: &DesktopAuthState,
    request: NativeApiRequest,
) -> Result<NativeApiResponse, String> {
    let destination = request_destination(&request)?;
    let url = &destination.url;
    if destination.logout {
        let response = match current_access(state).await {
            Ok(Some(token)) => send_api_request(state, &request, url, Some(&token))
                .await
                .ok(),
            Ok(None) | Err(_) => None,
        };
        end_session(state)?;
        delete_refresh_credential()?;
        return match response {
            Some(response) => buffer_api_response(response).await,
            None => Ok(local_signed_out_response()),
        };
    }
    let response = if destination.public {
        send_api_request(state, &request, url, None).await?
    } else {
        let request = &request;
        let sent = send_authenticated(
            state,
            request.prepared.as_deref(),
            |token: String| async move {
                send_api_request(state, request, url, Some(&token)).await
            },
            reqwest::Response::status,
        )
        .await?;
        match sent {
            Authenticated::Sent(response) => response,
            Authenticated::SignedOut => return Ok(local_unauthorized_response()),
        }
    };
    if response.status().is_success() && request_deletes_cloud_profile(&request) {
        end_session(state)?;
        delete_refresh_credential()?;
    }
    buffer_api_response(response).await
}

/// One network chunk after another; `Ok(None)` is the end of the body.
trait BlobChunkSource: Send {
    fn next_chunk(&mut self) -> impl Future<Output = Result<Option<Vec<u8>>, String>> + Send;
}

impl BlobChunkSource for reqwest::Response {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, String> {
        self.chunk()
            .await
            .map(|chunk| chunk.map(|bytes| bytes.to_vec()))
            .map_err(|_| BLOB_STREAM_STOPPED.to_string())
    }
}

enum BlobStreamEvent {
    Data(Vec<u8>),
    End,
    Failed(String),
}

/// Moves a download's body into its stream's bounded queue, so the network
/// waits whenever the renderer has not read the chunks before it. The body
/// may not pass `limit`; a queue whose reader went away ends the download.
async fn pump_blob_stream<S: BlobChunkSource>(
    mut source: S,
    sender: mpsc::Sender<BlobStreamEvent>,
    limit: u64,
) {
    let mut received: u64 = 0;
    loop {
        let event = match source.next_chunk().await {
            Ok(Some(chunk)) if chunk.is_empty() => continue,
            Ok(Some(chunk)) => {
                received = received.saturating_add(chunk.len() as u64);
                if received > limit {
                    BlobStreamEvent::Failed(BLOB_STREAM_TOO_LARGE.to_string())
                } else {
                    BlobStreamEvent::Data(chunk)
                }
            }
            Ok(None) => BlobStreamEvent::End,
            Err(message) => BlobStreamEvent::Failed(message),
        };
        let last = !matches!(event, BlobStreamEvent::Data(_));
        if sender.send(event).await.is_err() || last {
            return;
        }
    }
}

struct BlobStreamReader {
    receiver: mpsc::Receiver<BlobStreamEvent>,
    ended: bool,
}

impl BlobStreamReader {
    /// The bytes already downloaded, waiting for the first if there are none;
    /// empty once the body has ended. A body that stopped without its end (a
    /// cancelled or abandoned download) fails rather than reading as complete.
    async fn read(&mut self) -> Result<Vec<u8>, String> {
        if self.ended {
            return Ok(Vec::new());
        }
        let mut bytes = match self.receiver.recv().await {
            Some(BlobStreamEvent::Data(chunk)) => chunk,
            Some(BlobStreamEvent::End) => {
                self.ended = true;
                return Ok(Vec::new());
            }
            Some(BlobStreamEvent::Failed(message)) => return Err(message),
            None => return Err(BLOB_STREAM_STOPPED.to_string()),
        };
        while bytes.len() < NATIVE_BLOB_READ_BYTES {
            match self.receiver.try_recv() {
                Ok(BlobStreamEvent::Data(chunk)) => bytes.extend_from_slice(&chunk),
                Ok(BlobStreamEvent::End) => {
                    self.ended = true;
                    break;
                }
                Ok(BlobStreamEvent::Failed(message)) => return Err(message),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return Err(BLOB_STREAM_STOPPED.to_string()),
            }
        }
        Ok(bytes)
    }
}

struct BlobStream {
    reader: Arc<AsyncMutex<BlobStreamReader>>,
    pump: tauri::async_runtime::JoinHandle<()>,
    touched: Instant,
}

impl Drop for BlobStream {
    // Releasing a stream (finished, cancelled or abandoned) ends its download.
    fn drop(&mut self) {
        self.pump.abort();
    }
}

/// Room for one more stream, after letting go of any the renderer stopped
/// reading.
fn admit_blob_stream(
    streams: &mut HashMap<String, BlobStream>,
    now: Instant,
) -> Result<(), String> {
    streams.retain(|_, stream| {
        now.saturating_duration_since(stream.touched) < NATIVE_BLOB_STREAM_UNREAD
    });
    if streams.len() >= MAX_NATIVE_BLOB_STREAMS {
        return Err(
            "Too many OpenZCAD cloud downloads are running. Try again shortly.".to_string(),
        );
    }
    Ok(())
}

/// WebView reload loses the renderer's cleanup timers. Expire unread streams
/// independently of future commands, including pumps blocked on a full queue.
/// Hold only a Weak reference across each sleep so teardown releases the table.
async fn reap_blob_streams(streams: Weak<Mutex<HashMap<String, BlobStream>>>) {
    loop {
        tokio::time::sleep(NATIVE_BLOB_REAP_INTERVAL).await;
        let Some(streams) = streams.upgrade() else {
            return;
        };
        let Ok(mut streams) = streams.lock() else {
            return;
        };
        let now = Instant::now();
        streams.retain(|_, stream| {
            now.saturating_duration_since(stream.touched) < NATIVE_BLOB_STREAM_UNREAD
        });
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBlobStreamStart {
    status: u16,
    content_type: Option<String>,
    content_length: Option<u64>,
    /// The stream a 200 body is read from; any other answer is `body`.
    stream_id: Option<String>,
    body: Vec<u8>,
}

impl NativeBlobStreamStart {
    fn buffered(response: NativeApiResponse) -> Self {
        Self {
            status: response.status,
            content_type: response.content_type,
            content_length: None,
            stream_id: None,
            body: response.body,
        }
    }
}

async fn send_blob_request(
    state: &DesktopAuthState,
    url: &Url,
    access_token: Option<&str>,
    share_token: Option<&str>,
) -> Result<reqwest::Response, String> {
    blob_request_builder(&state.blob_client, url, access_token, share_token)?
        .send()
        .await
        .map_err(|_| "The OpenZCAD cloud service could not be reached.".to_string())
}

fn blob_request_builder(
    client: &Client,
    url: &Url,
    access_token: Option<&str>,
    share_token: Option<&str>,
) -> Result<reqwest::RequestBuilder, String> {
    let mut builder = client.get(url.clone());
    if let Some(token) = access_token {
        builder = builder.bearer_auth(token);
    }
    with_share_token(builder, share_token)
}

/// Starts an encrypted content blob download (`blob_stream_destination`): a
/// 200 body stays in Rust and is read in bounded pieces with
/// `desktop_blob_stream_read`, so a blob up to `MAX_NATIVE_BLOB_STREAM_BYTES`
/// never has to fit the buffered bridge's response cap; any other answer
/// comes back whole, as `desktop_api_request` returns it.
#[tauri::command]
pub async fn desktop_blob_stream_open(
    state: State<'_, DesktopAuthState>,
    path: String,
    share_token: Option<String>,
) -> Result<NativeBlobStreamStart, String> {
    open_blob_stream(&state, &path, share_token.as_deref()).await
}

/// `share_token`, when given, is an encrypted share link's token for its
/// token-free blob read (`share_link_blob_stream_destination`).
async fn open_blob_stream(
    state: &DesktopAuthState,
    path: &str,
    share_token: Option<&str>,
) -> Result<NativeBlobStreamStart, String> {
    let destination = match share_token {
        Some(token) => share_link_blob_stream_destination(path, token)?,
        None => blob_stream_destination(path)?,
    };
    let url = &destination.url;
    let public = destination.public;
    let mut access = if public {
        None
    } else {
        current_access(state).await?
    };
    if !public && access.is_none() {
        return Ok(NativeBlobStreamStart::buffered(
            local_unauthorized_response(),
        ));
    }
    let mut response = send_blob_request(state, url, access.as_deref(), share_token).await?;
    if !public && response.status() == StatusCode::UNAUTHORIZED {
        *state
            .access
            .lock()
            .map_err(|_| "Desktop auth state is unavailable.")? = None;
        access = refresh_access(state).await?;
        if let Some(token) = access.as_deref() {
            response = send_blob_request(state, url, Some(token), share_token).await?;
        }
    }
    if response.status() != StatusCode::OK {
        let buffered = buffer_api_response(response).await?;
        return Ok(NativeBlobStreamStart::buffered(buffered));
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let content_length = response.content_length();
    let stream_id = random_secret()?;
    let (sender, receiver) = mpsc::channel(NATIVE_BLOB_BUFFERED_CHUNKS);
    {
        let mut streams = state
            .blob_streams
            .lock()
            .map_err(|_| "Desktop auth state is unavailable.")?;
        admit_blob_stream(&mut streams, Instant::now())?;
        let pump =
            tauri::async_runtime::spawn(pump_blob_stream(response, sender, destination.max_bytes));
        let reader = BlobStreamReader {
            receiver,
            ended: false,
        };
        streams.insert(
            stream_id.clone(),
            BlobStream {
                reader: Arc::new(AsyncMutex::new(reader)),
                pump,
                touched: Instant::now(),
            },
        );
    }
    Ok(NativeBlobStreamStart {
        status: StatusCode::OK.as_u16(),
        content_type,
        content_length,
        stream_id: Some(stream_id),
        body: Vec::new(),
    })
}

/// The next piece of a stream's body as raw bytes (an `ArrayBuffer` in the
/// WebView, not a JSON array), empty at its end. A finished or failed stream
/// is released.
#[tauri::command]
pub async fn desktop_blob_stream_read(
    state: State<'_, DesktopAuthState>,
    stream_id: String,
) -> Result<tauri::ipc::Response, String> {
    let bytes = read_blob_stream(&state, &stream_id).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

async fn read_blob_stream(state: &DesktopAuthState, stream_id: &str) -> Result<Vec<u8>, String> {
    let reader = {
        let mut streams = state
            .blob_streams
            .lock()
            .map_err(|_| "Desktop auth state is unavailable.")?;
        let stream = streams
            .get_mut(stream_id)
            .ok_or_else(|| "The OpenZCAD cloud download is no longer available.".to_string())?;
        stream.touched = Instant::now();
        stream.reader.clone()
    };
    let result = reader.lock().await.read().await;
    if !matches!(&result, Ok(bytes) if !bytes.is_empty()) {
        let _released = state
            .blob_streams
            .lock()
            .map_err(|_| "Desktop auth state is unavailable.")?
            .remove(stream_id);
    }
    result
}

/// Ends a stream the renderer no longer wants (cancelled, aborted or over
/// its own size cap); unknown ids are already gone.
#[tauri::command]
pub fn desktop_blob_stream_cancel(
    state: State<'_, DesktopAuthState>,
    stream_id: String,
) -> Result<(), String> {
    cancel_blob_stream(&state, &stream_id)
}

fn cancel_blob_stream(state: &DesktopAuthState, stream_id: &str) -> Result<(), String> {
    let _released = state
        .blob_streams
        .lock()
        .map_err(|_| "Desktop auth state is unavailable.")?
        .remove(stream_id);
    Ok(())
}

#[tauri::command]
pub async fn desktop_collaboration_url(
    state: State<'_, DesktopAuthState>,
    project_id: String,
) -> Result<String, String> {
    let ticket_path = collaboration_api_url(&project_id, true)?;
    let request = NativeApiRequest {
        method: "POST".to_string(),
        path: ticket_path.path().to_string(),
        content_type: None,
        body: None,
        share_token: None,
        prepared: None,
    };
    let mut access = current_access(&state)
        .await?
        .ok_or_else(|| "Sign in before starting live collaboration.".to_string())?;
    let mut response = send_api_request(&state, &request, &ticket_path, Some(&access)).await?;
    if response.status() == StatusCode::UNAUTHORIZED {
        *state
            .access
            .lock()
            .map_err(|_| "Desktop auth state is unavailable.")? = None;
        access = refresh_access(&state)
            .await?
            .ok_or_else(|| "Sign in before starting live collaboration.".to_string())?;
        response = send_api_request(&state, &request, &ticket_path, Some(&access)).await?;
    }
    if !response.status().is_success() {
        return Err(server_error(response, "Live collaboration is unavailable.").await);
    }
    let issued = response
        .json::<CollaborationTicketResponse>()
        .await
        .map_err(|_| "The collaboration ticket response was invalid.".to_string())?;
    let now_ms = now_seconds()?
        .checked_mul(1_000)
        .ok_or_else(|| "The system clock is not valid.".to_string())?;
    if issued.expires_at <= now_ms || issued.expires_at > now_ms.saturating_add(120_000) {
        return Err("The collaboration ticket response was invalid.".to_string());
    }
    Ok(collaboration_socket_url(&project_id, &issued.ticket)?.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        admit_blob_stream, api_request_builder, api_url, approved_browser_url,
        blob_request_builder, blob_stream_destination, cancel_blob_stream, collaboration_api_url,
        collaboration_socket_url, end_session, forget_access, now_seconds, pkce_challenge,
        prepare_access, pump_blob_stream, read_blob_stream, renderer_api_destination,
        renderer_api_request, request_deletes_cloud_profile, request_destination,
        send_authenticated, share_link_blob_stream_destination, take_prepared_access,
        AccessCredential, AccessSource, Authenticated, BlobChunkSource, BlobStream,
        BlobStreamEvent, BlobStreamReader, DesktopAuthState, NativeApiRequest, BLOB_STREAM_STOPPED,
        BLOB_STREAM_TOO_LARGE, MAX_NATIVE_BLOB_STREAMS, MAX_PREPARED_ACCESS,
        NATIVE_BLOB_BUFFERED_CHUNKS, NATIVE_BLOB_READ_BYTES, NATIVE_BLOB_STREAM_UNREAD,
        SHARE_TOKEN_HEADER,
    };
    use reqwest::StatusCode;
    use std::{
        collections::{HashMap, VecDeque},
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
    };
    use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
    use tokio::time::Instant;

    #[test]
    fn rejects_renderer_lifecycle_requests_before_native_credentials() {
        let state = DesktopAuthState::new();
        // Any attempt to read cached credentials would now fail with the auth-state error.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _access = state.access.lock().unwrap();
            panic!("poison the synthetic credential state");
        }));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        for path in [
            "/api/auth/desktop/start",
            "/api/auth/desktop/approve",
            "/api/auth/desktop/exchange",
            "/api/auth/desktop/refresh",
            "/api/auth/desktop/exchange?query=1",
            "/api/auth/desktop/exchange#fragment",
            "/api/auth/desktop/config/../exchange",
            "/api/auth/desktop/config/%2e%2e/exchange",
            "/api/session/../auth/desktop/exchange",
            "/api/auth/desktop\\exchange",
            "/api/auth/desktop/ex\tchange",
            "/api/auth/desktop/ex\r\nchange",
            "/api/%61uth/desktop/exchange",
            "/api/%2561uth/desktop/exchange",
            "/api/%25%36%31uth/desktop/exchange",
            "/api/auth/%64esktop/exchange",
            "/api/auth/desktop/%65xchange",
            "/api/auth%2fdesktop%2fexchange",
            "/api/auth%5cdesktop%5cexchange",
            "/api/auth/desktop/ex%09change",
            "/api/auth/desktop/%2565xchange",
            "/api/auth/desktop/unknown-lifecycle",
        ] {
            let result = runtime.block_on(renderer_api_request(
                &state,
                NativeApiRequest {
                    method: "POST".to_string(),
                    path: path.to_string(),
                    content_type: None,
                    body: None,
                    share_token: None,
                    prepared: None,
                },
            ));
            assert_eq!(
                result.err().as_deref(),
                Some("The desktop API path is not allowed."),
                "{path:?}"
            );
        }
        assert!(renderer_api_destination(&format!(
            "/api/%{}61uth/desktop/exchange",
            "25".repeat(8192)
        ))
        .is_err());
        let result = runtime.block_on(renderer_api_request(
            &state,
            NativeApiRequest {
                method: "GET".to_string(),
                path: "/api/session".to_string(),
                content_type: None,
                body: None,
                share_token: None,
                prepared: None,
            },
        ));
        assert_eq!(
            result.err().as_deref(),
            Some("Desktop auth state is unavailable.")
        );
    }

    #[test]
    fn classifies_public_and_logout_routes_after_url_normalization() {
        for path in [
            "/api/auth/config?query=1#fragment",
            "/api/auth/desktop/config?query=1#fragment",
            "/api/auth/desktop/../config?query=1#fragment",
            "/api/auth/desktop/config?query=1#fragment/../exchange",
        ] {
            let destination = renderer_api_destination(path).unwrap();
            assert!(destination.public);
            assert!(!destination.logout);
            assert_eq!(destination.url.query(), Some("query=1"));
        }
        for path in [
            "/api/auth/logout?query=1#fragment",
            "/api/auth/desktop/logout?query=1#fragment",
            "/api/auth/desktop/../logout?query=1#fragment",
            "/api/auth\\logout?query=1#fragment",
            "/api/auth/log\tout?query=1#fragment",
        ] {
            let destination = renderer_api_destination(path).unwrap();
            assert_eq!(destination.url.path(), "/api/auth/desktop/logout");
            assert!(destination.logout);
            assert!(!destination.public);
            assert_eq!(destination.url.query(), Some("query=1"));
            assert_eq!(destination.url.fragment(), Some("fragment"));
        }
    }

    #[test]
    fn classifies_encrypted_share_reads_as_public() {
        for path in [
            "/api/e2ee/share/AbC-12_x",
            "/api/e2ee/share/AbC-12_x/blobs/blob_1",
            "/api/e2ee/share/AbC-12_x/blobs/blob_1?download=1",
        ] {
            let destination = renderer_api_destination(path).unwrap();
            assert!(destination.public, "{path}");
            assert!(!destination.logout);
        }
        for path in [
            "/api/e2ee/share/",
            "/api/e2ee/share/AbC/keys",
            "/api/e2ee/share/AbC/blobs",
            "/api/e2ee/share/AbC/blobs/blob_1/extra",
            "/api/e2ee/share/A%2FbC",
            "/api/e2ee/share-delegation",
            "/api/e2ee/projects/proj_1/share-links",
            "/api/e2ee/share/../projects/proj_1/share-links",
        ] {
            let destination = renderer_api_destination(path).unwrap();
            assert!(!destination.public, "{path}");
        }
    }

    #[test]
    fn preserves_cloud_routes_and_trusted_native_lifecycle_urls() {
        for path in [
            "/api/session",
            "/api/settings",
            "/api/projects",
            "/api/assistant/status",
            "/api/projects/proj_1/collaboration/ticket",
            "/api/projects/proj_1/assets/file%20name?download=1",
            "/api/projects/proj_1/assets/file%FFname?download=1",
            "/api/session?next=/api/auth/desktop/exchange",
        ] {
            let destination = renderer_api_destination(path).unwrap();
            assert_eq!(destination.url, api_url(path).unwrap());
            assert!(!destination.logout);
            assert!(!destination.public);
        }
        assert!(
            renderer_api_destination("/api/health?query=1")
                .unwrap()
                .public
        );
        for lifecycle in ["start", "approve", "exchange", "refresh"] {
            assert!(api_url(&format!("/api/auth/desktop/{lifecycle}")).is_ok());
        }
    }

    #[test]
    fn pins_native_requests_to_the_beta_api() {
        assert_eq!(
            api_url("/api/session").unwrap().as_str(),
            "https://zcad.app/api/session"
        );
        assert!(api_url("https://attacker.example/api/session").is_err());
        assert!(api_url("//attacker.example/api/session").is_err());
    }

    #[test]
    fn pins_the_system_browser_handoff() {
        assert!(approved_browser_url(
            "https://zcad.app/?desktopAuth=attempt-123456",
            "attempt-123456"
        )
        .is_ok());
        assert!(approved_browser_url(
            "https://attacker.example/?desktopAuth=attempt-123456",
            "attempt-123456"
        )
        .is_err());
    }

    #[test]
    fn creates_an_rfc_7636_sha256_challenge() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn pins_ticket_exchange_and_socket_urls_to_the_beta_origin() {
        assert_eq!(
            collaboration_api_url("proj_desktop-1", true)
                .unwrap()
                .as_str(),
            "https://zcad.app/api/projects/proj_desktop-1/collaboration/ticket"
        );
        assert_eq!(
            collaboration_socket_url("proj_desktop-1", &"t".repeat(43))
                .unwrap()
                .as_str(),
            format!(
                "wss://zcad.app/api/projects/proj_desktop-1/collaboration?ticket={}",
                "t".repeat(43)
            )
        );
    }

    #[test]
    fn rejects_project_and_ticket_values_that_could_escape_the_fixed_route() {
        assert!(collaboration_api_url("../attacker", true).is_err());
        assert!(collaboration_api_url("proj_ok?next=https://attacker.example", true).is_err());
        assert!(collaboration_socket_url("proj_ok", "short").is_err());
        assert!(collaboration_socket_url("proj_ok", &"!".repeat(43)).is_err());
    }

    #[test]
    fn clears_native_credentials_only_for_profile_deletion_scopes() {
        let request = |scope: &str| NativeApiRequest {
            method: "POST".to_string(),
            path: "/api/account/delete-data".to_string(),
            content_type: Some("application/json".to_string()),
            body: Some(format!(r#"{{"scope":"{scope}"}}"#).into_bytes()),
            share_token: None,
            prepared: None,
        };
        assert!(request_deletes_cloud_profile(&request("profile")));
        assert!(request_deletes_cloud_profile(&request("all")));
        assert!(!request_deletes_cloud_profile(&request("projects")));
    }

    const BLOB: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn streams_only_blob_and_authenticated_artifact_routes() {
        let share =
            blob_stream_destination(&format!("/api/e2ee/share/AbC-12_x/blobs/{BLOB}")).unwrap();
        assert!(share.public);
        assert_eq!(
            share.url.as_str(),
            format!("https://zcad.app/api/e2ee/share/AbC-12_x/blobs/{BLOB}")
        );
        let member =
            blob_stream_destination(&format!("/api/e2ee/projects/proj_1/blobs/{BLOB}")).unwrap();
        assert!(!member.public);
        assert_eq!(
            member.url.as_str(),
            format!("https://zcad.app/api/e2ee/projects/proj_1/blobs/{BLOB}")
        );
        assert_eq!(member.max_bytes, super::MAX_NATIVE_BLOB_STREAM_BYTES);
        let artifact = blob_stream_destination("/api/artifacts/artifact_large/download").unwrap();
        assert!(!artifact.public);
        assert_eq!(
            artifact.url.as_str(),
            "https://zcad.app/api/artifacts/artifact_large/download"
        );
        assert_eq!(artifact.max_bytes, super::MAX_NATIVE_ARTIFACT_STREAM_BYTES);
        let account = blob_stream_destination("/api/account/export").unwrap();
        assert!(!account.public);
        assert_eq!(account.url.as_str(), "https://zcad.app/api/account/export");
        assert_eq!(
            account.max_bytes,
            super::MAX_NATIVE_ACCOUNT_EXPORT_STREAM_BYTES
        );
        for path in [
            "/api/account/export?user=other".to_string(),
            "/api/account/export#fragment".to_string(),
            "/api/account/%65xport".to_string(),
            "/api/account/delete-data".to_string(),
            "/api/artifacts/artifact_large/download?extra=1".to_string(),
            "/api/artifacts/artifact_large/download#fragment".to_string(),
            "/api/artifacts/%61rtifact_large/download".to_string(),
            "/api/artifacts/artifact_large/../download".to_string(),
            "/api/artifacts//download".to_string(),
            "/api/artifacts/artifact_large/metadata".to_string(),
            format!("/api/e2ee/share/AbC-12_x/blobs/{BLOB}?download=1"),
            format!("/api/e2ee/share/AbC-12_x/blobs/{BLOB}#fragment"),
            format!("/api/e2ee/share/AbC-12_x/blobs/{}", BLOB.to_uppercase()),
            format!("/api/e2ee/share/AbC-12_x/blobs/{}", &BLOB[1..]),
            format!("/api/e2ee/share/AbC-12_x/blobs/{BLOB}0"),
            format!("/api/e2ee/share/A%2FbC/blobs/{BLOB}"),
            format!("/api/e2ee/share/%41bC/blobs/{BLOB}"),
            format!("/api/e2ee/share/x/../../e2ee/projects/proj_1/blobs/{BLOB}"),
            format!("/api/e2ee/projects/proj_1/../../share/AbC/blobs/{BLOB}"),
            format!("/api/e2ee/projects/proj_1/blobs/{BLOB}/finalize"),
            format!("/api/e2ee/share/Ab\tC/blobs/{BLOB}"),
            format!("/api/e2ee/share\\AbC/blobs/{BLOB}"),
            format!("/api/e2ee/share//blobs/{BLOB}"),
            format!("/api/projects/proj_1/assets/{BLOB}"),
            format!("/api/auth/desktop/exchange/blobs/{BLOB}"),
            format!("//attacker.example/api/e2ee/share/AbC/blobs/{BLOB}"),
            format!("https://attacker.example/api/e2ee/share/AbC/blobs/{BLOB}"),
            "/api/e2ee/projects/proj_1/blobs/uploads".to_string(),
            "/api/e2ee/projects/proj_1/blobs?tag=abc".to_string(),
            "/api/e2ee/share/AbC-12_x".to_string(),
            "/api/session".to_string(),
        ] {
            assert!(blob_stream_destination(&path).is_err(), "{path:?}");
        }
    }

    fn share_request(method: &str, path: &str, token: &str) -> NativeApiRequest {
        NativeApiRequest {
            method: method.to_string(),
            path: path.to_string(),
            content_type: None,
            body: None,
            share_token: Some(token.to_string()),
            prepared: None,
        }
    }

    #[test]
    fn sends_a_share_token_only_to_token_free_share_reads() {
        for path in [
            "/api/share",
            "/api/share/assets/asset_1",
            "/api/share/sources/artifact_source-1",
            "/api/e2ee/share",
            "/api/e2ee/share/blobs/blob_1",
        ] {
            let destination = request_destination(&share_request("GET", path, "AbC-12_x")).unwrap();
            assert!(destination.public, "{path}");
            assert!(!destination.logout);
            assert_eq!(destination.url.as_str(), format!("https://zcad.app{path}"));
        }
        let long_token = "a".repeat(256);
        assert!(request_destination(&share_request("GET", "/api/share", &long_token)).is_ok());
        for token in [
            "",
            &"a".repeat(257),
            "AbC\r\nx-other: 1",
            "AbC\n",
            "Ab C",
            "Ab/C",
            "Ab%43",
            "Ab.C",
            "Ab=",
        ] {
            assert_eq!(
                request_destination(&share_request("GET", "/api/share", token))
                    .err()
                    .as_deref(),
                Some("The desktop share-link request is not allowed."),
                "{token:?}"
            );
        }
        for path in [
            "/api/share/AbC-12_x",
            "/api/share/AbC-12_x/sources/artifact_1",
            "/api/e2ee/share/AbC-12_x",
            "/api/e2ee/share/AbC-12_x/blobs/blob_1",
            "/api/share/",
            "/api/share?next=1",
            "/api/share#fragment",
            "/api/share/assets/",
            "/api/share/assets/a/b",
            "/api/share/sources/../../session",
            "/api/share/sources/%2E%2E",
            "/api/e2ee/share/blobs/",
            "/api/e2ee/share/blobs/blob_1/extra",
            "/api/e2ee/share/blobs/blob%5F1",
            "/api/e2ee/share/keys",
            "/api/session",
            "/api/projects/proj_1",
            "/api/auth/desktop/exchange",
            "//attacker.example/api/share",
            "https://attacker.example/api/share",
        ] {
            assert!(
                request_destination(&share_request("GET", path, "AbC-12_x")).is_err(),
                "{path:?}"
            );
        }
        for method in ["POST", "PUT", "PATCH", "DELETE", "get"] {
            assert!(
                request_destination(&share_request(method, "/api/share", "AbC-12_x")).is_err(),
                "{method}"
            );
        }
        // Without a token, the token-free routes stay ordinary requests.
        let plain = request_destination(&NativeApiRequest {
            share_token: None,
            prepared: None,
            ..share_request("GET", "/api/share", "unused")
        })
        .unwrap();
        assert!(!plain.public);
    }

    #[test]
    fn forwards_the_share_token_as_its_one_extra_header() {
        let client = reqwest::Client::new();
        let request = share_request("GET", "/api/share/sources/artifact_1", "AbC-12_x");
        let destination = request_destination(&request).unwrap();
        let built = api_request_builder(&client, &request, &destination.url, None)
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(
            built.url().as_str(),
            "https://zcad.app/api/share/sources/artifact_1"
        );
        let headers = built.headers();
        assert_eq!(headers.len(), 1);
        assert_eq!(headers.get(SHARE_TOKEN_HEADER).unwrap(), "AbC-12_x");
        assert!(headers.get("authorization").is_none());
        assert!(!built.url().as_str().contains("AbC-12_x"));
        // The transport refuses a token that slipped past the destination.
        let forged = share_request("GET", "/api/share", "AbC\r\nx-other: 1");
        assert!(api_request_builder(&client, &forged, &destination.url, None).is_err());
        let blob = blob_request_builder(&client, &destination.url, None, Some("AbC-12_x"))
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(blob.headers().len(), 1);
        assert_eq!(blob.headers().get(SHARE_TOKEN_HEADER).unwrap(), "AbC-12_x");
        assert!(blob_request_builder(&client, &destination.url, None, Some("a b")).is_err());
        let without = blob_request_builder(&client, &destination.url, None, None)
            .unwrap()
            .build()
            .unwrap();
        assert!(without.headers().is_empty());
    }

    #[test]
    fn streams_a_share_token_only_for_token_free_encrypted_blobs() {
        let share = share_link_blob_stream_destination(
            &format!("/api/e2ee/share/blobs/{BLOB}"),
            "AbC-12_x",
        )
        .unwrap();
        assert!(share.public);
        assert_eq!(share.max_bytes, super::MAX_NATIVE_BLOB_STREAM_BYTES);
        assert_eq!(
            share.url.as_str(),
            format!("https://zcad.app/api/e2ee/share/blobs/{BLOB}")
        );
        for (path, token) in [
            (format!("/api/e2ee/share/blobs/{BLOB}"), "Ab\nC"),
            (format!("/api/e2ee/share/blobs/{BLOB}"), ""),
            (format!("/api/e2ee/share/blobs/{BLOB}?download=1"), "AbC"),
            (
                format!("/api/e2ee/share/blobs/{}", BLOB.to_uppercase()),
                "AbC",
            ),
            (format!("/api/e2ee/share/blobs/{}", &BLOB[1..]), "AbC"),
            ("/api/e2ee/share/blobs/blob_1".to_string(), "AbC"),
            (format!("/api/e2ee/share/AbC/blobs/{BLOB}"), "AbC"),
            (format!("/api/e2ee/projects/proj_1/blobs/{BLOB}"), "AbC"),
            ("/api/share/sources/artifact_1".to_string(), "AbC"),
            ("/api/e2ee/share".to_string(), "AbC"),
            ("/api/account/export".to_string(), "AbC"),
        ] {
            assert!(
                share_link_blob_stream_destination(&path, token).is_err(),
                "{path:?} {token:?}"
            );
        }
        // Without a token the token-free blob route is not streamed at all.
        assert!(blob_stream_destination(&format!("/api/e2ee/share/blobs/{BLOB}")).is_err());
    }

    #[test]
    fn refuses_other_streams_before_reading_native_credentials() {
        let state = DesktopAuthState::new();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _access = state.access.lock().unwrap();
            panic!("poison the synthetic credential state");
        }));
        let runtime = runtime();
        for path in ["/api/session", "/api/auth/desktop/refresh", "/api/projects"] {
            let result = runtime.block_on(super::open_blob_stream(&state, path, None));
            assert_eq!(
                result.err().as_deref(),
                Some("The desktop download path is not allowed."),
                "{path:?}"
            );
        }
        // A share token never turns another stream into an anonymous one.
        for path in [
            format!("/api/e2ee/projects/proj_1/blobs/{BLOB}"),
            format!("/api/e2ee/share/AbC-12_x/blobs/{BLOB}"),
            "/api/account/export".to_string(),
        ] {
            let result = runtime.block_on(super::open_blob_stream(&state, &path, Some("AbC-12_x")));
            assert_eq!(
                result.err().as_deref(),
                Some("The desktop download path is not allowed."),
                "{path:?}"
            );
        }
        // A member's blob is an authenticated read: it reaches for credentials.
        let result = runtime.block_on(super::open_blob_stream(
            &state,
            &format!("/api/e2ee/projects/proj_1/blobs/{BLOB}"),
            None,
        ));
        assert_eq!(
            result.err().as_deref(),
            Some("Desktop auth state is unavailable.")
        );
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    type Chunk = Result<Option<Vec<u8>>, String>;

    struct ScriptedChunks {
        chunks: VecDeque<Chunk>,
        pulls: Arc<AtomicUsize>,
    }

    impl BlobChunkSource for ScriptedChunks {
        async fn next_chunk(&mut self) -> Chunk {
            self.pulls.fetch_add(1, Ordering::SeqCst);
            self.chunks.pop_front().unwrap_or(Ok(None))
        }
    }

    /// The reader a finished pump over `chunks` leaves, and how many chunks it pulled.
    fn pumped(chunks: Vec<Chunk>, limit: u64) -> (BlobStreamReader, usize) {
        let pulls = Arc::new(AtomicUsize::new(0));
        let source = ScriptedChunks {
            chunks: chunks.into(),
            pulls: pulls.clone(),
        };
        let (sender, receiver) = mpsc::channel(NATIVE_BLOB_BUFFERED_CHUNKS);
        runtime().block_on(pump_blob_stream(source, sender, limit));
        let reader = BlobStreamReader {
            receiver,
            ended: false,
        };
        (reader, pulls.load(Ordering::SeqCst))
    }

    #[test]
    fn streams_a_body_in_bounded_pieces_and_then_its_end() {
        let (mut reader, _) = pumped(
            vec![
                Ok(Some(vec![1, 2])),
                Ok(Some(Vec::new())),
                Ok(Some(vec![3])),
                Ok(None),
            ],
            u64::MAX,
        );
        let runtime = runtime();
        assert_eq!(runtime.block_on(reader.read()), Ok(vec![1, 2, 3]));
        assert_eq!(runtime.block_on(reader.read()), Ok(Vec::new()));
        assert_eq!(runtime.block_on(reader.read()), Ok(Vec::new()));

        // One read hands over at most about a read's worth, never the whole body.
        let half = NATIVE_BLOB_READ_BYTES / 2 + 1;
        let (mut reader, _) = pumped(
            vec![
                Ok(Some(vec![1; half])),
                Ok(Some(vec![2; half])),
                Ok(Some(vec![3; half])),
                Ok(None),
            ],
            u64::MAX,
        );
        assert_eq!(runtime.block_on(reader.read()).unwrap().len(), half * 2);
        assert_eq!(runtime.block_on(reader.read()), Ok(vec![3; half]));
        assert_eq!(runtime.block_on(reader.read()), Ok(Vec::new()));
    }

    #[test]
    fn refuses_a_body_past_its_limit_without_reading_further() {
        let (mut reader, pulls) = pumped(
            vec![
                Ok(Some(vec![1; 3])),
                Ok(Some(vec![2; 3])),
                Ok(Some(vec![3])),
                Ok(None),
            ],
            4,
        );
        assert_eq!(pulls, 2);
        assert_eq!(
            runtime().block_on(reader.read()),
            Err(BLOB_STREAM_TOO_LARGE.to_string())
        );
    }

    #[test]
    fn fails_a_download_that_breaks_or_stops_without_its_end() {
        let (mut reader, _) = pumped(
            vec![Ok(Some(vec![1])), Err("connection reset".to_string())],
            u64::MAX,
        );
        assert_eq!(
            runtime().block_on(reader.read()),
            Err("connection reset".to_string())
        );

        // A pump that went away (aborted) never reads as a complete body.
        let (sender, receiver) = mpsc::channel(4);
        assert!(sender.try_send(BlobStreamEvent::Data(vec![1])).is_ok());
        drop(sender);
        let mut reader = BlobStreamReader {
            receiver,
            ended: false,
        };
        assert_eq!(
            runtime().block_on(reader.read()),
            Err(BLOB_STREAM_STOPPED.to_string())
        );
        assert_eq!(
            runtime().block_on(reader.read()),
            Err(BLOB_STREAM_STOPPED.to_string())
        );
    }

    #[test]
    fn stops_downloading_once_nobody_reads() {
        let pulls = Arc::new(AtomicUsize::new(0));
        let source = ScriptedChunks {
            chunks: vec![Ok(Some(vec![1])), Ok(Some(vec![2])), Ok(None)].into(),
            pulls: pulls.clone(),
        };
        let (sender, receiver) = mpsc::channel(NATIVE_BLOB_BUFFERED_CHUNKS);
        drop(receiver);
        runtime().block_on(pump_blob_stream(source, sender, u64::MAX));
        assert_eq!(pulls.load(Ordering::SeqCst), 1);
    }

    /// A registered stream whose pump only waits; `observer` closes once the
    /// pump is aborted.
    fn waiting_stream(
        receiver: mpsc::Receiver<BlobStreamEvent>,
        touched: Instant,
    ) -> (BlobStream, oneshot::Receiver<()>) {
        let (alive, observer) = oneshot::channel::<()>();
        let pump = tauri::async_runtime::spawn(async move {
            let _alive = alive;
            std::future::pending::<()>().await;
        });
        let reader = BlobStreamReader {
            receiver,
            ended: false,
        };
        let stream = BlobStream {
            reader: Arc::new(AsyncMutex::new(reader)),
            pump,
            touched,
        };
        (stream, observer)
    }

    fn aborted(observer: &mut oneshot::Receiver<()>) -> bool {
        for _ in 0..500 {
            if matches!(
                observer.try_recv(),
                Err(oneshot::error::TryRecvError::Closed)
            ) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    #[test]
    fn bounds_open_streams_and_lets_go_of_unread_ones() {
        let now = Instant::now();
        let mut streams = HashMap::new();
        let mut observers = Vec::new();
        for index in 0..MAX_NATIVE_BLOB_STREAMS {
            let (_sender, receiver) = mpsc::channel(1);
            let (stream, observer) = waiting_stream(receiver, now);
            streams.insert(format!("stream-{index}"), stream);
            observers.push(observer);
        }
        assert!(admit_blob_stream(&mut streams, now).is_err());
        assert_eq!(streams.len(), MAX_NATIVE_BLOB_STREAMS);

        let stale = now
            .checked_sub(NATIVE_BLOB_STREAM_UNREAD + Duration::from_secs(1))
            .unwrap();
        streams.get_mut("stream-0").unwrap().touched = stale;
        assert!(admit_blob_stream(&mut streams, now).is_ok());
        assert!(!streams.contains_key("stream-0"));
        assert!(aborted(&mut observers[0]));
        assert!(matches!(
            observers[1].try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));

        drop(streams);
        assert!(observers.iter_mut().all(aborted));
    }

    #[test]
    fn timer_expires_abandoned_full_queues_without_another_command() {
        runtime().block_on(async {
            tokio::time::pause();
            let streams = Arc::new(std::sync::Mutex::new(HashMap::new()));
            let (sender, receiver) = mpsc::channel(1);
            let (alive, mut observer) = oneshot::channel::<()>();
            let pump = tauri::async_runtime::spawn(async move {
                let _alive = alive;
                loop {
                    if sender.send(BlobStreamEvent::Data(vec![1])).await.is_err() {
                        return;
                    }
                }
            });
            streams.lock().unwrap().insert(
                "abandoned".into(),
                BlobStream {
                    reader: Arc::new(AsyncMutex::new(BlobStreamReader {
                        receiver,
                        ended: false,
                    })),
                    pump,
                    touched: Instant::now(),
                },
            );
            let reaper = tokio::spawn(super::reap_blob_streams(Arc::downgrade(&streams)));
            tokio::task::yield_now().await;
            tokio::time::advance(NATIVE_BLOB_STREAM_UNREAD - Duration::from_secs(1)).await;
            tokio::task::yield_now().await;
            assert_eq!(streams.lock().unwrap().len(), 1);
            // The first jump wakes the reaper at 59 seconds, which schedules
            // its next check there. Allow the full idle + reap bound (65s),
            // including Tokio's millisecond timer rounding at that deadline.
            tokio::time::advance(super::NATIVE_BLOB_REAP_INTERVAL + Duration::from_secs(1)).await;
            tokio::task::yield_now().await;
            assert!(streams.lock().unwrap().is_empty());
            assert!(aborted(&mut observer));
            drop(streams);
            tokio::time::advance(super::NATIVE_BLOB_REAP_INTERVAL).await;
            reaper.await.unwrap();
        });
    }

    #[test]
    fn timer_renews_reads_then_expires_a_pending_reader_and_stops_with_state() {
        runtime().block_on(async {
            tokio::time::pause();
            let state = DesktopAuthState::new();
            let (sender, receiver) = mpsc::channel(1);
            sender.try_send(BlobStreamEvent::Data(vec![7])).unwrap();
            let (alive, mut observer) = oneshot::channel::<()>();
            let pump = tauri::async_runtime::spawn(async move {
                let _alive = alive;
                let _sender = sender;
                std::future::pending::<()>().await;
            });
            state.blob_streams.lock().unwrap().insert(
                "reading".into(),
                BlobStream {
                    reader: Arc::new(AsyncMutex::new(BlobStreamReader {
                        receiver,
                        ended: false,
                    })),
                    pump,
                    touched: Instant::now(),
                },
            );
            let weak = Arc::downgrade(&state.blob_streams);
            let reaper = tokio::spawn(super::reap_blob_streams(weak.clone()));
            tokio::task::yield_now().await;
            tokio::time::advance(Duration::from_secs(50)).await;
            assert_eq!(read_blob_stream(&state, "reading").await.unwrap(), vec![7]);
            tokio::time::advance(Duration::from_secs(50)).await;
            tokio::task::yield_now().await;
            assert_eq!(state.blob_streams.lock().unwrap().len(), 1);
            // A read waiting on the network must also wake when expiry aborts
            // its pump; no renderer cancel or subsequent open is involved.
            {
                let read = read_blob_stream(&state, "reading");
                tokio::pin!(read);
                assert!(tokio::time::timeout(Duration::from_secs(1), &mut read)
                    .await
                    .is_err());
                tokio::time::advance(NATIVE_BLOB_STREAM_UNREAD + super::NATIVE_BLOB_REAP_INTERVAL)
                    .await;
                assert_eq!(read.await, Err(BLOB_STREAM_STOPPED.to_string()));
            }
            assert!(state.blob_streams.lock().unwrap().is_empty());
            assert!(aborted(&mut observer));
            drop(state);
            assert!(weak.upgrade().is_none());
            tokio::time::advance(super::NATIVE_BLOB_REAP_INTERVAL).await;
            reaper.await.unwrap();
        });
    }

    #[test]
    fn releases_a_stream_at_its_end_on_failure_and_on_cancel() {
        let state = DesktopAuthState::new();
        let runtime = runtime();
        let register = |id: &str, events: Vec<BlobStreamEvent>| {
            let (sender, receiver) = mpsc::channel(4);
            for event in events {
                assert!(sender.try_send(event).is_ok());
            }
            let (stream, observer) = waiting_stream(receiver, Instant::now());
            state
                .blob_streams
                .lock()
                .unwrap()
                .insert(id.to_string(), stream);
            (sender, observer)
        };
        let open = |id: &str| state.blob_streams.lock().unwrap().contains_key(id);

        let (_sender, mut observer) = register(
            "ends",
            vec![BlobStreamEvent::Data(vec![7, 8]), BlobStreamEvent::End],
        );
        assert_eq!(
            runtime.block_on(read_blob_stream(&state, "ends")),
            Ok(vec![7, 8])
        );
        assert!(open("ends"));
        assert_eq!(
            runtime.block_on(read_blob_stream(&state, "ends")),
            Ok(Vec::new())
        );
        assert!(!open("ends"));
        assert!(aborted(&mut observer));
        assert!(runtime.block_on(read_blob_stream(&state, "ends")).is_err());

        let (_sender, mut observer) = register(
            "fails",
            vec![BlobStreamEvent::Failed("connection reset".to_string())],
        );
        assert_eq!(
            runtime.block_on(read_blob_stream(&state, "fails")),
            Err("connection reset".to_string())
        );
        assert!(!open("fails"));
        assert!(aborted(&mut observer));

        let (_sender, mut observer) = register("cancelled", vec![BlobStreamEvent::Data(vec![1])]);
        assert!(cancel_blob_stream(&state, "cancelled").is_ok());
        assert!(!open("cancelled"));
        assert!(aborted(&mut observer));
        assert!(cancel_blob_stream(&state, "cancelled").is_ok());
    }

    /// A credential source that counts how it was asked.
    struct ScriptedAccess {
        prepared: Option<String>,
        current: Option<String>,
        refreshed: Option<String>,
        currents: AtomicUsize,
        refreshes: AtomicUsize,
        forgotten: AtomicUsize,
    }

    impl ScriptedAccess {
        fn new(prepared: Option<&str>, current: Option<&str>, refreshed: Option<&str>) -> Self {
            Self {
                prepared: prepared.map(str::to_string),
                current: current.map(str::to_string),
                refreshed: refreshed.map(str::to_string),
                currents: AtomicUsize::new(0),
                refreshes: AtomicUsize::new(0),
                forgotten: AtomicUsize::new(0),
            }
        }

        fn counts(&self) -> (usize, usize, usize) {
            (
                self.currents.load(Ordering::SeqCst),
                self.refreshes.load(Ordering::SeqCst),
                self.forgotten.load(Ordering::SeqCst),
            )
        }
    }

    impl AccessSource for ScriptedAccess {
        fn prepared(&self, _handle: &str) -> Result<Option<String>, String> {
            Ok(self.prepared.clone())
        }

        async fn current(&self) -> Result<Option<String>, String> {
            self.currents.fetch_add(1, Ordering::SeqCst);
            Ok(self.current.clone())
        }

        async fn refreshed(&self) -> Result<Option<String>, String> {
            self.refreshes.fetch_add(1, Ordering::SeqCst);
            Ok(self.refreshed.clone())
        }

        fn forget(&self, _token: &str) -> Result<(), String> {
            self.forgotten.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    /// Sends through `access`, the account answering `statuses` in turn;
    /// the outcome and the credential each send carried.
    fn authenticate(
        access: &ScriptedAccess,
        prepared: Option<&str>,
        statuses: &[u16],
    ) -> (Result<Authenticated<StatusCode>, String>, Vec<String>) {
        let sent = std::sync::Mutex::new(Vec::new());
        let mut answers: VecDeque<u16> = statuses.iter().copied().collect();
        let result = runtime().block_on(send_authenticated(
            access,
            prepared,
            |token: String| {
                sent.lock().unwrap().push(token);
                let status = answers.pop_front().expect("an answer for every send");
                std::future::ready(Ok(StatusCode::from_u16(status).unwrap()))
            },
            |status: &StatusCode| *status,
        ));
        (result, sent.into_inner().unwrap())
    }

    #[test]
    fn sends_a_project_request_once_with_the_readied_credential() {
        let access = ScriptedAccess::new(Some("ready"), Some("current"), Some("fresh"));
        let (result, sent) = authenticate(&access, Some("handle"), &[401]);
        // The 401 goes back to the renderer, which checks its project gate
        // before it readies another credential and retries.
        assert_eq!(result, Ok(Authenticated::Sent(StatusCode::UNAUTHORIZED)));
        assert_eq!(sent, ["ready"]);
        // Neither refreshed before the send nor after the 401; the refused
        // credential is dropped, so the next readying refreshes it.
        assert_eq!(access.counts(), (0, 0, 1));

        let access = ScriptedAccess::new(Some("ready"), Some("current"), Some("fresh"));
        let (result, sent) = authenticate(&access, Some("handle"), &[200]);
        assert_eq!(result, Ok(Authenticated::Sent(StatusCode::OK)));
        assert_eq!(sent, ["ready"]);
        assert_eq!(access.counts(), (0, 0, 0));
    }

    #[test]
    fn sends_nothing_for_a_project_request_without_a_readied_credential() {
        // Expired since it was readied, or never readied: not refreshed here.
        let access = ScriptedAccess::new(None, Some("current"), Some("fresh"));
        let (result, sent) = authenticate(&access, Some("handle"), &[]);
        assert_eq!(result, Ok(Authenticated::SignedOut));
        assert!(sent.is_empty());
        assert_eq!(access.counts(), (0, 0, 0));
    }

    #[test]
    fn keeps_refreshing_and_retrying_other_requests_once() {
        let access = ScriptedAccess::new(None, Some("current"), Some("fresh"));
        let (result, sent) = authenticate(&access, None, &[401, 200]);
        assert_eq!(result, Ok(Authenticated::Sent(StatusCode::OK)));
        assert_eq!(sent, ["current", "fresh"]);
        assert_eq!(access.counts(), (1, 1, 1));

        // A refresh the account refuses leaves its 401 as the answer.
        let access = ScriptedAccess::new(None, Some("current"), None);
        let (result, sent) = authenticate(&access, None, &[401]);
        assert_eq!(result, Ok(Authenticated::Sent(StatusCode::UNAUTHORIZED)));
        assert_eq!(sent, ["current"]);
        assert_eq!(access.counts(), (1, 1, 1));

        let access = ScriptedAccess::new(None, None, Some("fresh"));
        let (result, sent) = authenticate(&access, None, &[]);
        assert_eq!(result, Ok(Authenticated::SignedOut));
        assert!(sent.is_empty());
        assert_eq!(access.counts(), (1, 0, 0));
    }

    /// A signed-in state whose credential `token` expires in an hour.
    fn signed_in(token: &str) -> DesktopAuthState {
        let state = DesktopAuthState::new();
        *state.access.lock().unwrap() = Some(AccessCredential {
            token: token.to_string(),
            expires_at: now_seconds().unwrap() + 3_600,
        });
        state
    }

    fn project_write(prepared: Option<&str>) -> NativeApiRequest {
        NativeApiRequest {
            method: "PUT".to_string(),
            path: "/api/projects/proj_1/document".to_string(),
            content_type: Some("application/json".to_string()),
            body: Some(b"{}".to_vec()),
            share_token: None,
            prepared: prepared.map(str::to_string),
        }
    }

    #[test]
    fn answers_a_project_request_with_an_expired_credential_locally() {
        let state = signed_in("expired");
        let handle = runtime().block_on(prepare_access(&state)).unwrap().unwrap();
        // Expired after it was readied.
        state
            .prepared
            .lock()
            .unwrap()
            .get_mut(&handle)
            .unwrap()
            .expires_at = 0;
        let result = runtime().block_on(renderer_api_request(&state, project_write(Some(&handle))));
        // The local 401: nothing refreshed, nothing sent.
        assert_eq!(result.map(|response| response.status), Ok(401));
        assert_eq!(
            state
                .access
                .lock()
                .unwrap()
                .as_ref()
                .map(|access| access.token.clone()),
            Some("expired".to_string())
        );
    }

    #[test]
    fn sends_a_project_request_with_exactly_the_credential_readied_for_it() {
        let state = signed_in("readied");
        let handle = runtime().block_on(prepare_access(&state)).unwrap().unwrap();
        // Another request refreshed the shared credential meanwhile.
        *state.access.lock().unwrap() = Some(AccessCredential {
            token: "replaced".to_string(),
            expires_at: now_seconds().unwrap() + 3_600,
        });
        assert_eq!(
            take_prepared_access(&state, &handle),
            Ok(Some("readied".to_string()))
        );
        // Readied for one send: never sent again.
        assert_eq!(take_prepared_access(&state, &handle), Ok(None));
        // A handle nothing readied (the renderer's empty one) sends nothing.
        assert_eq!(take_prepared_access(&state, ""), Ok(None));
        assert_eq!(take_prepared_access(&state, "guessed"), Ok(None));
    }

    #[test]
    fn sends_nothing_with_a_credential_readied_in_a_session_that_ended() {
        let state = signed_in("first-account");
        let handle = runtime().block_on(prepare_access(&state)).unwrap().unwrap();
        // Signed out, then signed in to another account.
        end_session(&state).unwrap();
        *state.access.lock().unwrap() = Some(AccessCredential {
            token: "second-account".to_string(),
            expires_at: now_seconds().unwrap() + 3_600,
        });
        assert!(state.prepared.lock().unwrap().is_empty());
        let result = runtime().block_on(renderer_api_request(&state, project_write(Some(&handle))));
        // Answered locally: neither the first account's credential nor the
        // second's is sent, and the renderer re-checks before readying again.
        assert_eq!(result.map(|response| response.status), Ok(401));

        // A preparation from before the session moved is refused even if it
        // is still in the table.
        let state = signed_in("first-account");
        let handle = runtime().block_on(prepare_access(&state)).unwrap().unwrap();
        state.session.fetch_add(1, Ordering::SeqCst);
        assert_eq!(take_prepared_access(&state, &handle), Ok(None));
    }

    #[test]
    fn readies_nothing_when_signed_out() {
        let state = DesktopAuthState::new();
        // Off macOS there is no Keychain refresh credential to fall back on.
        if let Ok(prepared) = runtime().block_on(prepare_access(&state)) {
            assert_eq!(prepared, None);
        }
        assert!(state.prepared.lock().unwrap().is_empty());
    }

    #[test]
    fn bounds_readied_credentials_dropping_expired_then_oldest() {
        let state = signed_in("readied");
        let handles: Vec<String> = (0..MAX_PREPARED_ACCESS + 1)
            .map(|_| runtime().block_on(prepare_access(&state)).unwrap().unwrap())
            .collect();
        assert_eq!(state.prepared.lock().unwrap().len(), MAX_PREPARED_ACCESS);
        // The oldest was dropped: its request is answered locally.
        assert_eq!(take_prepared_access(&state, &handles[0]), Ok(None));
        assert_eq!(
            take_prepared_access(&state, &handles[MAX_PREPARED_ACCESS]),
            Ok(Some("readied".to_string()))
        );
    }

    #[test]
    fn forgets_only_the_credential_the_account_refused() {
        let state = signed_in("current");
        forget_access(&state, "older").unwrap();
        assert!(state.access.lock().unwrap().is_some());
        forget_access(&state, "current").unwrap();
        assert!(state.access.lock().unwrap().is_none());
    }

    #[test]
    fn reads_the_handle_the_renderer_readied() {
        let prepared: NativeApiRequest = serde_json::from_str(
            r#"{"method":"PUT","path":"/api/projects/proj_1/document","prepared":"h1"}"#,
        )
        .unwrap();
        assert_eq!(prepared.prepared.as_deref(), Some("h1"));
        let ordinary: NativeApiRequest =
            serde_json::from_str(r#"{"method":"GET","path":"/api/session"}"#).unwrap();
        assert_eq!(ordinary.prepared, None);
        // The renderer's old boolean is not a handle: refused, not sent.
        assert!(serde_json::from_str::<NativeApiRequest>(
            r#"{"method":"PUT","path":"/api/projects/proj_1/document","prepared":true}"#,
        )
        .is_err());
    }
}
