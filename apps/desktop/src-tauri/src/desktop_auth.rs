use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use reqwest::{redirect::Policy, Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    process::Command,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;

const API_ORIGIN: &str = "https://zcad.esau.app";
const DESKTOP_CLIENT_ID: &str = "openzcad-macos";
const KEYCHAIN_SERVICE: &str = "app.esau.openzcad";
const KEYCHAIN_ACCOUNT: &str = "desktop-refresh";
const MAX_NATIVE_API_BODY_BYTES: usize = 25 * 1024 * 1024;
const MAX_NATIVE_API_RESPONSE_BYTES: usize = 50 * 1024 * 1024;
const TOKEN_REFRESH_SKEW_SECONDS: u64 = 30;
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

pub struct DesktopAuthState {
    client: Client,
    pending: Mutex<Option<PendingAuthorization>>,
    access: Mutex<Option<AccessCredential>>,
    refresh_guard: AsyncMutex<()>,
}

impl DesktopAuthState {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(30))
                .redirect(Policy::none())
                .build()
                .expect("desktop HTTPS client configuration is valid"),
            pending: Mutex::new(None),
            access: Mutex::new(None),
            refresh_guard: AsyncMutex::new(()),
        }
    }
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
        *state
            .access
            .lock()
            .map_err(|_| "Desktop auth state is unavailable.")? = None;
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

async fn send_api_request(
    state: &DesktopAuthState,
    request: &NativeApiRequest,
    path: &str,
    access_token: Option<&str>,
) -> Result<reqwest::Response, String> {
    let method = Method::from_bytes(request.method.as_bytes())
        .map_err(|_| "The desktop API method is not allowed.".to_string())?;
    if !matches!(
        method,
        Method::GET | Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) {
        return Err("The desktop API method is not allowed.".to_string());
    }
    let mut builder = state.client.request(method, api_url(path)?);
    if let Some(token) = access_token {
        builder = builder.bearer_auth(token);
    }
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
    builder
        .send()
        .await
        .map_err(|_| "The OpenZCAD cloud service could not be reached.".to_string())
}

#[tauri::command]
pub async fn desktop_api_request(
    state: State<'_, DesktopAuthState>,
    request: NativeApiRequest,
) -> Result<NativeApiResponse, String> {
    let path = match request.path.as_str() {
        "/api/auth/config" => "/api/auth/desktop/config",
        "/api/auth/logout" => "/api/auth/desktop/logout",
        other => other,
    };
    if request.path == "/api/auth/logout" {
        let response = match current_access(&state).await {
            Ok(Some(token)) => send_api_request(&state, &request, path, Some(&token))
                .await
                .ok(),
            Ok(None) | Err(_) => None,
        };
        *state
            .access
            .lock()
            .map_err(|_| "Desktop auth state is unavailable.")? = None;
        delete_refresh_credential()?;
        return match response {
            Some(response) => buffer_api_response(response).await,
            None => Ok(local_signed_out_response()),
        };
    }
    let public = matches!(path, "/api/health" | "/api/auth/desktop/config");
    let mut access = if public {
        None
    } else {
        current_access(&state).await?
    };
    if !public && access.is_none() {
        return Ok(local_unauthorized_response());
    }
    let mut response = send_api_request(&state, &request, path, access.as_deref()).await?;
    if !public && response.status() == StatusCode::UNAUTHORIZED {
        *state
            .access
            .lock()
            .map_err(|_| "Desktop auth state is unavailable.")? = None;
        access = refresh_access(&state).await?;
        if let Some(token) = access.as_deref() {
            response = send_api_request(&state, &request, path, Some(token)).await?;
        }
    }
    buffer_api_response(response).await
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
    };
    let mut access = current_access(&state)
        .await?
        .ok_or_else(|| "Sign in before starting live collaboration.".to_string())?;
    let mut response =
        send_api_request(&state, &request, request.path.as_str(), Some(&access)).await?;
    if response.status() == StatusCode::UNAUTHORIZED {
        *state
            .access
            .lock()
            .map_err(|_| "Desktop auth state is unavailable.")? = None;
        access = refresh_access(&state)
            .await?
            .ok_or_else(|| "Sign in before starting live collaboration.".to_string())?;
        response = send_api_request(&state, &request, request.path.as_str(), Some(&access)).await?;
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
        api_url, approved_browser_url, collaboration_api_url, collaboration_socket_url,
        pkce_challenge,
    };

    #[test]
    fn pins_native_requests_to_the_beta_api() {
        assert_eq!(
            api_url("/api/session").unwrap().as_str(),
            "https://zcad.esau.app/api/session"
        );
        assert!(api_url("https://attacker.example/api/session").is_err());
        assert!(api_url("//attacker.example/api/session").is_err());
    }

    #[test]
    fn pins_the_system_browser_handoff() {
        assert!(approved_browser_url(
            "https://zcad.esau.app/?desktopAuth=attempt-123456",
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
            "https://zcad.esau.app/api/projects/proj_desktop-1/collaboration/ticket"
        );
        assert_eq!(
            collaboration_socket_url("proj_desktop-1", &"t".repeat(43))
                .unwrap()
                .as_str(),
            format!(
                "wss://zcad.esau.app/api/projects/proj_desktop-1/collaboration?ticket={}",
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
}
