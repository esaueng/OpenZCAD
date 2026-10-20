//! The device-list verifier the policy consults.
//!
//! mls-rs callbacks are synchronous here and cannot await WebCrypto, so the
//! app verifies identity-signed device lists and leaf certifications first
//! and injects the result. [`DeviceDirectory`] is that verified snapshot.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde::Deserialize;

use crate::error::{Error, Res};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialStatus {
    /// Certified by an unrevoked device in the user's newest verified list.
    Certified,
    /// The device that certified it is revoked.
    Revoked,
    /// Not known to be certified (refused like a forgery).
    Unknown,
}

/// What the MLS policy needs from the identity layer (ADR-024, the
/// Authentication Service).
pub trait DeviceListVerifier: Send + Sync {
    fn credential_status(&self, user_id: &[u8], device_id: &[u8], signature_key: &[u8]) -> CredentialStatus;
    /// First epoch of this group whose rejoin PSK the user's newest revoked
    /// device must not know; a rejoin PSK must be from this epoch or later.
    fn revocation_cutoff(&self, user_id: &[u8]) -> Option<u64>;
    /// The revoked device this device was certified to replace, if the
    /// revocation entry named it as the replacement.
    fn replaces(&self, user_id: &[u8], device_id: &[u8]) -> Option<Vec<u8>>;
}

#[derive(Clone, Debug, Default)]
pub struct DeviceEntry {
    pub revoked: bool,
    pub leaf_keys: Vec<Vec<u8>>,
    pub replaced_by: Option<Vec<u8>>,
}

#[derive(Clone, Debug, Default)]
pub struct UserDevices {
    pub devices: BTreeMap<Vec<u8>, DeviceEntry>,
    pub revocation_cutoff: Option<u64>,
}

#[derive(Clone, Debug, Default)]
pub struct DeviceDirectory {
    pub users: BTreeMap<Vec<u8>, UserDevices>,
}

impl DeviceListVerifier for DeviceDirectory {
    fn credential_status(&self, user_id: &[u8], device_id: &[u8], signature_key: &[u8]) -> CredentialStatus {
        let Some(device) = self.users.get(user_id).and_then(|u| u.devices.get(device_id)) else {
            return CredentialStatus::Unknown;
        };
        if device.revoked {
            CredentialStatus::Revoked
        } else if device.leaf_keys.iter().any(|k| k == signature_key) {
            CredentialStatus::Certified
        } else {
            CredentialStatus::Unknown
        }
    }

    fn revocation_cutoff(&self, user_id: &[u8]) -> Option<u64> {
        self.users.get(user_id).and_then(|u| u.revocation_cutoff)
    }

    fn replaces(&self, user_id: &[u8], device_id: &[u8]) -> Option<Vec<u8>> {
        let user = self.users.get(user_id)?;
        user.devices
            .iter()
            .find(|(_, d)| d.revoked && d.replaced_by.as_deref() == Some(device_id))
            .map(|(id, _)| id.clone())
    }
}

/// The verifier shared by a session's identity provider and rules, replaced
/// whenever the app re-verifies device lists.
#[derive(Clone)]
pub struct SharedDirectory(Arc<Mutex<Arc<dyn DeviceListVerifier>>>);

impl Default for SharedDirectory {
    fn default() -> Self {
        SharedDirectory(Arc::new(Mutex::new(Arc::new(DeviceDirectory::default()))))
    }
}

impl SharedDirectory {
    pub fn set(&self, verifier: Arc<dyn DeviceListVerifier>) {
        *self.0.lock().unwrap() = verifier;
    }

    pub fn get(&self) -> Arc<dyn DeviceListVerifier> {
        self.0.lock().unwrap().clone()
    }
}

// ---------------------------------------------------------------------------
// JSON form, as the TypeScript wrapper sends it.

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DirectoryJson {
    users: Vec<UserJson>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UserJson {
    user_id: String,
    #[serde(default)]
    revocation_cutoff_epoch: Option<u64>,
    devices: Vec<DeviceJson>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DeviceJson {
    device_id: String,
    status: String,
    #[serde(default)]
    leaf_keys: Vec<String>,
    #[serde(default)]
    replaced_by: Option<String>,
}

impl DeviceDirectory {
    pub fn from_json(json: &str) -> Res<DeviceDirectory> {
        let parsed: DirectoryJson =
            serde_json::from_str(json).map_err(|e| Error::input(format!("device directory: {e}")))?;
        let mut directory = DeviceDirectory::default();
        for user in parsed.users {
            let mut devices = BTreeMap::new();
            for device in user.devices {
                let revoked = match device.status.as_str() {
                    "active" => false,
                    "revoked" => true,
                    other => return Err(Error::input(format!("device status {other:?}"))),
                };
                let leaf_keys = device
                    .leaf_keys
                    .iter()
                    .map(|k| hex::decode(k).map_err(|_| Error::input("leaf key is not hex")))
                    .collect::<Res<Vec<_>>>()?;
                let entry = DeviceEntry {
                    revoked,
                    leaf_keys,
                    replaced_by: device.replaced_by.map(String::into_bytes),
                };
                if devices.insert(device.device_id.into_bytes(), entry).is_some() {
                    return Err(Error::input("device listed twice"));
                }
            }
            let entry = UserDevices {
                devices,
                revocation_cutoff: user.revocation_cutoff_epoch,
            };
            if directory.users.insert(user.user_id.into_bytes(), entry).is_some() {
                return Err(Error::input("user listed twice"));
            }
        }
        Ok(directory)
    }
}
