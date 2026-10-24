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

#[cfg(target_os = "macos")]
fn with_store<T>(run: impl FnOnce(&dyn keys::SecretStore) -> Result<T, String>) -> Result<T, String> {
    run(&keys::Keychain)
}

#[cfg(not(target_os = "macos"))]
fn with_store<T>(
    _run: impl FnOnce(&dyn keys::SecretStore) -> Result<T, String>,
) -> Result<T, String> {
    Err("Desktop device keys require macOS Keychain.".to_string())
}

fn fill_random(buffer: &mut [u8]) -> Result<(), String> {
    getrandom::fill(buffer).map_err(|_| "Secure randomness is unavailable.".to_string())
}

#[tauri::command]
pub fn create_device_keys() -> Result<NativeDeviceKeys, String> {
    with_store(|store| keys::create(store, &mut fill_random)).map(|created| NativeDeviceKeys {
        key_id: created.key_id,
        signing_public_key: created.signing_public_key,
        unlock_public_key: created.unlock_public_key,
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
