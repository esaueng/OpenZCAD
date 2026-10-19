//! ADR-024 MLS spike, mls-rs flavour. Throwaway code: one exported async
//! function runs the whole scenario and returns a JSON report. The host
//! supplies `hooks.now()` (a millisecond clock) and
//! `hooks.persist(label, bytes) -> Promise<Uint8Array>` (encrypt, store,
//! reload, decrypt) so the same code runs in Node and in a Web Worker.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use mls_rs::{
    client_builder::{MlsConfig, PaddingMode},
    error::MlsError,
    group::{proposal::BorrowedProposal, GroupContext, ReceivedMessage, Roster, Sender},
    identity::SigningIdentity,
    mls_rules::{CommitDirection, CommitOptions, CommitSource, EncryptionOptions, ProposalBundle},
    CipherSuite, CipherSuiteProvider, Client, CryptoProvider, ExtensionList, Group,
    IdentityProvider, MlsMessage, MlsRules,
};
use mls_rs_codec::{MlsDecode, MlsEncode, MlsSize};
use mls_rs_core::{
    crypto::{SignaturePublicKey, SignatureSecretKey},
    error::IntoAnyError,
    extension::{ExtensionType, MlsCodecExtension},
    group::{EpochRecord, GroupState, GroupStateStorage, ProposalType},
    identity::{Credential, CredentialType, CustomCredential, MemberValidationContext},
    psk::{ExternalPskId, PreSharedKey, PreSharedKeyStorage},
    time::MlsTime,
};
#[cfg(feature = "rustcrypto")]
use mls_rs_crypto_rustcrypto::RustCryptoProvider as Provider;
#[cfg(not(feature = "rustcrypto"))]
use mls_rs_crypto_webcrypto::WebCryptoProvider as Provider;

#[cfg(feature = "rustcrypto")]
const CRYPTO: &str = "mls-rs-crypto-rustcrypto 0.22.1 (RustCrypto, compiled to WASM)";
#[cfg(not(feature = "rustcrypto"))]
const CRYPTO: &str = "mls-rs-crypto-webcrypto 0.15.1 (SubtleCrypto)";
use serde::Serialize;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use zeroize::Zeroizing;

const SUITE: CipherSuite = CipherSuite::P256_AES128; // 0x0002
const ROLES_EXT: ExtensionType = ExtensionType::new(0xF0A1);
const DEVICE_CREDENTIAL: CredentialType = CredentialType::new(0xF0A2);
const EXPORTER_LABEL: &[u8] = b"openzcad project key";

// ---------------------------------------------------------------------------
// Errors

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct SpikeError(String);

impl IntoAnyError for SpikeError {
    fn into_dyn_error(self) -> Result<Box<dyn std::error::Error + Send + Sync>, Self> {
        Ok(Box::new(self))
    }
}

fn err(msg: impl Into<String>) -> SpikeError {
    SpikeError(msg.into())
}

impl From<mls_rs_codec::Error> for SpikeError {
    fn from(e: mls_rs_codec::Error) -> Self {
        err(format!("codec: {e:?}"))
    }
}

type R<T> = Result<T, String>;

fn s<E: std::fmt::Debug>(e: E) -> String {
    format!("{e:?}")
}

// ---------------------------------------------------------------------------
// App types: roles in a GroupContext extension, device credentials

#[derive(Clone, Copy, Debug, PartialEq, Eq, MlsSize, MlsEncode, MlsDecode)]
#[repr(u8)]
enum Role {
    Viewer = 1,
    Editor = 2,
    Owner = 3,
}

#[derive(Clone, Debug, MlsSize, MlsEncode, MlsDecode)]
struct UserEntry {
    user_id: Vec<u8>,
    role: Role,
    /// Epoch from which this role applies (added or last changed).
    since: u64,
}

#[derive(Clone, Debug, MlsSize, MlsEncode, MlsDecode)]
struct RolesExtension {
    users: Vec<UserEntry>,
}

impl MlsCodecExtension for RolesExtension {
    fn extension_type() -> ExtensionType {
        ROLES_EXT
    }
}

impl RolesExtension {
    fn entry(&self, user_id: &[u8]) -> Option<&UserEntry> {
        self.users.iter().find(|u| u.user_id == user_id)
    }
    fn role(&self, user_id: &[u8]) -> Option<Role> {
        self.entry(user_id).map(|u| u.role)
    }
}

/// Leaf credential. In the real design `certification` is the identity-key
/// signature from the user's device list; the spike's directory stands in
/// for the verified device list.
#[derive(Clone, Debug, MlsSize, MlsEncode, MlsDecode)]
struct DeviceCredential {
    user_id: Vec<u8>,
    device_id: Vec<u8>,
}

fn device_credential(identity: &SigningIdentity) -> Result<DeviceCredential, SpikeError> {
    match &identity.credential {
        Credential::Custom(c) if c.credential_type == DEVICE_CREDENTIAL => {
            Ok(DeviceCredential::mls_decode(&mut &*c.data)?)
        }
        _ => Err(err("not a device credential")),
    }
}

/// Certified device signing keys per user, as the app layer would hold them
/// after verifying device lists. IdentityProvider futures must be `Send`, so
/// WebCrypto (whose futures are not) cannot be called from inside the
/// provider: verification has to happen before, in app code.
#[derive(Default)]
struct DirectoryInner {
    keys: HashMap<Vec<u8>, Vec<SignaturePublicKey>>,
    revoked: Vec<SignaturePublicKey>,
    /// Epoch of each user's newest device revocation.
    revoked_at: HashMap<Vec<u8>, u64>,
}

#[derive(Clone, Default)]
struct Directory(Arc<Mutex<DirectoryInner>>);

impl Directory {
    fn certify(&self, user: &[u8], key: &SignaturePublicKey) {
        self.0.lock().unwrap().keys.entry(user.to_vec()).or_default().push(key.clone());
    }
    fn is_certified(&self, user: &[u8], key: &SignaturePublicKey) -> bool {
        let d = self.0.lock().unwrap();
        !d.revoked.contains(key) && d.keys.get(user).map(|keys| keys.contains(key)).unwrap_or(false)
    }
    fn is_revoked(&self, key: &SignaturePublicKey) -> bool {
        self.0.lock().unwrap().revoked.contains(key)
    }
    fn revoke(&self, user: &[u8], key: &SignaturePublicKey, epoch: u64) {
        let mut d = self.0.lock().unwrap();
        d.revoked.push(key.clone());
        d.revoked_at.insert(user.to_vec(), epoch);
    }
    fn revoked_at(&self, user: &[u8]) -> Option<u64> {
        self.0.lock().unwrap().revoked_at.get(user).copied()
    }
}

// ---------------------------------------------------------------------------
// Rejoin PSKs. Neither library lets an external joiner add a resumption PSK,
// so the epoch secret is an exporter output every member derives each epoch,
// carried as an external PSK whose id names the epoch.

const REJOIN_LABEL: &[u8] = b"openzcad rejoin psk";
const REJOIN_PREFIX: &[u8] = b"ozc-rejoin/";

fn rejoin_psk_id(epoch: u64) -> ExternalPskId {
    ExternalPskId::new([REJOIN_PREFIX, &epoch.to_be_bytes()].concat())
}

fn rejoin_psk_epoch(id: &ExternalPskId) -> Option<u64> {
    let bytes: &[u8] = id.as_ref();
    let rest = bytes.strip_prefix(REJOIN_PREFIX)?;
    Some(u64::from_be_bytes(rest.try_into().ok()?))
}

#[derive(Clone, Default)]
struct SpikePsks(Arc<Mutex<BTreeMap<u64, Vec<u8>>>>);

impl SpikePsks {
    /// Keep the last `window` epochs' secrets, as members would.
    fn insert(&self, epoch: u64, secret: Vec<u8>, window: u64) {
        let mut map = self.0.lock().unwrap();
        map.insert(epoch, secret);
        map.retain(|e, _| e.saturating_add(window) >= epoch);
    }
}

#[maybe_async::must_be_async]
impl PreSharedKeyStorage for SpikePsks {
    type Error = SpikeError;

    async fn get(&self, id: &ExternalPskId) -> Result<Option<PreSharedKey>, Self::Error> {
        let Some(epoch) = rejoin_psk_epoch(id) else {
            return Ok(None);
        };
        Ok(self.0.lock().unwrap().get(&epoch).map(|s| PreSharedKey::new(s.clone())))
    }
}

#[derive(Clone)]
struct SpikeIdentity {
    directory: Directory,
}

#[maybe_async::must_be_async]
impl IdentityProvider for SpikeIdentity {
    type Error = SpikeError;

    async fn validate_member(
        &self,
        identity: &SigningIdentity,
        _: Option<MlsTime>,
        context: MemberValidationContext<'_>,
    ) -> Result<(), Self::Error> {
        let cred = device_credential(identity)?;
        if self.directory.is_revoked(&identity.signature_key) {
            return Err(err("device key is revoked"));
        }
        if !self.directory.is_certified(&cred.user_id, &identity.signature_key) {
            return Err(err("device key is not certified for that user"));
        }
        // A leaf must belong to a user who holds a role in the (new) context.
        if let Some(exts) = context.new_extensions() {
            let roles: RolesExtension = exts
                .get_as()
                .map_err(|e| err(format!("{e:?}")))?
                .ok_or_else(|| err("roles extension missing"))?;
            if roles.role(&cred.user_id).is_none() {
                return Err(err("leaf user holds no role in the project"));
            }
        }
        Ok(())
    }

    async fn validate_external_sender(
        &self,
        _: &SigningIdentity,
        _: Option<MlsTime>,
        _: Option<&ExtensionList>,
    ) -> Result<(), Self::Error> {
        Err(err("external senders are not used"))
    }

    async fn identity(
        &self,
        identity: &SigningIdentity,
        _: &ExtensionList,
    ) -> Result<Vec<u8>, Self::Error> {
        let c = device_credential(identity)?;
        Ok([c.user_id, b"/".to_vec(), c.device_id].concat())
    }

    /// Called when an external commit removes a leaf: only the same user's
    /// device may take over (resync after wiped storage).
    async fn valid_successor(
        &self,
        predecessor: &SigningIdentity,
        successor: &SigningIdentity,
        _: &ExtensionList,
    ) -> Result<bool, Self::Error> {
        Ok(device_credential(predecessor)?.user_id == device_credential(successor)?.user_id)
    }

    fn supported_types(&self) -> Vec<CredentialType> {
        vec![DEVICE_CREDENTIAL]
    }
}

// ---------------------------------------------------------------------------
// Role policy

#[derive(Clone)]
struct SpikeRules {
    /// false = a misbehaving client that skips its own policy when sending,
    /// so the spike can prove that receivers reject the commit.
    enforce_on_send: bool,
    /// Some(w): external commits need a rejoin PSK from the last w epochs,
    /// later than the user's newest revocation and role change (ADR-024).
    rejoin_window: Option<u64>,
    directory: Directory,
}

fn user_of_leaf(roster: &Roster, index: u32) -> Result<Vec<u8>, SpikeError> {
    let member = roster
        .member_with_index(index)
        .map_err(|_| err("unknown leaf"))?;
    Ok(device_credential(&member.signing_identity)?.user_id)
}

#[maybe_async::must_be_async]
impl MlsRules for SpikeRules {
    type Error = SpikeError;

    async fn filter_proposals(
        &self,
        direction: CommitDirection,
        source: CommitSource,
        roster: &Roster,
        context: &GroupContext,
        proposals: ProposalBundle,
    ) -> Result<ProposalBundle, Self::Error> {
        if direction == CommitDirection::Send && !self.enforce_on_send {
            return Ok(proposals);
        }
        let roles: RolesExtension = context
            .extensions
            .get_as()
            .map_err(|e| err(format!("{e:?}")))?
            .ok_or_else(|| err("roles extension missing"))?;

        match source {
            CommitSource::NewMember(identity) => {
                // External commit: only a certified device of a user already in
                // the project (the IdentityProvider checks certification), and
                // only removing that same user's stale leaves.
                // Collect every failed rule so the spike can show which fired.
                let joiner = device_credential(&identity)?;
                let mut reasons: Vec<String> = Vec::new();
                if self.directory.is_revoked(&identity.signature_key) {
                    reasons.push("credential revoked".into());
                }
                let entry = roles.entry(&joiner.user_id);
                if entry.is_none() {
                    reasons.push("identity not listed in the roles extension".into());
                }
                let mut psk_epoch = None;
                for p in proposals.iter_proposals() {
                    match p.proposal {
                        BorrowedProposal::ExternalInit(_) => {}
                        BorrowedProposal::Remove(r) => {
                            if user_of_leaf(roster, r.to_remove())? != joiner.user_id {
                                reasons.push("external commit may only replace own devices".into());
                            }
                        }
                        BorrowedProposal::Psk(psk) => {
                            match psk.external_psk_id().and_then(rejoin_psk_epoch) {
                                Some(e) => psk_epoch = Some(e),
                                None => reasons.push("PSK is not a rejoin PSK".into()),
                            }
                        }
                        _ => reasons.push("proposal not allowed in an external commit".into()),
                    }
                }
                if let Some(window) = self.rejoin_window {
                    match psk_epoch {
                        None => reasons.push("no rejoin PSK".into()),
                        Some(e) => {
                            if let Some(r) = self.directory.revoked_at(&joiner.user_id) {
                                if e < r {
                                    reasons.push(format!("PSK epoch {e} before newest revocation {r}"));
                                }
                            }
                            if let Some(entry) = entry {
                                if e < entry.since {
                                    reasons.push(format!("PSK epoch {e} before role change {}", entry.since));
                                }
                            }
                            if context.epoch.saturating_sub(e) > window {
                                reasons.push(format!(
                                    "PSK epoch {e} outside the {window}-epoch window (now {})",
                                    context.epoch
                                ));
                            }
                        }
                    }
                }
                if !reasons.is_empty() {
                    return Err(err(reasons.join("; ")));
                }
            }
            CommitSource::ExistingMember(_) => {
                for p in proposals.iter_proposals() {
                    let Sender::Member(sender_leaf) = p.sender else {
                        return Err(err("only members may propose"));
                    };
                    let sender_user = user_of_leaf(roster, sender_leaf)?;
                    let role = roles
                        .role(&sender_user)
                        .ok_or_else(|| err("sender holds no role"))?;
                    let ok = match p.proposal {
                        BorrowedProposal::Update(_) | BorrowedProposal::SelfRemove(_) => true,
                        BorrowedProposal::Remove(r) => {
                            role == Role::Owner || user_of_leaf(roster, r.to_remove())? == sender_user
                        }
                        BorrowedProposal::Add(_) | BorrowedProposal::GroupContextExtensions(_) => {
                            role == Role::Owner
                        }
                        _ => false,
                    };
                    if !ok {
                        return Err(err(format!(
                            "role {role:?} may not send proposal {:?}",
                            p.proposal.proposal_type()
                        )));
                    }
                }
            }
        }
        Ok(proposals)
    }

    fn commit_options(
        &self,
        _: &Roster,
        _: &GroupContext,
        _: &ProposalBundle,
    ) -> Result<CommitOptions, Self::Error> {
        Ok(CommitOptions::new()
            .with_path_required(true)
            .with_ratchet_tree_extension(true))
    }

    fn encryption_options(
        &self,
        _: &Roster,
        _: &GroupContext,
    ) -> Result<EncryptionOptions, Self::Error> {
        // Handshake messages stay PublicMessage so the Delivery Service can
        // order commits by epoch (SelfRemove must be public anyway).
        Ok(EncryptionOptions::new(false, PaddingMode::None))
    }
}

// ---------------------------------------------------------------------------
// Group state storage that can be exported as bytes

#[derive(Clone, Default, MlsSize, MlsEncode, MlsDecode)]
struct StoredEpoch {
    id: u64,
    data: Vec<u8>,
}

#[derive(Clone, Default, MlsSize, MlsEncode, MlsDecode)]
struct StoredGroup {
    state: Vec<u8>,
    epochs: Vec<StoredEpoch>,
}

#[derive(Clone, Default)]
struct SpikeStorage(Arc<Mutex<BTreeMap<Vec<u8>, StoredGroup>>>);

const EPOCH_RETENTION: usize = 3;

impl SpikeStorage {
    fn export(&self, group_id: &[u8]) -> Option<Vec<u8>> {
        self.0.lock().unwrap().get(group_id).map(|g| g.mls_encode_to_vec().unwrap())
    }
    fn import(group_id: &[u8], bytes: &[u8]) -> R<Self> {
        let storage = Self::default();
        let group = StoredGroup::mls_decode(&mut &*bytes).map_err(s)?;
        storage.0.lock().unwrap().insert(group_id.to_vec(), group);
        Ok(storage)
    }
}

#[maybe_async::must_be_async]
impl GroupStateStorage for SpikeStorage {
    type Error = SpikeError;

    async fn state(&self, group_id: &[u8]) -> Result<Option<Zeroizing<Vec<u8>>>, Self::Error> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(group_id)
            .map(|g| Zeroizing::new(g.state.clone())))
    }

    async fn epoch(
        &self,
        group_id: &[u8],
        epoch_id: u64,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, Self::Error> {
        Ok(self.0.lock().unwrap().get(group_id).and_then(|g| {
            g.epochs
                .iter()
                .find(|e| e.id == epoch_id)
                .map(|e| Zeroizing::new(e.data.clone()))
        }))
    }

    async fn write(
        &mut self,
        state: GroupState,
        inserts: Vec<EpochRecord>,
        updates: Vec<EpochRecord>,
    ) -> Result<(), Self::Error> {
        let mut map = self.0.lock().unwrap();
        let group = map.entry(state.id.clone()).or_default();
        group.state = state.data.to_vec();
        for u in updates {
            if let Some(e) = group.epochs.iter_mut().find(|e| e.id == u.id) {
                e.data = u.data.to_vec();
            }
        }
        for i in inserts {
            group.epochs.push(StoredEpoch { id: i.id, data: i.data.to_vec() });
        }
        while group.epochs.len() > EPOCH_RETENTION {
            group.epochs.remove(0);
        }
        Ok(())
    }

    async fn max_epoch_id(&self, group_id: &[u8]) -> Result<Option<u64>, Self::Error> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(group_id)
            .and_then(|g| g.epochs.iter().map(|e| e.id).max()))
    }
}

// ---------------------------------------------------------------------------
// Host hooks

struct Hooks {
    obj: JsValue,
}

impl Hooks {
    fn now(&self) -> f64 {
        let f: js_sys::Function = js_sys::Reflect::get(&self.obj, &"now".into())
            .unwrap()
            .into();
        f.call0(&self.obj).unwrap().as_f64().unwrap()
    }

    async fn persist(&self, label: &str, bytes: &[u8]) -> R<Vec<u8>> {
        let f: js_sys::Function = js_sys::Reflect::get(&self.obj, &"persist".into())
            .map_err(s)?
            .into();
        let promise: js_sys::Promise = f
            .call2(&self.obj, &label.into(), &js_sys::Uint8Array::from(bytes))
            .map_err(s)?
            .into();
        let out = JsFuture::from(promise).await.map_err(s)?;
        Ok(js_sys::Uint8Array::new(&out).to_vec())
    }
}

// ---------------------------------------------------------------------------
// Report

#[derive(Serialize, Default)]
struct Step {
    name: String,
    ok: bool,
    detail: String,
}

#[derive(Serialize, Default)]
struct Report {
    library: &'static str,
    version: &'static str,
    crypto: &'static str,
    cipher_suite: u16,
    steps: Vec<Step>,
    commit_create_ms: Vec<f64>,
    commit_process_ms: Vec<f64>,
    add_commit_ms: Vec<f64>,
    welcome_join_ms: Vec<f64>,
    external_commit_ms: Vec<f64>,
    sizes: BTreeMap<String, usize>,
    epoch_checks: u32,
    exporter_sample: String,
    final_epoch: u64,
}

impl Report {
    fn step(&mut self, name: &str, result: R<String>) {
        let (ok, detail) = match result {
            Ok(d) => (true, d),
            Err(e) => (false, e),
        };
        self.steps.push(Step { name: name.into(), ok, detail });
    }
}

// ---------------------------------------------------------------------------
// Devices

struct Device<C: MlsConfig> {
    name: String,
    user: Vec<u8>,
    client: Client<C>,
    secret: SignatureSecretKey,
    identity: SigningIdentity,
    storage: SpikeStorage,
    psks: SpikePsks,
    /// Rejoin PSKs this device kept (the real design wraps them under the
    /// account key so a wiped device can recover them).
    saved: Vec<(u64, Vec<u8>)>,
    group: Option<Group<C>>,
}

fn make_client(
    identity: SigningIdentity,
    secret: SignatureSecretKey,
    directory: Directory,
    storage: SpikeStorage,
    psks: SpikePsks,
    enforce_on_send: bool,
    rejoin_window: Option<u64>,
) -> Client<impl MlsConfig> {
    Client::builder()
        .crypto_provider(Provider::new())
        .identity_provider(SpikeIdentity { directory: directory.clone() })
        .mls_rules(SpikeRules { enforce_on_send, rejoin_window, directory })
        .group_state_storage(storage)
        .psk_store(psks)
        .extension_type(ROLES_EXT)
        .custom_proposal_type(ProposalType::SELF_REMOVE)
        .signing_identity(identity, secret, SUITE)
        .build()
}

async fn new_identity(
    user: &str,
    device: &str,
    directory: &Directory,
    certify: bool,
) -> R<(SigningIdentity, SignatureSecretKey)> {
    let cs = Provider::new()
        .cipher_suite_provider(SUITE)
        .ok_or("suite unsupported")?;
    let (secret, public) = cs.signature_key_generate().await.map_err(s)?;
    let cred = DeviceCredential {
        user_id: user.as_bytes().to_vec(),
        device_id: device.as_bytes().to_vec(),
    };
    let credential = Credential::Custom(CustomCredential::new(
        DEVICE_CREDENTIAL,
        cred.mls_encode_to_vec().map_err(s)?,
    ));
    if certify {
        directory.certify(user.as_bytes(), &public);
    }
    Ok((SigningIdentity::new(credential, public), secret))
}

macro_rules! device {
    ($user:expr, $dev:expr, $dir:expr, $certify:expr, $enforce:expr) => {
        device!($user, $dev, $dir, $certify, $enforce, None)
    };
    ($user:expr, $dev:expr, $dir:expr, $certify:expr, $enforce:expr, $window:expr) => {{
        let (identity, secret) = new_identity($user, $dev, &$dir, $certify).await?;
        let storage = SpikeStorage::default();
        let psks = SpikePsks::default();
        Device {
            name: $dev.to_string(),
            user: $user.as_bytes().to_vec(),
            client: make_client(
                identity.clone(),
                secret.clone(),
                $dir.clone(),
                storage.clone(),
                psks.clone(),
                $enforce,
                $window,
            ),
            secret,
            identity,
            storage,
            psks,
            saved: Vec::new(),
            group: None,
        }
    }};
}

/// A fresh client for a removed device that kept its certified key. A macro
/// so the client has the same opaque config type as every other device.
macro_rules! rejoiner {
    ($d:expr, $dir:expr, $window:expr) => {{
        let storage = SpikeStorage::default();
        let psks = SpikePsks::default();
        Device {
            name: format!("{} (rejoining)", $d.name),
            user: $d.user.clone(),
            client: make_client(
                $d.identity.clone(),
                $d.secret.clone(),
                $dir.clone(),
                storage.clone(),
                psks.clone(),
                false,
                $window,
            ),
            secret: $d.secret.clone(),
            identity: $d.identity.clone(),
            storage,
            psks,
            saved: Vec::new(),
            group: None,
        }
    }};
}

fn g<C: MlsConfig>(d: &mut Device<C>) -> R<&mut Group<C>> {
    d.group.as_mut().ok_or_else(|| format!("{} has no group", d.name))
}

/// Deliver a handshake message to every listed device and time it.
async fn deliver<C: MlsConfig>(
    hooks: &Hooks,
    report: &mut Report,
    msg: &MlsMessage,
    to: &mut [&mut Device<C>],
) -> R<()> {
    for d in to.iter_mut() {
        let t = hooks.now();
        let out = g(d)?
            .process_incoming_message(msg.clone())
            .await
            .map_err(|e| format!("{} rejected: {e:?}", d.name))?;
        if matches!(out, ReceivedMessage::Commit(_)) {
            report.commit_process_ms.push(hooks.now() - t);
        }
    }
    Ok(())
}

/// All listed devices are in the same epoch with the same epoch
/// authenticator and the same exported project key.
async fn check_agreement<C: MlsConfig>(
    report: &mut Report,
    project_id: &[u8],
    devices: &[&Device<C>],
) -> R<String> {
    let mut seen: Option<(u64, Vec<u8>, Vec<u8>)> = None;
    for d in devices {
        let group = d.group.as_ref().ok_or("missing group")?;
        let epoch = group.current_epoch();
        let auth = group.epoch_authenticator().map_err(s)?.to_vec();
        let key = group
            .export_secret(EXPORTER_LABEL, project_id, 32)
            .await
            .map_err(s)?
            .to_vec();
        match &seen {
            None => seen = Some((epoch, auth, key)),
            Some((e, a, k)) => {
                if *e != epoch || *a != auth || *k != key {
                    return Err(format!("{} disagrees at epoch {epoch}", d.name));
                }
            }
        }
    }
    report.epoch_checks += 1;
    let (epoch, _, key) = seen.ok_or("no devices")?;
    report.exporter_sample = hex::encode(&key[..8]);
    report.final_epoch = epoch;
    Ok(format!("epoch {epoch}, {} members agree", devices.len()))
}

fn roles(entries: &[(&str, Role)]) -> R<ExtensionList> {
    let mut list = ExtensionList::new();
    list.set_from(RolesExtension {
        users: entries
            .iter()
            .map(|(u, r)| UserEntry { user_id: u.as_bytes().to_vec(), role: *r, since: 0 })
            .collect(),
    })
    .map_err(s)?;
    Ok(list)
}

fn size(msg: &MlsMessage) -> usize {
    msg.mls_encoded_len()
}

// ---------------------------------------------------------------------------
// Scenario

#[wasm_bindgen]
pub async fn run_scenario(project_id: String, hooks: JsValue, rounds: u32) -> Result<String, JsValue> {
    let hooks = Hooks { obj: hooks };
    let mut report = Report {
        library: if cfg!(feature = "rustcrypto") { "mls-rs+rustcrypto" } else { "mls-rs+webcrypto" },
        version: "0.56.0",
        crypto: CRYPTO,
        cipher_suite: 2,
        ..Default::default()
    };
    if let Err(e) = scenario(&hooks, &mut report, project_id.as_bytes(), rounds).await {
        report.step("aborted", Err(e));
    }
    serde_json::to_string(&report).map_err(|e| JsValue::from_str(&e.to_string()))
}

async fn scenario(hooks: &Hooks, report: &mut Report, project_id: &[u8], rounds: u32) -> R<()> {
    let dir = Directory::default();
    let group_id = [b"project:".as_slice(), project_id].concat();

    let mut a1 = device!("A", "A1", dir, true, true);
    let mut a2 = device!("A", "A2", dir, true, true);
    // B's client skips its own send-side policy so receivers can be tested.
    let mut b1 = device!("B", "B1", dir, true, false);

    // 1. Create, KeyPackage, Add, Welcome --------------------------------
    a1.group = Some(
        a1.client
            .create_group_with_id(group_id.clone(), roles(&[("A", Role::Owner)])?, Default::default(), None)
            .await
            .map_err(s)?,
    );
    let kp_a2 = a2
        .client
        .generate_key_package_message(Default::default(), Default::default(), None)
        .await
        .map_err(s)?;
    report.sizes.insert("key_package".into(), size(&kp_a2));
    let t = hooks.now();
    let out = g(&mut a1)?
        .commit_builder()
        .add_member(kp_a2)
        .map_err(s)?
        .build()
        .await
        .map_err(s)?;
    report.add_commit_ms.push(hooks.now() - t);
    g(&mut a1)?.apply_pending_commit().await.map_err(s)?;
    report.sizes.insert("welcome_1_joiner".into(), size(&out.welcome_messages[0]));
    let t = hooks.now();
    a2.group = Some(a2.client.join_group(None, &out.welcome_messages[0], None).await.map_err(s)?.0);
    report.welcome_join_ms.push(hooks.now() - t);
    let r = check_agreement(report, project_id, &[&a1, &a2]).await;
    report.step("create + add A2 via Welcome", r);

    // Owner adds B's device and grants B the editor role in one Commit.
    let kp_b1 = b1
        .client
        .generate_key_package_message(Default::default(), Default::default(), None)
        .await
        .map_err(s)?;
    let t = hooks.now();
    let out = g(&mut a1)?
        .commit_builder()
        .add_member(kp_b1)
        .map_err(s)?
        .set_group_context_ext(roles(&[("A", Role::Owner), ("B", Role::Editor)])?)
        .map_err(s)?
        .build()
        .await
        .map_err(s)?;
    report.add_commit_ms.push(hooks.now() - t);
    g(&mut a1)?.apply_pending_commit().await.map_err(s)?;
    deliver(hooks, report, &out.commit_message, &mut [&mut a2]).await?;
    let t = hooks.now();
    b1.group = Some(b1.client.join_group(None, &out.welcome_messages[0], None).await.map_err(s)?.0);
    report.welcome_join_ms.push(hooks.now() - t);
    let r = check_agreement(report, project_id, &[&a1, &a2, &b1]).await;
    report.step("add B1 with editor role", r);

    // 2. Update -----------------------------------------------------------
    let update = g(&mut b1)?.propose_update(vec![]).await.map_err(s)?;
    deliver(hooks, report, &update, &mut [&mut a1, &mut a2]).await?;
    let t = hooks.now();
    let out = g(&mut a1)?.commit(vec![]).await.map_err(s)?;
    report.commit_create_ms.push(hooks.now() - t);
    g(&mut a1)?.apply_pending_commit().await.map_err(s)?;
    deliver(hooks, report, &out.commit_message, &mut [&mut a2, &mut b1]).await?;
    let r = check_agreement(report, project_id, &[&a1, &a2, &b1]).await;
    report.step("Update proposal by B1, committed by A1", r);

    // 3. Commit timing: rotating empty (path-only) commits ---------------
    for round in 0..rounds {
        let order = round % 3;
        let (committer, others): (&mut Device<_>, [&mut Device<_>; 2]) = match order {
            0 => (&mut a1, [&mut a2, &mut b1]),
            1 => (&mut a2, [&mut a1, &mut b1]),
            _ => (&mut b1, [&mut a1, &mut a2]),
        };
        let t = hooks.now();
        let out = g(committer)?.commit(vec![]).await.map_err(s)?;
        report.commit_create_ms.push(hooks.now() - t);
        g(committer)?.apply_pending_commit().await.map_err(s)?;
        report.sizes.insert("commit_path_only".into(), size(&out.commit_message));
        let [x, y] = others;
        deliver(hooks, report, &out.commit_message, &mut [x, y]).await?;
        check_agreement(report, project_id, &[&a1, &a2, &b1]).await?;
    }
    report.step("timed path-only commits", Ok(format!("{rounds} rounds")));

    // 4. Welcome timing: add and remove a temporary device of A -----------
    for i in 0..rounds.min(5) {
        let mut tmp = device!("A", format!("T{i}").as_str(), dir, true, true);
        let kp = tmp
            .client
            .generate_key_package_message(Default::default(), Default::default(), None)
            .await
            .map_err(s)?;
        let t = hooks.now();
        let out = g(&mut a1)?.commit_builder().add_member(kp).map_err(s)?.build().await.map_err(s)?;
        report.add_commit_ms.push(hooks.now() - t);
        g(&mut a1)?.apply_pending_commit().await.map_err(s)?;
        report.sizes.insert("welcome_4_member_group".into(), size(&out.welcome_messages[0]));
        deliver(hooks, report, &out.commit_message, &mut [&mut a2, &mut b1]).await?;
        let t = hooks.now();
        tmp.group = Some(tmp.client.join_group(None, &out.welcome_messages[0], None).await.map_err(s)?.0);
        report.welcome_join_ms.push(hooks.now() - t);
        check_agreement(report, project_id, &[&a1, &a2, &b1, &tmp]).await?;
        let idx = g(&mut tmp)?.current_member_index();
        let out = g(&mut a1)?.commit_builder().remove_member(idx).map_err(s)?.build().await.map_err(s)?;
        g(&mut a1)?.apply_pending_commit().await.map_err(s)?;
        deliver(hooks, report, &out.commit_message, &mut [&mut a2, &mut b1]).await?;
    }
    let r = check_agreement(report, project_id, &[&a1, &a2, &b1]).await;
    report.step("timed Welcome joins", r);

    // 5. Policy: an editor's Add is rejected by every receiver -------------
    {
        let mut b2 = device!("B", "B2", dir, true, true);
        let kp = b2
            .client
            .generate_key_package_message(Default::default(), Default::default(), None)
            .await
            .map_err(s)?;
        let out = g(&mut b1)?.commit_builder().add_member(kp).map_err(s)?.build().await;
        let r = match out {
            Err(e) => Err(format!("B1 could not even build the commit: {e:?}")),
            Ok(out) => {
                let a1r = g(&mut a1)?.process_incoming_message(out.commit_message.clone()).await;
                let a2r = g(&mut a2)?.process_incoming_message(out.commit_message).await;
                g(&mut b1)?.clear_pending_commit();
                match (a1r, a2r) {
                    (Err(e1), Err(_)) => Ok(format!("both A devices rejected: {}", short(&e1))),
                    _ => Err("an editor's Add was accepted".into()),
                }
            }
        };
        report.step("policy: editor Add rejected", r);
        let _ = &mut b2;
    }

    // 6. Policy: external commit from an uncertified device is rejected ----
    {
        let gi = g(&mut a1)?.group_info_message_allowing_ext_commit(true).await.map_err(s)?;
        report.sizes.insert("group_info_with_external_pub".into(), size(&gi));
        let rogue = device!("A", "rogue", dir, false, false);
        let built = rogue.client.external_commit_builder().map_err(s)?.build(gi).await;
        let r = match built {
            Err(e) => Ok(format!("joiner's own client refused: {}", short(&e))),
            Ok((_, commit)) => {
                let res = g(&mut a1)?.process_incoming_message(commit).await;
                match res {
                    Err(e) => Ok(format!("A1 rejected: {}", short(&e))),
                    Ok(_) => Err("uncertified external commit accepted".into()),
                }
            }
        };
        report.step("policy: uncertified external commit rejected", r);
    }

    // 7. Conflicting commits for one epoch: first wins, loser rebases ------
    {
        let epoch = g(&mut a1)?.current_epoch();
        let first = g(&mut a2)?.commit(vec![]).await.map_err(s)?;
        let second = g(&mut b1)?.commit(vec![]).await.map_err(s)?;
        // The Delivery Service accepts A2's commit (first for this epoch) and
        // refuses B1's. A2 applies, everyone else processes A2's commit.
        g(&mut a2)?.apply_pending_commit().await.map_err(s)?;
        g(&mut b1)?.clear_pending_commit();
        deliver(hooks, report, &first.commit_message, &mut [&mut a1, &mut b1]).await?;
        // The stale commit is unusable once the epoch has moved.
        let stale = g(&mut a1)?.process_incoming_message(second.commit_message).await;
        // B1 rebases: a new commit on the winning epoch.
        let rebased = g(&mut b1)?.commit(vec![]).await.map_err(s)?;
        g(&mut b1)?.apply_pending_commit().await.map_err(s)?;
        deliver(hooks, report, &rebased.commit_message, &mut [&mut a1, &mut a2]).await?;
        let r = check_agreement(report, project_id, &[&a1, &a2, &b1]).await.and_then(|d| {
            if stale.is_ok() {
                Err("stale commit was accepted".into())
            } else {
                Ok(format!("from epoch {epoch}: stale commit refused, rebased; {d}"))
            }
        });
        report.step("conflicting commits, loser rebases", r);
    }

    // 8. Persist A1 through the host (encrypted IndexedDB) and reload ------
    {
        g(&mut a1)?.write_to_storage().await.map_err(s)?;
        let bytes = a1.storage.export(&group_id).ok_or("nothing stored")?;
        report.sizes.insert("state_a1_3_members".into(), bytes.len());
        let secret_len = a1.secret.as_bytes().len();
        report.sizes.insert("signature_secret_key".into(), secret_len);
        let restored = hooks.persist("mls-rs/A1", &bytes).await?;
        let storage = SpikeStorage::import(&group_id, &restored)?;
        let client = make_client(
            a1.identity.clone(),
            a1.secret.clone(),
            dir.clone(),
            storage.clone(),
            a1.psks.clone(),
            true,
            None,
        );
        let group = client.load_group(&group_id).await.map_err(s)?;
        a1.client = client;
        a1.storage = storage;
        a1.group = Some(group);
        let out = g(&mut a1)?.commit(vec![]).await.map_err(s)?;
        g(&mut a1)?.apply_pending_commit().await.map_err(s)?;
        deliver(hooks, report, &out.commit_message, &mut [&mut a2, &mut b1]).await?;
        let r = check_agreement(report, project_id, &[&a1, &a2, &b1]).await;
        report.step("state persisted, reloaded, commits again", r.map(|d| format!("{} B state; {d}", bytes.len())));
    }

    // 9. External-commit rejoin of A2 after its storage was wiped ----------
    {
        let old_index = g(&mut a2)?.current_member_index();
        let gi = g(&mut a1)?.group_info_message_allowing_ext_commit(true).await.map_err(s)?;
        // Wiped browser: new device key, re-certified by A's identity key.
        let mut a2b = device!("A", "A2", dir, true, true);
        let t = hooks.now();
        let (group, commit) = a2b
            .client
            .external_commit_builder()
            .map_err(s)?
            .with_removal(old_index)
            .build(gi)
            .await
            .map_err(s)?;
        report.external_commit_ms.push(hooks.now() - t);
        a2b.group = Some(group);
        deliver(hooks, report, &commit, &mut [&mut a1, &mut b1]).await?;
        a2 = a2b;
        let r = check_agreement(report, project_id, &[&a1, &a2, &b1]).await;
        report.step("external-commit rejoin of wiped A2", r);
    }

    // 10. Remove one of A's devices ----------------------------------------
    {
        let idx = g(&mut a2)?.current_member_index();
        let out = g(&mut a1)?.commit_builder().remove_member(idx).map_err(s)?.build().await.map_err(s)?;
        g(&mut a1)?.apply_pending_commit().await.map_err(s)?;
        deliver(hooks, report, &out.commit_message, &mut [&mut b1]).await?;
        // The removed device learns it was removed and cannot follow.
        let removed = g(&mut a2)?.process_incoming_message(out.commit_message).await;
        let next = g(&mut a1)?.commit(vec![]).await.map_err(s)?;
        g(&mut a1)?.apply_pending_commit().await.map_err(s)?;
        deliver(hooks, report, &next.commit_message, &mut [&mut b1]).await?;
        let follow = g(&mut a2)?.process_incoming_message(next.commit_message).await;
        let r = check_agreement(report, project_id, &[&a1, &b1]).await.and_then(|d| {
            if follow.is_ok() {
                Err("removed device processed a later commit".into())
            } else {
                Ok(format!("removal seen by A2: {}; {d}", removed.is_ok()))
            }
        });
        report.step("remove A2", r);
    }

    // 11. B leaves with SelfRemove, committed by A1 -----------------------
    {
        let proposal = g(&mut b1)?.propose_self_remove(vec![]).await.map_err(s)?;
        deliver(hooks, report, &proposal, &mut [&mut a1]).await?;
        let out = g(&mut a1)?.commit(vec![]).await.map_err(s)?;
        g(&mut a1)?.apply_pending_commit().await.map_err(s)?;
        let b_seen = g(&mut b1)?.process_incoming_message(out.commit_message).await;
        let members = g(&mut a1)?.roster().members().len();
        let r = if members == 1 {
            check_agreement(report, project_id, &[&a1])
                .await
                .map(|d| format!("SelfRemove committed; B1 processed: {}; {d}", b_seen.is_ok()))
        } else {
            Err(format!("{members} members remain"))
        };
        report.step("B self-removal (SelfRemove)", r);
    }

    // Final state sizes.
    g(&mut a1)?.write_to_storage().await.map_err(s)?;
    let bytes = a1.storage.export(&group_id).ok_or("nothing stored")?;
    report.sizes.insert("state_a1_1_member".into(), bytes.len());
    let _ = (&a1.name, &a1.user);
    Ok(())
}

// ---------------------------------------------------------------------------
// Rejoin scenario (ADR-024 review: external Commit needs an unrevoked
// credential, a listed identity, and a rejoin PSK later than the user's
// newest revocation and role change and inside a retention window).

const WINDOW: u64 = 4;

/// Every listed device derives and stores this epoch's rejoin PSK.
async fn record_psks<C: MlsConfig>(project_id: &[u8], devices: &mut [&mut Device<C>]) -> R<()> {
    for d in devices.iter_mut() {
        let group = d.group.as_ref().ok_or("missing group")?;
        let epoch = group.current_epoch();
        let secret = group
            .export_secret(REJOIN_LABEL, project_id, 32)
            .await
            .map_err(s)?
            .to_vec();
        d.psks.insert(epoch, secret.clone(), WINDOW);
        d.saved.push((epoch, secret));
    }
    Ok(())
}

fn saved_psk<C: MlsConfig>(d: &Device<C>, epoch: u64) -> R<Vec<u8>> {
    d.saved
        .iter()
        .find(|(e, _)| *e == epoch)
        .map(|(_, s)| s.clone())
        .ok_or_else(|| format!("{} holds no PSK for epoch {epoch}", d.name))
}

/// Commit with no proposals, deliver it, record PSKs.
async fn tick<C: MlsConfig>(
    hooks: &Hooks,
    report: &mut Report,
    project_id: &[u8],
    committer: &mut Device<C>,
    others: &mut [&mut Device<C>],
) -> R<()> {
    let out = g(committer)?.commit(vec![]).await.map_err(s)?;
    g(committer)?.apply_pending_commit().await.map_err(s)?;
    deliver(hooks, report, &out.commit_message, others).await?;
    record_psks(project_id, &mut [committer]).await?;
    record_psks(project_id, others).await
}

/// A device outside the group (lax send-side policy, so receivers decide)
/// tries to rejoin with the rejoin PSK of `psk_epoch`. Returns the receiver's
/// error, or the external commit if every receiver accepted it.
async fn try_rejoin<C: MlsConfig, J: MlsConfig>(
    hooks: &Hooks,
    report: &mut Report,
    joiner: &mut Device<J>,
    psk_epoch: u64,
    psk: Vec<u8>,
    group_info: MlsMessage,
    receivers: &mut [&mut Device<C>],
) -> R<Result<(), String>> {
    joiner.psks.insert(psk_epoch, psk, u64::MAX);
    let built = joiner
        .client
        .external_commit_builder()
        .map_err(s)?
        .with_external_psk(rejoin_psk_id(psk_epoch))
        .build(group_info)
        .await;
    let (group, commit) = match built {
        Ok(x) => x,
        Err(e) => return Ok(Err(format!("joiner could not build: {}", short(&e)))),
    };
    for r in receivers.iter_mut() {
        if let Err(e) = g(r)?.process_incoming_message(commit.clone()).await {
            return Ok(Err(format!("{} rejected: {}", r.name, short(&e))));
        }
    }
    let _ = report;
    let _ = hooks;
    joiner.group = Some(group);
    Ok(Ok(()))
}

fn expect_rejected(result: R<Result<(), String>>, must_contain: &str, must_not: &[&str]) -> R<String> {
    match result? {
        Ok(()) => Err("rejoin was accepted".into()),
        Err(e) if e.contains(must_contain) && must_not.iter().all(|m| !e.contains(m)) => Ok(e),
        Err(e) => Err(format!("rejected for the wrong reason: {e}")),
    }
}

#[wasm_bindgen]
pub async fn run_rejoin_scenario(project_id: String, hooks: JsValue) -> Result<String, JsValue> {
    let hooks = Hooks { obj: hooks };
    let mut report = Report {
        library: if cfg!(feature = "rustcrypto") { "mls-rs+rustcrypto" } else { "mls-rs+webcrypto" },
        version: "0.56.0",
        crypto: CRYPTO,
        cipher_suite: 2,
        ..Default::default()
    };
    if let Err(e) = rejoin_scenario(&hooks, &mut report, project_id.as_bytes()).await {
        report.step("aborted", Err(e));
    }
    serde_json::to_string(&report).map_err(|e| JsValue::from_str(&e.to_string()))
}

fn roles_since(entries: &[(&str, Role, u64)]) -> R<ExtensionList> {
    let mut list = ExtensionList::new();
    list.set_from(RolesExtension {
        users: entries
            .iter()
            .map(|(u, r, since)| UserEntry { user_id: u.as_bytes().to_vec(), role: *r, since: *since })
            .collect(),
    })
    .map_err(s)?;
    Ok(list)
}

async fn rejoin_scenario(hooks: &Hooks, report: &mut Report, project_id: &[u8]) -> R<()> {
    let dir = Directory::default();
    let w = Some(WINDOW);

    // R1. A wiped sole member rejoins from its saved PSK. -------------------
    {
        let solo_id = [b"solo:".as_slice(), project_id].concat();
        let mut s1 = device!("A", "S1", dir, true, true, w);
        s1.group = Some(
            s1.client
                .create_group_with_id(solo_id, roles_since(&[("A", Role::Owner, 0)])?, Default::default(), None)
                .await
                .map_err(s)?,
        );
        let out = g(&mut s1)?.commit(vec![]).await.map_err(s)?;
        g(&mut s1)?.apply_pending_commit().await.map_err(s)?;
        let _ = out;
        record_psks(project_id, &mut [&mut s1]).await?;
        let epoch = g(&mut s1)?.current_epoch();
        let old_index = g(&mut s1)?.current_member_index();
        let gi = g(&mut s1)?.group_info_message_allowing_ext_commit(true).await.map_err(s)?;
        // The saved PSK survives the wipe only through account-key-wrapped
        // storage; the spike seals it through the IndexedDB hook.
        let psk = hooks.persist("mls-rs/rejoin-psk", &saved_psk(&s1, epoch)?).await?;
        drop(s1);
        let mut s2 = device!("A", "S1", dir, true, true, w);
        s2.psks.insert(epoch, psk, WINDOW);
        let built = s2
            .client
            .external_commit_builder()
            .map_err(s)?
            .with_removal(old_index)
            .with_external_psk(rejoin_psk_id(epoch))
            .build(gi)
            .await;
        let r = match built {
            Err(e) => Err(format!("sole-member rejoin failed: {}", short(&e))),
            Ok((group, _)) => {
                s2.group = Some(group);
                let members = g(&mut s2)?.roster().members().len();
                let out = g(&mut s2)?.commit(vec![]).await.map_err(s)?;
                g(&mut s2)?.apply_pending_commit().await.map_err(s)?;
                let _ = out;
                Ok(format!(
                    "rejoined with PSK of epoch {epoch}; {members} member(s); now epoch {}",
                    g(&mut s2)?.current_epoch()
                ))
            }
        };
        report.step("rejoin: wiped sole member", r);
    }

    // Shared group: A1 (owner), A2, A3, B1 (editor). -----------------------
    let group_id = [b"project:".as_slice(), project_id].concat();
    let mut a1 = device!("A", "A1", dir, true, true, w);
    let mut a2 = device!("A", "A2", dir, true, true, w);
    let mut a3 = device!("A", "A3", dir, true, true, w);
    let mut b1 = device!("B", "B1", dir, true, true, w);
    a1.group = Some(
        a1.client
            .create_group_with_id(group_id.clone(), roles_since(&[("A", Role::Owner, 0)])?, Default::default(), None)
            .await
            .map_err(s)?,
    );
    let mut builder = g(&mut a1)?.commit_builder();
    for d in [&a2, &a3, &b1] {
        let kp = d
            .client
            .generate_key_package_message(Default::default(), Default::default(), None)
            .await
            .map_err(s)?;
        builder = builder.add_member(kp).map_err(s)?;
    }
    let out = builder
        .set_group_context_ext(roles_since(&[("A", Role::Owner, 0), ("B", Role::Editor, 1)])?)
        .map_err(s)?
        .build()
        .await
        .map_err(s)?;
    g(&mut a1)?.apply_pending_commit().await.map_err(s)?;
    for d in [&mut a2, &mut a3, &mut b1] {
        d.group = Some(d.client.join_group(None, &out.welcome_messages[0], None).await.map_err(s)?.0);
    }
    record_psks(project_id, &mut [&mut a1, &mut a2, &mut a3, &mut b1]).await?; // epoch 1
    tick(hooks, report, project_id, &mut a1, &mut [&mut a2, &mut a3, &mut b1]).await?; // 2

    // R0. Can an external joiner carry a resumption PSK at all? mls-rs's
    // ExternalCommitBuilder only offers `with_external_psk`, and the joiner's
    // key schedule starts with an empty resumption secret, so it cannot.
    report.step(
        "library: resumption PSK in an external Commit",
        Ok("not possible: ExternalCommitBuilder takes only external PSK ids".into()),
    );

    // A1 removes A2 and A revokes A2's key in the device list (epoch 3).
    let idx = g(&mut a2)?.current_member_index();
    let out = g(&mut a1)?.commit_builder().remove_member(idx).map_err(s)?.build().await.map_err(s)?;
    g(&mut a1)?.apply_pending_commit().await.map_err(s)?;
    deliver(hooks, report, &out.commit_message, &mut [&mut a3, &mut b1]).await?;
    let revoked_at = g(&mut a1)?.current_epoch();
    dir.revoke(b"A", &a2.identity.signature_key, revoked_at);
    record_psks(project_id, &mut [&mut a1, &mut a3, &mut b1]).await?;
    tick(hooks, report, project_id, &mut a1, &mut [&mut a3, &mut b1]).await?; // 4
    tick(hooks, report, project_id, &mut a3, &mut [&mut a1, &mut b1]).await?; // 5

    // R2. Revoked device, fresh PSK: rejected for revocation only.
    {
        let now = g(&mut a1)?.current_epoch();
        let gi = g(&mut a1)?.group_info_message_allowing_ext_commit(true).await.map_err(s)?;
        let mut a2x = device!("A", "A2", dir, false, false, w);
        // Same certified (now revoked) key as before its removal.
        a2x.client = make_client(
            a2.identity.clone(),
            a2.secret.clone(),
            dir.clone(),
            SpikeStorage::default(),
            a2x.psks.clone(),
            false,
            w,
        );
        let psk = saved_psk(&a1, now)?; // assume it obtained a current PSK
        let r = try_rejoin(hooks, report, &mut a2x, now, psk, gi, &mut [&mut a1, &mut b1]).await;
        let r = expect_rejected(r, "revoked", &["window", "PSK epoch"]);
        report.step("rejoin refused: revoked device with a fresh PSK", r);
    }

    // A1 removes A3 without revoking it (epoch 6).
    let idx = g(&mut a3)?.current_member_index();
    let out = g(&mut a1)?.commit_builder().remove_member(idx).map_err(s)?.build().await.map_err(s)?;
    g(&mut a1)?.apply_pending_commit().await.map_err(s)?;
    deliver(hooks, report, &out.commit_message, &mut [&mut b1]).await?;
    let _ = g(&mut a3)?.process_incoming_message(out.commit_message).await;
    record_psks(project_id, &mut [&mut a1, &mut b1]).await?;

    // R3a. Unrevoked removed device, PSK from before A's newest revocation.
    {
        let gi = g(&mut a1)?.group_info_message_allowing_ext_commit(true).await.map_err(s)?;
        let old = revoked_at - 1;
        let mut a3x = rejoiner!(a3, dir, w);
        let r = try_rejoin(hooks, report, &mut a3x, old, saved_psk(&a3, old)?, gi, &mut [&mut a1, &mut b1]).await;
        let r = expect_rejected(r, &format!("before newest revocation {revoked_at}"), &["revoked;", "window"]);
        report.step("rejoin refused: PSK older than the user's newest revocation", r);
    }

    // R3b. Same device, PSK after the revocation and inside the window: accepted.
    {
        let now = g(&mut a1)?.current_epoch();
        let gi = g(&mut a1)?.group_info_message_allowing_ext_commit(true).await.map_err(s)?;
        let newest = a3.saved.last().ok_or("no saved psk")?.0;
        let mut a3x = rejoiner!(a3, dir, w);
        let t = hooks.now();
        let r = try_rejoin(hooks, report, &mut a3x, newest, saved_psk(&a3, newest)?, gi, &mut [&mut a1, &mut b1]).await?;
        report.external_commit_ms.push(hooks.now() - t);
        let r = match r {
            Ok(()) => {
                a3 = a3x;
                record_psks(project_id, &mut [&mut a1, &mut a3, &mut b1]).await?;
                check_agreement(report, project_id, &[&a1, &a3, &b1])
                    .await
                    .map(|d| format!("PSK of epoch {newest} at epoch {now}; {d}"))
            }
            Err(e) => Err(e),
        };
        report.step("rejoin accepted: unrevoked device, PSK inside the window", r);
    }

    // Remove A3 again, then advance past the window.
    let idx = g(&mut a3)?.current_member_index();
    let out = g(&mut a1)?.commit_builder().remove_member(idx).map_err(s)?.build().await.map_err(s)?;
    g(&mut a1)?.apply_pending_commit().await.map_err(s)?;
    deliver(hooks, report, &out.commit_message, &mut [&mut b1]).await?;
    let _ = g(&mut a3)?.process_incoming_message(out.commit_message).await;
    record_psks(project_id, &mut [&mut a1, &mut b1]).await?;
    let newest = a3.saved.last().ok_or("no saved psk")?.0;
    while g(&mut a1)?.current_epoch() <= newest + WINDOW {
        tick(hooks, report, project_id, &mut a1, &mut [&mut b1]).await?;
    }

    // R3c. PSK after the revocation but outside the retention window.
    {
        let gi = g(&mut a1)?.group_info_message_allowing_ext_commit(true).await.map_err(s)?;
        let mut a3x = rejoiner!(a3, dir, w);
        let r = try_rejoin(hooks, report, &mut a3x, newest, saved_psk(&a3, newest)?, gi, &mut [&mut a1, &mut b1]).await;
        let r = expect_rejected(r, "window", &["revoked", "revocation"]);
        report.step("rejoin refused: PSK outside the retention window", r);
    }

    // R4. B is downgraded to viewer and B1 removed in one Commit (devices
    // not revoked); B1 tries to come back with a PSK from before the change.
    {
        let idx = g(&mut b1)?.current_member_index();
        let changed = g(&mut a1)?.current_epoch() + 1;
        let out = g(&mut a1)?
            .commit_builder()
            .remove_member(idx)
            .map_err(s)?
            .set_group_context_ext(roles_since(&[("A", Role::Owner, 0), ("B", Role::Viewer, changed)])?)
            .map_err(s)?
            .build()
            .await
            .map_err(s)?;
        g(&mut a1)?.apply_pending_commit().await.map_err(s)?;
        let _ = g(&mut b1)?.process_incoming_message(out.commit_message).await;
        record_psks(project_id, &mut [&mut a1]).await?;
        let gi = g(&mut a1)?.group_info_message_allowing_ext_commit(true).await.map_err(s)?;
        let before = b1.saved.last().ok_or("no saved psk")?.0;
        let mut b1x = rejoiner!(b1, dir, w);
        let r = try_rejoin(hooks, report, &mut b1x, before, saved_psk(&b1, before)?, gi, &mut [&mut a1]).await;
        let r = expect_rejected(r, &format!("before role change {changed}"), &["revoked", "not listed", "window"]);
        report.step("rejoin refused: PSK from before the member's role change", r);
    }

    // R5. B is then dropped from the roles extension entirely; B1 tries again
    // with a PSK from before its removal.
    {
        tick(hooks, report, project_id, &mut a1, &mut []).await?;
        let out = g(&mut a1)?
            .commit_builder()
            .set_group_context_ext(roles_since(&[("A", Role::Owner, 0)])?)
            .map_err(s)?
            .build()
            .await
            .map_err(s)?;
        g(&mut a1)?.apply_pending_commit().await.map_err(s)?;
        let _ = out;
        record_psks(project_id, &mut [&mut a1]).await?;
        let gi = g(&mut a1)?.group_info_message_allowing_ext_commit(true).await.map_err(s)?;
        let before = b1.saved.last().ok_or("no saved psk")?.0;
        let mut b1x = rejoiner!(b1, dir, w);
        let r = try_rejoin(hooks, report, &mut b1x, before, saved_psk(&b1, before)?, gi, &mut [&mut a1]).await;
        let r = expect_rejected(r, "not listed in the roles extension", &["revoked"]);
        report.step("rejoin refused: removed member, PSK from before removal", r);
    }
    report.final_epoch = g(&mut a1)?.current_epoch();
    Ok(())
}

fn short(e: &MlsError) -> String {
    let text = format!("{e:?}");
    text.chars().take(160).collect()
}
