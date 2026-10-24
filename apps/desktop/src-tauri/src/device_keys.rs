//! Tauri commands for the desktop device keys (ADR-024, "Unlock and
//! devices"). The keys live in the macOS Keychain; the renderer gets public
//! keys, signatures and ECDH secrets, never private key bytes. The logic and
//! its tests are in the `openzcad-device-keys` crate.

use openzcad_device_keys as keys;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDeviceKeys {
    key_id: String,
    signing_public_key: Vec<u8>,
    unlock_public_key: Vec<u8>,
}

/// A failed creation. `key_id` names Keychain keys it could not remove, so
/// the renderer can retry `delete_device_keys` instead of losing the id.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDeviceKeysError {
    message: String,
    key_id: Option<String>,
}

#[cfg(target_os = "macos")]
fn with_store<T, E: From<String>>(
    run: impl FnOnce(&dyn keys::SecretStore) -> Result<T, E>,
) -> Result<T, E> {
    run(&keys::Keychain)
}

#[cfg(not(target_os = "macos"))]
fn with_store<T, E: From<String>>(
    _run: impl FnOnce(&dyn keys::SecretStore) -> Result<T, E>,
) -> Result<T, E> {
    Err(E::from(
        "Desktop device keys require macOS Keychain.".to_string(),
    ))
}

fn fill_random(buffer: &mut [u8]) -> Result<(), String> {
    getrandom::fill(buffer).map_err(|_| "Secure randomness is unavailable.".to_string())
}

#[tauri::command]
pub fn create_device_keys() -> Result<NativeDeviceKeys, CreateDeviceKeysError> {
    with_store(|store| keys::create(store, &mut fill_random))
        .map(|created| NativeDeviceKeys {
            key_id: created.key_id,
            signing_public_key: created.signing_public_key,
            unlock_public_key: created.unlock_public_key,
        })
        .map_err(|error| CreateDeviceKeysError {
            message: error.message,
            key_id: error.key_id,
        })
}

#[tauri::command]
pub fn sign_with_device_key(key_id: String, message: Vec<u8>) -> Result<Vec<u8>, String> {
    with_store(|store| keys::sign(store, &key_id, &message))
}

#[tauri::command]
pub fn derive_with_device_key(key_id: String, peer: Vec<u8>) -> Result<Vec<u8>, String> {
    with_store(|store| keys::derive(store, &key_id, &peer))
}

#[tauri::command]
pub fn delete_device_keys(key_id: String) -> Result<(), String> {
    with_store(|store| keys::delete(store, &key_id))
}
