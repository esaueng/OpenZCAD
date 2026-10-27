//! The device-list verifier the policy consults.
//!
//! mls-rs callbacks are synchronous here and cannot await WebCrypto, so the
//! app verifies identity-signed device lists and leaf certifications first
//! and injects the result. [`DeviceDirectory`] is that verified snapshot.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde::Deserialize;

use crate::error::{Error, Res};

// The browser uses this reserved value to fence PSK rejoins when a shared
// project's device revocation has no signed cutoff. It is not a historical
// cutoff and must never reactivate that device during archive verification.
const UNSIGNED_REVOCATION_CUTOFF: u64 = 9_007_199_254_740_991;

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
    /// The newest revocation cutoff among the user's revoked devices, other
    /// than those in `except`: the first epoch of this group whose rejoin PSK that device
    /// must not know. A rejoin PSK must be from this epoch or later.
    fn revocation_cutoff(&self, user_id: &[u8], except: &[Vec<u8>]) -> Option<u64>;
    /// The group epoch from which this leaf key's certification counts: the
    /// `certified_epoch` the certifying device signed in the certification
    /// payload, which the app verifies before it sets one.
    fn certified_epoch(&self, user_id: &[u8], device_id: &[u8], signature_key: &[u8]) -> Option<u64>;
    /// Every revoked device whose revocation named this device as its
    /// replacement.
    fn replaces(&self, user_id: &[u8], device_id: &[u8]) -> Vec<Vec<u8>>;
    /// Independently apply each device's signed cutoff, retaining earlier
    /// revocations even when another device has a later cutoff.
    fn at_epoch(&self, epoch: u64) -> Arc<dyn DeviceListVerifier>;
}

#[derive(Clone, Debug, Default)]
pub struct DeviceEntry {
    pub revoked: bool,
    /// Verified leaf keys, each with the signed group epoch its
    /// certification counts from, when the app supplied one.
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
    fn at_epoch(&self, epoch: u64) -> Arc<dyn DeviceListVerifier> {
        let mut historical = self.clone();
        for user in historical.users.values_mut() {
            for device in user.devices.values_mut() {
                device.leaf_keys.retain(|(_, at)| at.is_some_and(|at| at <= epoch));
                if device.revocation_cutoff == Some(UNSIGNED_REVOCATION_CUTOFF) {
                    // Unknown time cannot fence a past sibling's PSK. Keep
                    // the revoked credential refused. The application binds
                    // replay to independently authenticated membership state.
                    // The live directory retains its conservative PSK fence.
                    device.revocation_cutoff = None;
                    continue;
                }
                if device.revoked
                    && device
                        .revocation_cutoff
                        .is_some_and(|at| at != UNSIGNED_REVOCATION_CUTOFF && epoch < at)
                {
                    device.revoked = false;
                }
            }
        }
        Arc::new(historical)
    }
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

    fn revocation_cutoff(&self, user_id: &[u8], except: &[Vec<u8>]) -> Option<u64> {
        self.users.get(user_id).and_then(|u| {
            u.devices
                .iter()
                .filter(|(id, d)| d.revoked && !except.contains(id))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsigned_cutoff_never_reactivates_a_revoked_credential_or_relaxes_the_psk_fence() {
        let directory = DeviceDirectory::from_json(r#"{"users":[{"userId":"alice","devices":[
            {"deviceId":"known","status":"revoked","revocationCutoffEpoch":5,"leafKeys":[{"key":"01","certifiedEpoch":0}]},
            {"deviceId":"unknown","status":"revoked","revocationCutoffEpoch":9007199254740991,"leafKeys":[{"key":"02","certifiedEpoch":0}]}
        ]}]}"#).unwrap();
        let before = directory.at_epoch(4);
        assert_eq!(
            before.credential_status(b"alice", b"known", &[1]),
            CredentialStatus::Certified
        );
        assert_eq!(
            before.credential_status(b"alice", b"unknown", &[2]),
            CredentialStatus::Revoked
        );
        assert_eq!(before.revocation_cutoff(b"alice", &[]), None);
        assert_eq!(
            directory.revocation_cutoff(b"alice", &[]),
            Some(UNSIGNED_REVOCATION_CUTOFF)
        );
        assert_eq!(
            directory.at_epoch(5).credential_status(b"alice", b"known", &[1]),
            CredentialStatus::Revoked
        );
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
                if revoked && device.revocation_cutoff_epoch.is_none() {
                    return Err(Error::input("revoked device has no revocationCutoffEpoch"));
                }
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
