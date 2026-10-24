//! One device's membership in one project's MLS group: its per-project leaf
//! signing key, the group, and everything the policy and history archive
//! need, exportable as one blob for sealed storage.

use std::collections::BTreeMap;
use std::sync::atomic::Ordering;

use mls_rs::{
    client_builder::{
        BaseConfig, WithCryptoProvider, WithGroupStateStorage, WithIdentityProvider, WithKeyPackageRepo, WithMlsRules,
        WithPskStore,
    },
    extension::built_in::RatchetTreeExt,
    group::{proposal::Proposal, CommitEffect, CommitMessageDescription, ContentType, ReceivedMessage},
    mls_rules::ProposalSource,
    storage_provider::in_memory::InMemoryKeyPackageStorage,
    CipherSuiteProvider, Client, CryptoProvider, ExtensionList, Group, MlsMessage, MlsMessageDescription,
};
use mls_rs_codec::{MlsDecode, MlsEncode, MlsSize};
use mls_rs_core::{
    crypto::{SignaturePublicKey, SignatureSecretKey},
    group::ProposalType,
    identity::SigningIdentity,
    key_package::KeyPackageData,
};
use mls_rs_crypto_rustcrypto::RustCryptoProvider;
use serde::Serialize;

use crate::error::{Error, Res};
use crate::history::verify_history;
use crate::model::*;
use crate::policy::{PolicyState, ProjectIdentity, ProjectRules};
use crate::storage::{GroupStore, PskStore, StoredEpoch, StoredGroup};

pub type ProjectConfig = WithIdentityProvider<
    ProjectIdentity,
    WithMlsRules<
        ProjectRules,
        WithCryptoProvider<
            RustCryptoProvider,
            WithGroupStateStorage<
                GroupStore,
                WithPskStore<PskStore, WithKeyPackageRepo<InMemoryKeyPackageStorage, BaseConfig>>,
            >,
        >,
    >,
>;

// Version 1 could persist removal records trusted from a single inviter.
const STATE_VERSION: u8 = 2;
pub const EPOCH_RECORD_VERSION: u8 = 2;

fn cipher_suite() -> Res<impl CipherSuiteProvider> {
    RustCryptoProvider::with_enabled_cipher_suites(vec![SUITE])
        .cipher_suite_provider(SUITE)
        .ok_or_else(|| Error::state("cipher suite 0x0002 is not supported"))
}

fn h(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

// ---------------------------------------------------------------------------
// Results, serialized as JSON for the TypeScript wrapper (bytes in hex).

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LeafInfo {
    pub index: u32,
    pub user_id: String,
    pub device_id: String,
    pub signature_key: String,
    pub certification: String,
}

fn leaf_info(index: u32, identity: &SigningIdentity) -> Option<LeafInfo> {
    let credential = DeviceCredential::from_identity(identity).ok()?;
    Some(LeafInfo {
        index,
        user_id: display_id(&credential.user_id),
        device_id: display_id(&credential.device_id),
        signature_key: h(identity.signature_key.as_bytes()),
        certification: h(&credential.certification),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleInfo {
    pub user_id: String,
    pub role: &'static str,
    pub since: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RolesInfo {
    pub rejoin_window: u32,
    pub users: Vec<RoleInfo>,
}

fn roles_info(roles: &ProjectRoles) -> RolesInfo {
    RolesInfo {
        rejoin_window: roles.rejoin_window,
        users: roles
            .users
            .iter()
            .map(|u| RoleInfo {
                user_id: display_id(&u.user_id),
                role: u.role.as_str(),
                since: u.since,
            })
            .collect(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedLeaf {
    pub user_id: String,
    pub device_id: String,
    pub signature_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpochChange {
    /// The new epoch, or the epoch this member was removed from.
    pub epoch: u64,
    /// True when this Commit removed this member's own leaf.
    pub removed_self: bool,
    pub removed: Vec<RemovedLeaf>,
    pub added: Vec<LeafInfo>,
    pub roles_changed: bool,
    /// History-archive record for the new epoch (hex), absent for a Welcome
    /// join and for a member that was removed.
    pub epoch_record: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingCommit {
    pub commit: String,
    pub welcome: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Processed {
    /// `proposal` or `commit`.
    pub kind: &'static str,
    pub proposal_type: Option<&'static str>,
    pub sender: Option<u32>,
    pub change: Option<EpochChange>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RejoinResult {
    pub commit: String,
    pub change: EpochChange,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInfoSummary {
    pub epoch: u64,
    pub project_matches: bool,
    pub members: Vec<LeafInfo>,
    pub roles: Option<RolesInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub user_id: String,
    pub device_id: String,
    pub signature_key: String,
    pub certified: bool,
    pub in_group: bool,
    pub removed: bool,
    pub epoch: Option<u64>,
    pub own_index: Option<u32>,
    pub pending_commit: bool,
    pub pending_rejoin: bool,
    pub members: Vec<LeafInfo>,
    pub roles: Option<RolesInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RejoinPsk {
    pub epoch: u64,
    pub secret: String,
}

// ---------------------------------------------------------------------------
// Commit requests

#[derive(serde::Deserialize, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommitSpec {
    #[serde(default)]
    pub remove: Vec<u32>,
    #[serde(default)]
    pub set_roles: Vec<RoleRequest>,
    #[serde(default)]
    pub drop_users: Vec<String>,
    #[serde(default)]
    pub rejoin_window: Option<u32>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RoleRequest {
    pub user_id: String,
    pub role: String,
}

// ---------------------------------------------------------------------------
// Stored form

#[derive(Clone, MlsSize, MlsEncode, MlsDecode)]
struct StoredKeyPackage {
    id: Vec<u8>,
    data: KeyPackageData,
}

#[derive(Clone, MlsSize, MlsEncode, MlsDecode)]
struct StoredProposal {
    reference: Vec<u8>,
    message: Vec<u8>,
}

#[derive(Clone, MlsSize, MlsEncode, MlsDecode)]
struct StoredLeaf {
    index: u32,
    identity: SigningIdentity,
}

#[derive(Clone, MlsSize, MlsEncode, MlsDecode)]
struct StoredPending {
    commit: Vec<u8>,
    roster: Vec<StoredLeaf>,
}

#[derive(MlsSize, MlsEncode, MlsDecode)]
struct StoredSession {
    version: u8,
    project_id: Vec<u8>,
    user_id: Vec<u8>,
    device_id: Vec<u8>,
    signer: SignatureSecretKey,
    public_key: SignaturePublicKey,
    certification: Option<Vec<u8>>,
    group: Option<StoredGroup>,
    key_packages: Vec<StoredKeyPackage>,
    psks: Vec<StoredEpoch>,
    removals: LeafRemovals,
    proposals: Vec<StoredProposal>,
    pending: Option<StoredPending>,
    removed: bool,
    /// The session as it was before an external Commit the room has not
    /// accepted yet.
    rejoin_backup: Option<Vec<u8>>,
}

/// One epoch of the history archive (ADR-024, "Historical authority"): the
/// new GroupContext, the public ratchet tree, the Commit that created it and
/// every proposal that Commit applied by reference. The app encrypts it under
/// that epoch's exported key.
#[derive(MlsSize, MlsEncode, MlsDecode)]
pub struct EpochRecordV2 {
    pub version: u8,
    pub epoch: u64,
    pub group_context: Vec<u8>,
    pub ratchet_tree: Vec<u8>,
    /// Empty for the group's first epoch.
    pub commit: Vec<u8>,
    pub proposals: Vec<Vec<u8>>,
    /// Signed GroupInfo for epoch zero, to bootstrap public transcript replay.
    /// Empty in later records; their Commits supply the confirmation tags.
    pub group_info: Vec<u8>,
}

// ---------------------------------------------------------------------------

pub struct Session {
    project_id: Vec<u8>,
    user_id: Vec<u8>,
    device_id: Vec<u8>,
    signer: SignatureSecretKey,
    public_key: SignaturePublicKey,
    certification: Option<Vec<u8>>,
    client: Option<Client<ProjectConfig>>,
    group: Option<Group<ProjectConfig>>,
    groups: GroupStore,
    psks: PskStore,
    key_packages: InMemoryKeyPackageStorage,
    pub policy: PolicyState,
    /// Proposal messages received or sent this epoch, by proposal reference,
    /// so a Commit's referenced proposals can be archived.
    proposals: BTreeMap<Vec<u8>, Vec<u8>>,
    pending: Option<StoredPending>,
    removed: bool,
    rejoin_backup: Option<Vec<u8>>,
}

fn check_id(label: &str, value: &[u8]) -> Res<()> {
    if value.is_empty() || value.len() > MAX_ID_BYTES {
        return Err(Error::input(format!("{label} must be 1..={MAX_ID_BYTES} bytes")));
    }
    Ok(())
}

impl Session {
    pub fn generate(project_id: &[u8], user_id: &[u8], device_id: &[u8]) -> Res<Session> {
        check_id("project id", project_id)?;
        check_id("user id", user_id)?;
        check_id("device id", device_id)?;
        let (signer, public_key) = cipher_suite()?
            .signature_key_generate()
            .map_err(|e| Error::state(format!("{e:?}")))?;
        Ok(Session {
            project_id: project_id.to_vec(),
            user_id: user_id.to_vec(),
            device_id: device_id.to_vec(),
            signer,
            public_key,
            certification: None,
            client: None,
            group: None,
            groups: GroupStore::default(),
            psks: PskStore::default(),
            key_packages: InMemoryKeyPackageStorage::default(),
            policy: PolicyState::default(),
            proposals: BTreeMap::new(),
            pending: None,
            removed: false,
            rejoin_backup: None,
        })
    }

    pub fn signature_key(&self) -> Vec<u8> {
        self.public_key.to_vec()
    }

    pub fn certification_payload(&self) -> Res<Vec<u8>> {
        certification_payload(
            &self.project_id,
            &self.user_id,
            &self.device_id,
            self.public_key.as_bytes(),
        )
    }

    fn signing_identity(&self) -> Res<SigningIdentity> {
        let certification = self
            .certification
            .clone()
            .ok_or_else(|| Error::state("the leaf is not certified yet"))?;
        let credential = DeviceCredential {
            user_id: self.user_id.clone(),
            device_id: self.device_id.clone(),
            certification,
        };
        Ok(SigningIdentity::new(
            credential.to_credential()?,
            self.public_key.clone(),
        ))
    }

    fn build_client(&mut self) -> Res<()> {
        let identity = self.signing_identity()?;
        self.client = Some(
            Client::builder()
                .key_package_repo(self.key_packages.clone())
                .psk_store(self.psks.clone())
                .group_state_storage(self.groups.clone())
                .crypto_provider(RustCryptoProvider::with_enabled_cipher_suites(vec![SUITE]))
                .mls_rules(ProjectRules {
                    state: self.policy.clone(),
                })
                .identity_provider(ProjectIdentity {
                    state: self.policy.clone(),
                })
                .extension_type(ROLES_EXT)
                .custom_proposal_type(ProposalType::SELF_REMOVE)
                .signing_identity(identity, self.signer.clone(), SUITE)
                .build(),
        );
        Ok(())
    }

    pub fn certify(&mut self, certification: &[u8]) -> Res<()> {
        if self.certification.is_some() {
            return Err(Error::state("the leaf is already certified"));
        }
        if certification.is_empty() {
            return Err(Error::input("certification is empty"));
        }
        self.certification = Some(certification.to_vec());
        self.build_client()
    }

    fn client(&self) -> Res<&Client<ProjectConfig>> {
        self.client
            .as_ref()
            .ok_or_else(|| Error::state("the leaf is not certified yet"))
    }

    fn group(&self) -> Res<&Group<ProjectConfig>> {
        if self.removed {
            return Err(Error::state("this member was removed from the group"));
        }
        self.group
            .as_ref()
            .ok_or_else(|| Error::state("this session has no group"))
    }

    fn group_mut(&mut self) -> Res<&mut Group<ProjectConfig>> {
        if self.removed {
            return Err(Error::state("this member was removed from the group"));
        }
        self.group
            .as_mut()
            .ok_or_else(|| Error::state("this session has no group"))
    }

    fn require_no_group(&self) -> Res<()> {
        if self.group.is_some() || self.removed {
            return Err(Error::state("this session already has a group"));
        }
        Ok(())
    }

    fn roles(&self) -> Res<ProjectRoles> {
        ProjectRoles::from_extensions(&self.group()?.context().extensions).map_err(|r| Error::policy(vec![r]))
    }

    fn roster_snapshot(&self) -> Res<Vec<StoredLeaf>> {
        Ok(self
            .group()?
            .roster()
            .members()
            .into_iter()
            .map(|m| StoredLeaf {
                index: m.index,
                identity: m.signing_identity,
            })
            .collect())
    }

    // -- Group lifecycle ----------------------------------------------------

    pub fn create_group(&mut self, rejoin_window: u32) -> Res<EpochChange> {
        self.require_no_group()?;
        let roles = ProjectRoles {
            version: ROLES_VERSION,
            rejoin_window,
            users: vec![RoleEntry {
                user_id: self.user_id.clone(),
                role: Role::Owner,
                since: 0,
            }],
        };
        let shape = roles.check_shape();
        if !shape.is_empty() {
            return Err(Error::policy(shape));
        }
        let group = self.client()?.create_group_with_id(
            group_id(&self.project_id),
            roles.to_extensions()?,
            ExtensionList::new(),
            None,
        )?;
        self.group = Some(group);
        self.enter_epoch()?;
        let record = self.epoch_record(Vec::new(), Vec::new())?;
        self.write()?;
        Ok(EpochChange {
            epoch: self.group()?.current_epoch(),
            removed_self: false,
            removed: Vec::new(),
            added: self.status()?.members,
            roles_changed: true,
            epoch_record: Some(h(&record)),
        })
    }

    pub fn key_package(&self) -> Res<Vec<u8>> {
        let message = self
            .client()?
            .generate_key_package_message(ExtensionList::new(), ExtensionList::new(), None)?;
        message.to_bytes().map_err(Error::mls)
    }

    pub fn inspect_welcome(&self, welcome: &[u8]) -> Res<GroupInfoSummary> {
        let message = MlsMessage::from_bytes(welcome)?;
        let info = self.client()?.examine_welcome_message(&message)?;
        Ok(self.summarize_group_info(
            info.group_context().epoch,
            &info.group_context().group_id,
            info.extensions(),
            &info.group_context().extensions,
        ))
    }

    pub fn join(&mut self, welcome: &[u8], history: &[Vec<u8>]) -> Res<EpochChange> {
        self.require_no_group()?;
        let backup = self.export()?;
        match self.join_verified(welcome, history) {
            Ok(change) => Ok(change),
            Err(error) => {
                // join_group consumes a KeyPackage before application checks.
                self.restore_from(&backup)?;
                Err(error)
            }
        }
    }

    fn join_verified(&mut self, welcome: &[u8], history: &[Vec<u8>]) -> Res<EpochChange> {
        let message = MlsMessage::from_bytes(welcome)?;
        let (group, _) = self.client()?.join_group(None, &message, None)?;
        if group.group_id() != group_id(&self.project_id).as_slice() {
            self.groups.restore(None);
            return Err(Error::input("the Welcome is for a different project"));
        }
        let roles = ProjectRoles::from_extensions(&group.context().extensions).map_err(|r| Error::policy(vec![r]))?;
        let shape = roles.check_shape();
        if !shape.is_empty() {
            self.groups.restore(None);
            return Err(Error::policy(shape));
        }
        let records = verify_history(&self.project_id, group.context(), history)?;
        *self.policy.removals.lock().unwrap() = records;
        self.group = Some(group);
        self.enter_epoch()?;
        self.write()?;
        Ok(EpochChange {
            epoch: self.group()?.current_epoch(),
            removed_self: false,
            removed: Vec::new(),
            added: Vec::new(),
            roles_changed: false,
            epoch_record: None,
        })
    }

    /// Build a Commit. It includes every proposal received this epoch. The
    /// commit stays pending until the room accepts it ([`Self::confirm_commit`])
    /// or another Commit wins the epoch ([`Self::discard_commit`]).
    pub fn commit(&mut self, spec: CommitSpec, key_packages: Vec<Vec<u8>>) -> Res<PendingCommit> {
        self.settled()?;
        if self.group()?.has_pending_commit() {
            return Err(Error::state("a commit is already pending"));
        }
        let roles = self.roles()?;
        let next_epoch = self.group()?.current_epoch() + 1;

        let mut next = roles.clone();
        let mut dropped: Vec<Vec<u8>> = Vec::new();
        for user in &spec.drop_users {
            let user = user.as_bytes().to_vec();
            if next.entry(&user).is_none() {
                return Err(Error::input(format!("{} is not listed", display_id(&user))));
            }
            next.users.retain(|u| u.user_id != user);
            dropped.push(user);
        }
        for request in &spec.set_roles {
            let user_id = request.user_id.as_bytes().to_vec();
            check_id("user id", &user_id)?;
            let role = Role::parse(&request.role)?;
            let since = match roles.entry(&user_id) {
                Some(old) if old.role == role => old.since,
                _ => next_epoch,
            };
            next.users.retain(|u| u.user_id != user_id);
            next.users.push(RoleEntry { user_id, role, since });
        }
        next.users.sort_by(|a, b| a.user_id.cmp(&b.user_id));
        if let Some(window) = spec.rejoin_window {
            next.rejoin_window = window;
        }

        let mut remove = spec.remove.clone();
        for member in self.group()?.roster().members() {
            if let Ok(credential) = DeviceCredential::from_identity(&member.signing_identity) {
                if dropped.contains(&credential.user_id) && !remove.contains(&member.index) {
                    remove.push(member.index);
                }
            }
        }

        let roster = self.roster_snapshot()?;
        let group = self.group_mut()?;
        let mut builder = group.commit_builder();
        for key_package in key_packages {
            builder = builder.add_member(MlsMessage::from_bytes(&key_package)?)?;
        }
        for index in remove {
            builder = builder.remove_member(index)?;
        }
        if next != roles {
            builder = builder.set_group_context_ext(next.to_extensions()?)?;
        }
        let output = builder.build()?;
        let commit = output.commit_message().to_bytes()?;
        let welcome = output.welcome_messages().first().map(|w| w.to_bytes()).transpose()?;
        self.pending = Some(StoredPending {
            commit: commit.clone(),
            roster,
        });
        self.write()?;
        Ok(PendingCommit {
            commit: h(&commit),
            welcome: welcome.as_deref().map(h),
        })
    }

    pub fn confirm_commit(&mut self) -> Res<EpochChange> {
        self.settled()?;
        let pending = self
            .pending
            .clone()
            .ok_or_else(|| Error::state("no commit is pending"))?;
        let description = self.group_mut()?.apply_pending_commit()?;
        self.pending = None;
        let change = self.after_commit(&pending.roster, description, pending.commit)?;
        self.write()?;
        Ok(change)
    }

    pub fn discard_commit(&mut self) -> Res<()> {
        self.settled()?;
        self.group_mut()?.clear_pending_commit();
        self.pending = None;
        self.write()
    }

    /// An Add by reference, for another member to commit.
    pub fn propose_add(&mut self, key_package: &[u8]) -> Res<Vec<u8>> {
        self.settled()?;
        let key_package = MlsMessage::from_bytes(key_package)?;
        let message = self.group_mut()?.propose_add(key_package, Vec::new())?;
        self.remember_own_proposal(message)
    }

    pub fn propose_update(&mut self) -> Res<Vec<u8>> {
        self.settled()?;
        let message = self.group_mut()?.propose_update(Vec::new())?;
        self.remember_own_proposal(message)
    }

    pub fn propose_self_remove(&mut self) -> Res<Vec<u8>> {
        self.settled()?;
        let message = self.group_mut()?.propose_self_remove(Vec::new())?;
        self.remember_own_proposal(message)
    }

    fn remember_own_proposal(&mut self, message: MlsMessage) -> Res<Vec<u8>> {
        let bytes = message.to_bytes()?;
        let reference = message
            .into_proposal_reference(&cipher_suite()?)?
            .ok_or_else(|| Error::state("proposal is not a public message"))?;
        self.proposals.insert(reference, bytes.clone());
        self.write()?;
        Ok(bytes)
    }

    /// Process a handshake message from the room: a proposal or a Commit.
    pub fn process(&mut self, bytes: &[u8]) -> Res<Processed> {
        self.settled()?;
        let message = MlsMessage::from_bytes(bytes)?;
        let is_commit = matches!(
            message.description(),
            MlsMessageDescription::PublicProtocolMessage {
                content_type: ContentType::Commit,
                ..
            }
        );
        if is_commit && self.pending.is_some() {
            return Err(Error::state("confirm or discard the pending commit first"));
        }
        let roster = self.roster_snapshot()?;
        let received = self.group_mut()?.process_incoming_message(message)?;
        let processed = match received {
            ReceivedMessage::Proposal(description) => {
                self.proposals.insert(description.proposal_ref.to_vec(), bytes.to_vec());
                let sender = match description.sender {
                    mls_rs::group::ProposalSender::Member(index) => Some(index),
                    _ => None,
                };
                Processed {
                    kind: "proposal",
                    proposal_type: Some(proposal_name(&description.proposal)),
                    sender,
                    change: None,
                }
            }
            ReceivedMessage::Commit(description) => {
                let sender = Some(description.committer);
                let change = self.after_commit(&roster, description, bytes.to_vec())?;
                Processed {
                    kind: "commit",
                    proposal_type: None,
                    sender,
                    change: Some(change),
                }
            }
            _ => return Err(Error::input("only proposals and Commits are processed")),
        };
        self.write()?;
        Ok(processed)
    }

    /// A GroupInfo that lets a device of a listed member rejoin by external
    /// Commit. Removal records are derived from its verified epoch history.
    pub fn group_info(&self) -> Res<Vec<u8>> {
        self.settled()?;
        let message = self.group()?.group_info_message_allowing_ext_commit(true)?;
        Ok(message.to_bytes()?)
    }

    /// Read a GroupInfo's members and roles before rejoining. Unverified: the
    /// external Commit verifies the GroupInfo signature and tree.
    pub fn inspect_group_info(&self, bytes: &[u8]) -> Res<GroupInfoSummary> {
        let info = MlsMessage::from_bytes(bytes)?
            .into_group_info()
            .ok_or_else(|| Error::input("not a GroupInfo message"))?;
        Ok(self.summarize_group_info(
            info.group_context().epoch,
            &info.group_context().group_id,
            info.extensions(),
            &info.group_context().extensions,
        ))
    }

    fn summarize_group_info(
        &self,
        epoch: u64,
        group: &[u8],
        info_extensions: &ExtensionList,
        context_extensions: &ExtensionList,
    ) -> GroupInfoSummary {
        let members = info_extensions
            .get_as::<RatchetTreeExt>()
            .ok()
            .flatten()
            .map(|tree| {
                tree.tree_data
                    .roster()
                    .members()
                    .iter()
                    .filter_map(|m| leaf_info(m.index, &m.signing_identity))
                    .collect()
            })
            .unwrap_or_default();
        GroupInfoSummary {
            epoch,
            project_matches: group == group_id(&self.project_id).as_slice(),
            members,
            roles: ProjectRoles::from_extensions(context_extensions)
                .ok()
                .map(|r| roles_info(&r)),
        }
    }

    /// Rejoin by external Commit with a rejoin PSK, optionally replacing one
    /// stale leaf of this user in the same Commit.
    /// A session whose leaf was removed may rejoin; its old group is dropped.
    ///
    /// The new epoch stays provisional until the room accepts the external
    /// Commit ([`Self::confirm_rejoin`]); if another Commit wins the epoch,
    /// [`Self::discard_rejoin`] restores the session as it was. Any failure
    /// restores it too.
    pub fn rejoin(
        &mut self,
        group_info: &[u8],
        psk_epoch: u64,
        psk: &[u8],
        remove: Option<u32>,
        history: &[Vec<u8>],
    ) -> Res<RejoinResult> {
        if self.rejoin_backup.is_some() {
            return Err(Error::state("a rejoin is already pending"));
        }
        if self.group.is_some() && !self.removed {
            return Err(Error::state("this session already has a group"));
        }
        let backup = self.export()?;
        match self.rejoin_provisional(group_info, psk_epoch, psk, remove, history) {
            Ok(result) => {
                self.rejoin_backup = Some(backup);
                Ok(result)
            }
            Err(error) => {
                self.restore_from(&backup)?;
                Err(error)
            }
        }
    }

    pub fn confirm_rejoin(&mut self) -> Res<()> {
        self.rejoin_backup
            .take()
            .map(|_| ())
            .ok_or_else(|| Error::state("no rejoin is pending"))
    }

    pub fn discard_rejoin(&mut self) -> Res<()> {
        let backup = self
            .rejoin_backup
            .take()
            .ok_or_else(|| Error::state("no rejoin is pending"))?;
        self.restore_from(&backup)
    }

    /// Replace this session with an exported copy, keeping the injected
    /// verifier and the test flag.
    fn restore_from(&mut self, backup: &[u8]) -> Res<()> {
        let verifier = self.policy.directory.get();
        let skip = self.policy.skip_send_checks.load(Ordering::Relaxed);
        let restored = Session::import(backup, &self.project_id)?;
        restored.policy.directory.set(verifier);
        restored.set_skip_send_checks(skip);
        *self = restored;
        Ok(())
    }

    fn settled(&self) -> Res<()> {
        if self.rejoin_backup.is_some() {
            return Err(Error::state("confirm or discard the pending rejoin first"));
        }
        Ok(())
    }

    fn rejoin_provisional(
        &mut self,
        group_info: &[u8],
        psk_epoch: u64,
        psk: &[u8],
        remove: Option<u32>,
        history: &[Vec<u8>],
    ) -> Res<RejoinResult> {
        if self.removed {
            self.removed = false;
            self.group = None;
            self.groups.restore(None);
            self.proposals.clear();
            self.pending = None;
        }
        if psk.len() != 32 {
            return Err(Error::input("a rejoin PSK is 32 bytes"));
        }
        let message = MlsMessage::from_bytes(group_info)?;
        let info = message
            .clone()
            .into_group_info()
            .ok_or_else(|| Error::input("not a GroupInfo message"))?;
        if info.group_context().group_id != group_id(&self.project_id) {
            return Err(Error::input("the GroupInfo is for a different project"));
        }
        let prior: Vec<StoredLeaf> = info
            .extensions()
            .get_as::<RatchetTreeExt>()
            .ok()
            .flatten()
            .map(|tree| {
                tree.tree_data
                    .roster()
                    .members()
                    .into_iter()
                    .map(|m| StoredLeaf {
                        index: m.index,
                        identity: m.signing_identity,
                    })
                    .collect()
            })
            .unwrap_or_default();
        // Derive cutoffs from the transcript before applying this Commit's
        // policy. The outer transaction restores them on any failure.
        let records = verify_history(&self.project_id, info.group_context(), history)?;
        let records_before = self.policy.removals.lock().unwrap().clone();
        self.policy.removals.lock().unwrap().merge(&records);
        self.psks.restore(Vec::new());
        self.psks.insert(psk_epoch, psk.to_vec(), u64::MAX);
        let mut builder = self
            .client()?
            .external_commit_builder()?
            .with_external_psk(rejoin_psk_id(psk_epoch));
        if let Some(index) = remove {
            builder = builder.with_removal(index);
        }
        let built = builder.build(message);
        let (group, commit) = match built {
            Ok(ok) => ok,
            Err(e) => {
                self.psks.restore(Vec::new());
                self.groups.restore(None);
                *self.policy.removals.lock().unwrap() = records_before;
                return Err(e.into());
            }
        };
        self.group = Some(group);
        let mut removed = Vec::new();
        if let Some(index) = remove {
            if let Some(leaf) = prior.iter().find(|l| l.index == index) {
                removed.push(self.record_removal(&leaf.identity)?);
            }
        }
        // Drop the joining PSK; this member now derives its own.
        self.psks.restore(Vec::new());
        self.enter_epoch()?;
        let commit_bytes = commit.to_bytes()?;
        let record = self.epoch_record(commit_bytes.clone(), Vec::new())?;
        self.write()?;
        Ok(RejoinResult {
            commit: h(&commit_bytes),
            change: EpochChange {
                epoch: self.group()?.current_epoch(),
                removed_self: false,
                removed,
                added: Vec::new(),
                roles_changed: false,
                epoch_record: Some(h(&record)),
            },
        })
    }

    // -- Epoch bookkeeping --------------------------------------------------

    fn after_commit(
        &mut self,
        prior: &[StoredLeaf],
        description: CommitMessageDescription,
        commit: Vec<u8>,
    ) -> Res<EpochChange> {
        let (new_epoch, removed_self) = match description.effect {
            CommitEffect::NewEpoch(epoch) => (epoch, false),
            CommitEffect::Removed { new_epoch, .. } => (new_epoch, true),
            CommitEffect::ReInit(_) => return Err(Error::state("ReInit is not supported")),
        };
        let mut removed = Vec::new();
        let mut referenced = Vec::new();
        let mut roles_changed = false;
        let mut added_indexes = Vec::new();
        for info in &new_epoch.applied_proposals {
            let removed_index = match &info.proposal {
                Proposal::Remove(remove) => Some(remove.to_remove()),
                Proposal::SelfRemove(_) => match info.sender {
                    mls_rs::group::Sender::Member(index) => Some(index),
                    _ => None,
                },
                Proposal::GroupContextExtensions(_) => {
                    roles_changed = true;
                    None
                }
                Proposal::Add(add) => {
                    added_indexes.push(add.signing_identity().signature_key.clone());
                    None
                }
                _ => None,
            };
            if let Some(index) = removed_index {
                if let Some(leaf) = prior.iter().find(|l| l.index == index) {
                    removed.push(self.record_removal_at(&leaf.identity, new_epoch.epoch)?);
                }
            }
            if let ProposalSource::ByReference(reference) = &info.source {
                if let Some(message) = self.proposals.get(reference.as_ref()) {
                    referenced.push(message.clone());
                }
            }
        }
        self.proposals.clear();
        if removed_self {
            self.removed = true;
            self.group = None;
            return Ok(EpochChange {
                epoch: new_epoch.epoch,
                removed_self: true,
                removed,
                added: Vec::new(),
                roles_changed,
                epoch_record: None,
            });
        }
        self.enter_epoch()?;
        let added = self
            .group()?
            .roster()
            .members()
            .iter()
            .filter(|m| added_indexes.contains(&m.signing_identity.signature_key))
            .filter_map(|m| leaf_info(m.index, &m.signing_identity))
            .collect();
        let record = self.epoch_record(commit, referenced)?;
        Ok(EpochChange {
            epoch: self.group()?.current_epoch(),
            removed_self: false,
            removed,
            added,
            roles_changed,
            epoch_record: Some(h(&record)),
        })
    }

    fn record_removal(&mut self, identity: &SigningIdentity) -> Res<RemovedLeaf> {
        let epoch = self.group()?.current_epoch();
        self.record_removal_at(identity, epoch)
    }

    fn record_removal_at(&mut self, identity: &SigningIdentity, epoch: u64) -> Res<RemovedLeaf> {
        let credential = DeviceCredential::from_identity(identity).map_err(|r| Error::policy(vec![r]))?;
        let record = LeafRemoval {
            user_id: credential.user_id.clone(),
            device_id: credential.device_id.clone(),
            signature_key: identity.signature_key.to_vec(),
            epoch,
        };
        self.policy
            .removals
            .lock()
            .unwrap()
            .merge(&LeafRemovals { records: vec![record] });
        Ok(RemovedLeaf {
            user_id: display_id(&credential.user_id),
            device_id: display_id(&credential.device_id),
            signature_key: h(identity.signature_key.as_bytes()),
        })
    }

    /// Derive and keep this epoch's rejoin PSK, pruning outside the window.
    fn enter_epoch(&mut self) -> Res<()> {
        let window = u64::from(self.roles()?.rejoin_window);
        let group = self.group()?;
        let epoch = group.current_epoch();
        let secret = group.export_secret(REJOIN_PSK_LABEL, &self.project_id, 32)?.to_vec();
        self.psks.insert(epoch, secret, window);
        Ok(())
    }

    fn epoch_record(&self, commit: Vec<u8>, proposals: Vec<Vec<u8>>) -> Res<Vec<u8>> {
        let group = self.group()?;
        EpochRecordV2 {
            version: EPOCH_RECORD_VERSION,
            epoch: group.current_epoch(),
            group_context: group.context().mls_encode_to_vec().map_err(Error::codec)?,
            ratchet_tree: group.export_tree().to_bytes()?,
            commit,
            proposals,
            group_info: if group.current_epoch() == 0 {
                self.group_info()?
            } else {
                Vec::new()
            },
        }
        .mls_encode_to_vec()
        .map_err(Error::codec)
    }

    // -- Reads ----------------------------------------------------------------

    pub fn status(&self) -> Res<Status> {
        let (epoch, own_index, members, roles, pending) = match (&self.group, self.removed) {
            (Some(group), false) => (
                Some(group.current_epoch()),
                Some(group.current_member_index()),
                group
                    .roster()
                    .members()
                    .iter()
                    .filter_map(|m| leaf_info(m.index, &m.signing_identity))
                    .collect(),
                ProjectRoles::from_extensions(&group.context().extensions)
                    .ok()
                    .map(|r| roles_info(&r)),
                group.has_pending_commit(),
            ),
            _ => (None, None, Vec::new(), None, false),
        };
        Ok(Status {
            user_id: display_id(&self.user_id),
            device_id: display_id(&self.device_id),
            signature_key: h(self.public_key.as_bytes()),
            certified: self.certification.is_some(),
            in_group: self.group.is_some() && !self.removed,
            removed: self.removed,
            epoch,
            own_index,
            pending_commit: pending,
            pending_rejoin: self.rejoin_backup.is_some(),
            members,
            roles,
        })
    }

    /// The per-epoch project key: `MLS-Exporter("openzcad project key",
    /// project id, 32)`.
    pub fn project_key(&self) -> Res<Vec<u8>> {
        self.settled()?;
        Ok(self
            .group()?
            .export_secret(PROJECT_KEY_LABEL, &self.project_id, 32)?
            .to_vec())
    }

    pub fn epoch_authenticator(&self) -> Res<Vec<u8>> {
        self.settled()?;
        Ok(self.group()?.epoch_authenticator()?.to_vec())
    }

    pub fn rejoin_psk(&self) -> Res<RejoinPsk> {
        self.settled()?;
        let epoch = self.group()?.current_epoch();
        let secret = self
            .psks
            .get_epoch(epoch)
            .ok_or_else(|| Error::state("no rejoin PSK for this epoch"))?;
        Ok(RejoinPsk {
            epoch,
            secret: h(&secret),
        })
    }

    pub fn set_skip_send_checks(&self, skip: bool) {
        self.policy.skip_send_checks.store(skip, Ordering::Relaxed);
    }

    // -- State ------------------------------------------------------------------

    fn write(&mut self) -> Res<()> {
        if let (Some(group), false) = (self.group.as_mut(), self.removed) {
            group.write_to_storage()?;
        }
        Ok(())
    }

    pub fn export(&mut self) -> Res<Vec<u8>> {
        self.write()?;
        StoredSession {
            version: STATE_VERSION,
            project_id: self.project_id.clone(),
            user_id: self.user_id.clone(),
            device_id: self.device_id.clone(),
            signer: self.signer.clone(),
            public_key: self.public_key.clone(),
            certification: self.certification.clone(),
            group: if self.removed { None } else { self.groups.snapshot() },
            key_packages: self
                .key_packages
                .key_packages()
                .into_iter()
                .map(|(id, data)| StoredKeyPackage { id, data })
                .collect(),
            psks: self.psks.entries(),
            removals: self.policy.removals.lock().unwrap().clone(),
            proposals: self
                .proposals
                .iter()
                .map(|(reference, message)| StoredProposal {
                    reference: reference.clone(),
                    message: message.clone(),
                })
                .collect(),
            pending: self.pending.clone(),
            removed: self.removed,
            rejoin_backup: self.rejoin_backup.clone(),
        }
        .mls_encode_to_vec()
        .map_err(Error::codec)
    }

    pub fn import(bytes: &[u8], expected_project: &[u8]) -> Res<Session> {
        let mut input = bytes;
        let stored = StoredSession::mls_decode(&mut input).map_err(Error::codec)?;
        if !input.is_empty() {
            return Err(Error::state("trailing bytes after the session state"));
        }
        if stored.version != STATE_VERSION {
            return Err(Error::state(format!(
                "session state version {} is not {STATE_VERSION}",
                stored.version
            )));
        }
        if stored.project_id != expected_project {
            return Err(Error::state("the session state is for a different project"));
        }
        let mut session = Session {
            project_id: stored.project_id,
            user_id: stored.user_id,
            device_id: stored.device_id,
            signer: stored.signer,
            public_key: stored.public_key,
            certification: stored.certification,
            client: None,
            group: None,
            groups: GroupStore::default(),
            psks: PskStore::default(),
            key_packages: InMemoryKeyPackageStorage::default(),
            policy: PolicyState::default(),
            proposals: stored.proposals.into_iter().map(|p| (p.reference, p.message)).collect(),
            pending: stored.pending,
            removed: stored.removed,
            rejoin_backup: stored.rejoin_backup,
        };
        for kp in stored.key_packages {
            session.key_packages.insert(kp.id, kp.data);
        }
        session.psks.restore(stored.psks);
        *session.policy.removals.lock().unwrap() = stored.removals;
        let has_group = stored.group.is_some();
        session.groups.restore(stored.group);
        if session.certification.is_some() {
            session.build_client()?;
        }
        if has_group && !session.removed {
            let group = session.client()?.load_group(&group_id(&session.project_id))?;
            session.group = Some(group);
        }
        Ok(session)
    }
}

fn proposal_name(proposal: &Proposal) -> &'static str {
    match proposal {
        Proposal::Add(_) => "add",
        Proposal::Update(_) => "update",
        Proposal::Remove(_) => "remove",
        Proposal::Psk(_) => "psk",
        Proposal::ReInit(_) => "reinit",
        Proposal::ExternalInit(_) => "external-init",
        Proposal::GroupContextExtensions(_) => "group-context-extensions",
        Proposal::SelfRemove(_) => "self-remove",
        Proposal::Custom(_) => "custom",
        #[allow(unreachable_patterns)]
        _ => "other",
    }
}
