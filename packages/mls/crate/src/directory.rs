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
    /// The newest revocation cutoff among the user's revoked devices, except
    /// `except`: the first epoch of this group whose rejoin PSK that device
    /// must not know. A rejoin PSK must be from this epoch or later.
    fn revocation_cutoff(&self, user_id: &[u8], except: Option<&[u8]>) -> Option<u64>;
    /// The group epoch from which this leaf key's certification counts, if
    /// the device list records one.
    fn certified_epoch(&self, user_id: &[u8], device_id: &[u8], signature_key: &[u8]) -> Option<u64>;
    /// Every revoked device whose revocation named this device as its
    /// replacement.
    fn replaces(&self, user_id: &[u8], device_id: &[u8]) -> Vec<Vec<u8>>;
}

#[derive(Clone, Debug, Default)]
pub struct DeviceEntry {
    pub revoked: bool,
    /// Verified leaf keys, each with the group epoch its certification
    /// took effect in, when the device list records one.
    pub leaf_keys: Vec<(Vec<u8>, Option<u64>)>,
    pub replaced_by: Option<Vec<u8>>,
    /// For a revoked device: the per-project cutoff its revocation carries.
    pub revocation_cutoff: Option<u64>,
}

#[derive(Clone, Debug, Default)]
pub struct UserDevices {
    pub devices: BTreeMap<Vec<u8>, DeviceEntry>,
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
        } else if device.leaf_keys.iter().any(|(k, _)| k == signature_key) {
            CredentialStatus::Certified
        } else {
            CredentialStatus::Unknown
        }
    }

    fn revocation_cutoff(&self, user_id: &[u8], except: Option<&[u8]>) -> Option<u64> {
        self.users.get(user_id).and_then(|u| {
            u.devices
                .iter()
                .filter(|(id, d)| d.revoked && Some(id.as_slice()) != except)
                .filter_map(|(_, d)| d.revocation_cutoff)
                .max()
        })
    }

    fn certified_epoch(&self, user_id: &[u8], device_id: &[u8], signature_key: &[u8]) -> Option<u64> {
        self.users
            .get(user_id)
            .and_then(|u| u.devices.get(device_id))
            .and_then(|d| d.leaf_keys.iter().find(|(k, _)| k == signature_key))
            .and_then(|(_, epoch)| *epoch)
    }

    fn replaces(&self, user_id: &[u8], device_id: &[u8]) -> Vec<Vec<u8>> {
        self.users
            .get(user_id)
            .map(|user| {
                user.devices
                    .iter()
                    .filter(|(_, d)| d.revoked && d.replaced_by.as_deref() == Some(device_id))
                    .map(|(id, _)| id.clone())
                    .collect()
            })
            .unwrap_or_default()
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
    devices: Vec<DeviceJson>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DeviceJson {
    device_id: String,
    status: String,
    #[serde(default)]
    leaf_keys: Vec<LeafKeyJson>,
    #[serde(default)]
    replaced_by: Option<String>,
    #[serde(default)]
    revocation_cutoff_epoch: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct LeafKeyJson {
    key: String,
    #[serde(default)]
    certified_epoch: Option<u64>,
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
                    .map(|k| {
                        hex::decode(&k.key)
                            .map(|key| (key, k.certified_epoch))
                            .map_err(|_| Error::input("leaf key is not hex"))
                    })
                    .collect::<Res<Vec<_>>>()?;
                let entry = DeviceEntry {
                    revoked,
                    leaf_keys,
                    replaced_by: device.replaced_by.map(String::into_bytes),
                    revocation_cutoff: device.revocation_cutoff_epoch,
                };
                if devices.insert(device.device_id.into_bytes(), entry).is_some() {
                    return Err(Error::input("device listed twice"));
                }
            }
            let entry = UserDevices { devices };
            if directory.users.insert(user.user_id.into_bytes(), entry).is_some() {
                return Err(Error::input("user listed twice"));
            }
        }
        Ok(directory)
    }
}
