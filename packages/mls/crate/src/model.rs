//! Wire types the policy reads: the roles GroupContext extension, the leaf
//! credential, leaf-removal records and rejoin PSK ids.

use mls_rs::{CipherSuite, ExtensionList};
use mls_rs_codec::{MlsDecode, MlsEncode, MlsSize};
use mls_rs_core::{
    extension::{ExtensionType, MlsCodecExtension},
    identity::{Credential, CredentialType, CustomCredential, SigningIdentity},
    psk::ExternalPskId,
};

use crate::error::{Error, Reason};

/// MLS_128_DHKEMP256_AES128GCM_SHA256_P256 (0x0002), ADR-024.
pub const SUITE: CipherSuite = CipherSuite::P256_AES128;
/// Private-use extension and credential types (RFC 9420 §17.3, 0xF000+).
pub const ROLES_EXT: ExtensionType = ExtensionType::new(0xF0A1);
pub const DEVICE_CREDENTIAL: CredentialType = CredentialType::new(0xF0A2);
pub const REMOVALS_EXT: ExtensionType = ExtensionType::new(0xF0A3);

pub const PROJECT_KEY_LABEL: &[u8] = b"openzcad project key";
pub const REJOIN_PSK_LABEL: &[u8] = b"openzcad rejoin psk";
pub const REJOIN_PSK_PREFIX: &str = "ozc-rejoin/";
pub const GROUP_ID_PREFIX: &[u8] = b"openzcad/project/";
pub const CERTIFICATION_LABEL: &[u8] = b"openzcad mls leaf certification v1";

pub const ROLES_VERSION: u8 = 1;
pub const MAX_ID_BYTES: usize = 256;
pub const MAX_REJOIN_WINDOW: u32 = 1024;

pub fn group_id(project_id: &[u8]) -> Vec<u8> {
    [GROUP_ID_PREFIX, project_id].concat()
}

// ---------------------------------------------------------------------------
// Roles

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, MlsSize, MlsEncode, MlsDecode)]
#[repr(u8)]
pub enum Role {
    Viewer = 1,
    Editor = 2,
    Owner = 3,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Viewer => "viewer",
            Role::Editor => "editor",
            Role::Owner => "owner",
        }
    }

    pub fn parse(value: &str) -> Result<Role, Error> {
        match value {
            "viewer" => Ok(Role::Viewer),
            "editor" => Ok(Role::Editor),
            "owner" => Ok(Role::Owner),
            other => Err(Error::input(format!("unknown role {other:?}"))),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, MlsSize, MlsEncode, MlsDecode)]
pub struct RoleEntry {
    pub user_id: Vec<u8>,
    pub role: Role,
    /// The epoch in which this entry's current role took effect: the epoch
    /// created by the Commit that added the identity or last changed its role.
    pub since: u64,
}

/// The roles GroupContext extension. Every member agrees on it through the
/// GroupContext, so the rejoin window lives here too: members that disagreed
/// on it would accept different external Commits.
#[derive(Clone, Debug, PartialEq, Eq, MlsSize, MlsEncode, MlsDecode)]
pub struct ProjectRoles {
    pub version: u8,
    pub rejoin_window: u32,
    /// Sorted by `user_id`, no duplicates, exactly one owner.
    pub users: Vec<RoleEntry>,
}

impl MlsCodecExtension for ProjectRoles {
    fn extension_type() -> ExtensionType {
        ROLES_EXT
    }
}

impl ProjectRoles {
    pub fn entry(&self, user_id: &[u8]) -> Option<&RoleEntry> {
        self.users.iter().find(|u| u.user_id == user_id)
    }

    pub fn role(&self, user_id: &[u8]) -> Option<Role> {
        self.entry(user_id).map(|u| u.role)
    }

    pub fn from_extensions(extensions: &ExtensionList) -> Result<ProjectRoles, Reason> {
        extensions
            .get_as::<ProjectRoles>()
            .map_err(|e| Reason::new("roles-invalid", format!("roles extension does not decode: {e:?}")))?
            .ok_or_else(|| Reason::new("roles-invalid", "the GroupContext has no roles extension"))
    }

    pub fn to_extensions(&self) -> Result<ExtensionList, Error> {
        let mut list = ExtensionList::new();
        list.set_from(self.clone())
            .map_err(|e| Error::state(format!("{e:?}")))?;
        Ok(list)
    }

    /// Structural rules every roles extension must satisfy.
    pub fn check_shape(&self) -> Vec<Reason> {
        let mut reasons = Vec::new();
        if self.version != ROLES_VERSION {
            reasons.push(Reason::new(
                "roles-invalid",
                format!("roles version {} is not {ROLES_VERSION}", self.version),
            ));
        }
        if self.rejoin_window == 0 || self.rejoin_window > MAX_REJOIN_WINDOW {
            reasons.push(Reason::new(
                "roles-invalid",
                format!(
                    "rejoin window {} is outside 1..={MAX_REJOIN_WINDOW}",
                    self.rejoin_window
                ),
            ));
        }
        if !self.users.windows(2).all(|w| w[0].user_id < w[1].user_id) {
            reasons.push(Reason::new(
                "roles-invalid",
                "roles are not sorted by user id without duplicates",
            ));
        }
        if self
            .users
            .iter()
            .any(|u| u.user_id.is_empty() || u.user_id.len() > MAX_ID_BYTES)
        {
            reasons.push(Reason::new("roles-invalid", "a user id is empty or too long"));
        }
        let owners = self.users.iter().filter(|u| u.role == Role::Owner).count();
        if owners != 1 {
            reasons.push(Reason::new(
                "roles-invalid",
                format!("{owners} owners listed; exactly one is required"),
            ));
        }
        reasons
    }

    /// The Commit that installs `next` creates epoch `next_epoch`. Unchanged
    /// entries keep their `since`; added or changed entries must say
    /// `next_epoch`, so every member can trust `since` as the role-change
    /// cutoff for rejoins.
    pub fn check_transition(&self, next: &ProjectRoles, next_epoch: u64) -> Vec<Reason> {
        let mut reasons = next.check_shape();
        for entry in &next.users {
            let expected = match self.entry(&entry.user_id) {
                Some(old) if old.role == entry.role => old.since,
                _ => next_epoch,
            };
            if entry.since != expected {
                reasons.push(Reason::new(
                    "roles-invalid",
                    format!(
                        "role of {} says since {} but must say {expected}",
                        display_id(&entry.user_id),
                        entry.since
                    ),
                ));
            }
        }
        reasons
    }
}

// ---------------------------------------------------------------------------
// Leaf credential

/// The credential in every leaf. `certification` is the device's signature
/// over [`certification_payload`]; this crate never interprets it, the
/// injected device-list verifier does.
#[derive(Clone, Debug, PartialEq, Eq, MlsSize, MlsEncode, MlsDecode)]
pub struct DeviceCredential {
    pub user_id: Vec<u8>,
    pub device_id: Vec<u8>,
    pub certification: Vec<u8>,
}

impl DeviceCredential {
    pub fn to_credential(&self) -> Result<Credential, Error> {
        Ok(Credential::Custom(CustomCredential::new(
            DEVICE_CREDENTIAL,
            self.mls_encode_to_vec().map_err(Error::codec)?,
        )))
    }

    pub fn from_identity(identity: &SigningIdentity) -> Result<DeviceCredential, Reason> {
        let Credential::Custom(custom) = &identity.credential else {
            return Err(Reason::new(
                "credential-invalid",
                "leaf credential is not a device credential",
            ));
        };
        if custom.credential_type != DEVICE_CREDENTIAL {
            return Err(Reason::new(
                "credential-invalid",
                "leaf credential is not a device credential",
            ));
        }
        let mut input: &[u8] = &custom.data;
        let credential = DeviceCredential::mls_decode(&mut input).map_err(|e| {
            Reason::new(
                "credential-invalid",
                format!("device credential does not decode: {e:?}"),
            )
        })?;
        if !input.is_empty() {
            return Err(Reason::new(
                "credential-invalid",
                "trailing bytes after the device credential",
            ));
        }
        if credential.user_id.is_empty()
            || credential.device_id.is_empty()
            || credential.user_id.len() > MAX_ID_BYTES
            || credential.device_id.len() > MAX_ID_BYTES
        {
            return Err(Reason::new(
                "credential-invalid",
                "user or device id is empty or too long",
            ));
        }
        Ok(credential)
    }
}

#[derive(MlsSize, MlsEncode)]
struct CertificationPayload<'a> {
    label: &'a [u8],
    project_id: &'a [u8],
    user_id: &'a [u8],
    device_id: &'a [u8],
    cipher_suite: u16,
    signature_key: &'a [u8],
}

/// The bytes a device signs to certify a per-project leaf signing key.
pub fn certification_payload(
    project_id: &[u8],
    user_id: &[u8],
    device_id: &[u8],
    signature_key: &[u8],
) -> Result<Vec<u8>, Error> {
    CertificationPayload {
        label: CERTIFICATION_LABEL,
        project_id,
        user_id,
        device_id,
        cipher_suite: *SUITE,
        signature_key,
    }
    .mls_encode_to_vec()
    .map_err(Error::codec)
}

// ---------------------------------------------------------------------------
// Leaf removals

/// One leaf that left the group. `epoch` is the first epoch without it, so
/// the leaf never derived that epoch's rejoin PSK.
#[derive(Clone, Debug, PartialEq, Eq, MlsSize, MlsEncode, MlsDecode)]
pub struct LeafRemoval {
    pub user_id: Vec<u8>,
    pub device_id: Vec<u8>,
    pub signature_key: Vec<u8>,
    pub epoch: u64,
}

/// Removal records carried in GroupInfo (Welcome and external-commit
/// GroupInfo), so a joiner starts with the committer's records instead of
/// none. Signed by the committer as part of the GroupInfo.
#[derive(Clone, Debug, Default, PartialEq, Eq, MlsSize, MlsEncode, MlsDecode)]
pub struct LeafRemovals {
    pub records: Vec<LeafRemoval>,
}

impl MlsCodecExtension for LeafRemovals {
    fn extension_type() -> ExtensionType {
        REMOVALS_EXT
    }
}

impl LeafRemovals {
    /// The newest removal of a leaf for this device, or with this signature
    /// key. Device ids cover a removed device that certifies a fresh leaf key.
    pub fn cutoff(&self, user_id: &[u8], device_id: &[u8], signature_key: &[u8]) -> Option<u64> {
        self.records
            .iter()
            .filter(|r| (r.user_id == user_id && r.device_id == device_id) || r.signature_key == signature_key)
            .map(|r| r.epoch)
            .max()
    }

    /// The newest removal of any leaf of this identity.
    pub fn identity_cutoff(&self, user_id: &[u8]) -> Option<u64> {
        self.records
            .iter()
            .filter(|r| r.user_id == user_id)
            .map(|r| r.epoch)
            .max()
    }

    pub fn key_was_removed(&self, signature_key: &[u8]) -> bool {
        self.records.iter().any(|r| r.signature_key == signature_key)
    }

    pub fn merge(&mut self, other: &LeafRemovals) {
        for record in &other.records {
            if !self.records.contains(record) {
                self.records.push(record.clone());
            }
        }
        self.records
            .sort_by(|a, b| a.epoch.cmp(&b.epoch).then(a.signature_key.cmp(&b.signature_key)));
    }
}

// ---------------------------------------------------------------------------
// Rejoin PSK ids: `ozc-rejoin/<epoch>`, epoch in canonical decimal.

pub fn rejoin_psk_id(epoch: u64) -> ExternalPskId {
    ExternalPskId::new(format!("{REJOIN_PSK_PREFIX}{epoch}").into_bytes())
}

pub fn rejoin_psk_epoch(id: &ExternalPskId) -> Option<u64> {
    let text = std::str::from_utf8(id.as_ref()).ok()?;
    let digits = text.strip_prefix(REJOIN_PSK_PREFIX)?;
    let canonical = !digits.is_empty()
        && digits.len() <= 20
        && digits.bytes().all(|b| b.is_ascii_digit())
        && (digits == "0" || !digits.starts_with('0'));
    if !canonical {
        return None;
    }
    digits.parse().ok()
}

pub fn display_id(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) if text.chars().all(|c| !c.is_control()) => text.to_string(),
        _ => hex::encode(bytes),
    }
}
