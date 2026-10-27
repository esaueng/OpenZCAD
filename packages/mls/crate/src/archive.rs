//! Authenticate removal history against the public MLS transcript, anchored
//! to the GroupContext the Welcome (or external join) actually authenticates.
//! Every Commit is also checked with ProjectIdentity and ProjectRules using
//! verified certifications and the per-device revocations effective in its
//! epoch. Later revocations do not retroactively invalidate an old Commit.
//! No archive state is installed until verification succeeds.
//!
//! Replay starts from an anchor GroupInfo: the project's initial GroupInfo
//! (epoch 0), or an owner-signed checkpoint (ADR-024, "Historical
//! authority": the owner's browser signs a checkpoint of the current
//! GroupContext and tree every few hundred epochs, so replay stays short).
//! A checkpoint is a GroupInfo of epoch K > 0, carrying the ratchet tree and
//! the signer's removal records, signed by a leaf whose identity the
//! checkpoint's own roles extension lists as owner and whose key an
//! unrevoked device of that identity certifies in the newest verified device
//! list. The transcript chain from it to the authenticated target binds its
//! GroupContext and tree; its removal records (epochs up to K) are trusted on
//! the owner's signature and must still agree exactly with the target's.

use std::sync::Arc;

use mls_rs::{
    external_client::{ExternalClient, ExternalReceivedMessage},
    group::{proposal::Proposal, CommitEffect, Sender},
    ExtensionList, MlsMessage,
};
use mls_rs_codec::{MlsDecode, MlsEncode};
use mls_rs_core::group::GroupContext;
use mls_rs_crypto_rustcrypto::RustCryptoProvider;
use serde::Serialize;

use crate::{
    directory::{CredentialStatus, DeviceListVerifier},
    error::{Error, Reason, Res},
    model::*,
    policy::{PolicyState, ProjectIdentity, ProjectRules},
    session::{leaf_info, roles_info, EpochRecordV1, LeafInfo, RolesInfo},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpochAuthority {
    pub epoch: u64,
    pub roles: RolesInfo,
    pub members: Vec<LeafInfo>,
    pub group_context: String,
    pub ratchet_tree: String,
}

struct ReplayResult {
    removals: LeafRemovals,
    authority: EpochAuthority,
}

fn check_roster(
    context: &GroupContext,
    members: &[mls_rs::group::Member],
    directory: &dyn DeviceListVerifier,
    owner: &[u8],
) -> Res<ProjectRoles> {
    let roles = ProjectRoles::from_extensions(&context.extensions).map_err(|r| Error::policy(vec![r]))?;
    if !roles.check_shape().is_empty()
        || roles.users.iter().any(|r| r.since > context.epoch)
        || roles
            .users
            .iter()
            .find(|r| r.role == Role::Owner)
            .map(|r| r.user_id.as_slice())
            != Some(owner)
    {
        return Err(Error::policy(vec![Reason::new(
            "roles-invalid",
            "historical roles change the trusted owner or name a future epoch",
        )]));
    }
    for member in members {
        let credential =
            DeviceCredential::from_identity(&member.signing_identity).map_err(|r| Error::policy(vec![r]))?;
        if roles.role(&credential.user_id).is_none()
            || directory
                .certified_epoch(
                    &credential.user_id,
                    &credential.device_id,
                    member.signing_identity.signature_key.as_bytes(),
                )
                .is_none_or(|at| at > context.epoch)
        {
            return Err(Error::policy(vec![Reason::new(
                "credential-unknown",
                "historical tree contains a leaf not certified for this epoch",
            )]));
        }
    }
    Ok(roles)
}

fn invalid(detail: &str) -> Error {
    Error::input(format!("removal archive: {detail}"))
}

/// Unverified roster hints, solely for verifying the embedded leaf
/// certifications before the complete policy replay. Never authority.
pub fn record_members(record: &EpochRecordV1) -> Res<Vec<LeafInfo>> {
    use mls_rs::extension::built_in::RatchetTreeExt;
    let mut input = record.ratchet_tree.as_slice();
    let tree = RatchetTreeExt::mls_decode(&mut input).map_err(Error::codec)?;
    if !input.is_empty() {
        return Err(invalid("trailing bytes after record tree"));
    }
    Ok(tree
        .tree_data
        .roster()
        .members()
        .iter()
        .filter_map(|m| leaf_info(m.index, &m.signing_identity))
        .collect())
}

fn message(bytes: &[u8]) -> Res<MlsMessage> {
    let mut input = bytes;
    let message = MlsMessage::mls_decode(&mut input).map_err(Error::codec)?;
    if !input.is_empty() {
        return Err(invalid("trailing bytes after an archived MLS message"));
    }
    Ok(message)
}

fn checkpoint_refused(detail: &str) -> Error {
    Error::policy(vec![Reason::new("checkpoint-invalid", format!("checkpoint {detail}"))])
}

/// The removal records an owner-signed checkpoint vouches for: those of its
/// GroupInfo, from a signer the checkpoint's roles list as owner and the
/// newest device list still certifies.
fn checkpoint_removals(
    anchor: &[u8],
    context: &GroupContext,
    roles: &ProjectRoles,
    members: &[mls_rs::group::Member],
    directory: &dyn DeviceListVerifier,
) -> Res<LeafRemovals> {
    let info = message(anchor)?
        .into_group_info()
        .ok_or_else(|| invalid("the anchor is not a GroupInfo"))?;
    let signer = members
        .iter()
        .find(|leaf| leaf.index == info.sender())
        .ok_or_else(|| invalid("checkpoint signer is not in its tree"))?;
    let credential = DeviceCredential::from_identity(&signer.signing_identity).map_err(|r| Error::policy(vec![r]))?;
    if roles.role(&credential.user_id) != Some(Role::Owner) {
        return Err(checkpoint_refused("is not signed by the owner its roles list"));
    }
    // A leaf key can sign a GroupInfo for any epoch it was in at any later
    // time, so a stolen, since-revoked owner device must not vouch for an
    // older epoch's removal records.
    if directory.credential_status(
        &credential.user_id,
        &credential.device_id,
        signer.signing_identity.signature_key.as_bytes(),
    ) != CredentialStatus::Certified
    {
        return Err(checkpoint_refused(
            "is signed by a leaf no unrevoked device of the owner certifies",
        ));
    }
    let carried = info
        .extensions()
        .get_as::<LeafRemovals>()
        .map_err(|_| invalid("malformed checkpoint removal extension"))?
        .ok_or_else(|| checkpoint_refused("carries no removal records"))?;
    if carried.records.iter().any(|r| r.epoch > context.epoch) {
        return Err(checkpoint_refused("carries removals from later epochs"));
    }
    let mut removals = LeafRemovals::default();
    removals.merge(&carried);
    Ok(removals)
}

/// Replay `records` (epochs anchor+1 through the target) from `anchor`: the
/// project's initial GroupInfo, or an owner-signed checkpoint (module docs).
pub fn replay(
    anchor: &[u8],
    records: &[Vec<u8>],
    target: &GroupContext,
    target_tree: &[u8],
    directory: Arc<dyn DeviceListVerifier>,
) -> Res<LeafRemovals> {
    let roles = ProjectRoles::from_extensions(&target.extensions).map_err(|r| Error::policy(vec![r]))?;
    let owner = roles
        .users
        .iter()
        .find(|r| r.role == Role::Owner)
        .ok_or_else(|| invalid("target has no owner"))?
        .user_id
        .clone();
    Ok(replay_authority(anchor, records, target, target_tree, directory, &owner)?.removals)
}

fn replay_authority(
    anchor: &[u8],
    records: &[Vec<u8>],
    target: &GroupContext,
    target_tree: &[u8],
    directory: Arc<dyn DeviceListVerifier>,
    owner: &[u8],
) -> Res<ReplayResult> {
    let info = message(anchor)?
        .into_group_info()
        .ok_or_else(|| invalid("anchor is not a GroupInfo"))?;
    let anchor_epoch = info.group_context().epoch;
    // Preserve a precise checkpoint refusal before general tree credential
    // validation. This preflight can only refuse; observe_group still verifies
    // its signature and tree before any state is accepted.
    if anchor_epoch > 0 {
        use mls_rs::extension::built_in::RatchetTreeExt;
        let tree = info
            .extensions()
            .get_as::<RatchetTreeExt>()
            .map_err(|_| invalid("malformed checkpoint tree"))?
            .ok_or_else(|| invalid("missing checkpoint tree"))?;
        let roles =
            ProjectRoles::from_extensions(&info.group_context().extensions).map_err(|r| Error::policy(vec![r]))?;
        checkpoint_removals(
            anchor,
            info.group_context(),
            &roles,
            &tree.tree_data.roster().members(),
            directory.as_ref(),
        )?;
    }
    let state = PolicyState::default();
    state.directory.set(directory.at_epoch(anchor_epoch));
    let client = ExternalClient::builder()
        .crypto_provider(RustCryptoProvider::with_enabled_cipher_suites(vec![SUITE]))
        .identity_provider(ProjectIdentity { state: state.clone() })
        .mls_rules(ProjectRules { state: state.clone() })
        .extension_type(ROLES_EXT)
        .custom_proposal_types([mls_rs_core::group::ProposalType::SELF_REMOVE])
        .build();
    let mut group = client.observe_group(message(anchor)?, None, None)?;
    let initial = group.group_context().clone();
    let roles = ProjectRoles::from_extensions(&initial.extensions).map_err(|r| Error::policy(vec![r]))?;
    let members = group.roster().members();
    check_roster(&initial, &members, directory.as_ref(), owner)?;
    if initial.group_id != target.group_id || !roles.check_shape().is_empty() {
        return Err(invalid("expected an anchor GroupInfo of this project's group"));
    }
    let mut removals = if initial.epoch == 0 {
        if !initial.confirmed_transcript_hash.is_empty()
            || roles.users.len() != 1
            || members.len() != 1
            || roles.role(
                &DeviceCredential::from_identity(&members[0].signing_identity)
                    .map_err(|r| Error::policy(vec![r]))?
                    .user_id,
            ) != Some(Role::Owner)
        {
            return Err(invalid("expected the project's initial owner GroupInfo"));
        }
        let credential =
            DeviceCredential::from_identity(&members[0].signing_identity).map_err(|r| Error::policy(vec![r]))?;
        if directory.at_epoch(0).credential_status(
            &credential.user_id,
            &credential.device_id,
            members[0].signing_identity.signature_key.as_bytes(),
        ) != CredentialStatus::Certified
        {
            return Err(invalid("initial owner was not certified in epoch zero"));
        }
        LeafRemovals::default()
    } else {
        checkpoint_removals(anchor, &initial, &roles, &members, directory.as_ref())?
    };
    *state.removals.lock().unwrap() = removals.clone();
    if target
        .epoch
        .checked_sub(initial.epoch)
        .is_none_or(|count| u64::try_from(records.len()).ok() != Some(count))
    {
        return Err(invalid(
            "expected every epoch after the anchor through the joining epoch",
        ));
    }
    for bytes in records {
        let mut input = bytes.as_slice();
        let record = EpochRecordV1::mls_decode(&mut input).map_err(Error::codec)?;
        if !input.is_empty() || record.version != 1 || record.epoch != group.group_context().epoch + 1 {
            return Err(invalid("invalid or nonconsecutive epoch record"));
        }
        let prior = group.roster().members();
        state.directory.set(directory.at_epoch(record.epoch));
        for proposal in record.proposals {
            if !matches!(
                group.process_incoming_message(message(&proposal)?)?,
                ExternalReceivedMessage::Proposal(_)
            ) {
                return Err(invalid("expected a public proposal"));
            }
        }
        let description = match group.process_incoming_message(message(&record.commit)?)? {
            ExternalReceivedMessage::Commit(description) => description,
            _ => return Err(invalid("expected a public Commit")),
        };
        let epoch = match description.effect {
            CommitEffect::NewEpoch(epoch) => epoch,
            _ => return Err(invalid("unsupported Commit effect")),
        };
        for info in epoch.applied_proposals {
            let index = match info.proposal {
                Proposal::Remove(remove) => Some(remove.to_remove()),
                Proposal::SelfRemove(_) => match info.sender {
                    Sender::Member(index) => Some(index),
                    _ => None,
                },
                _ => None,
            };
            if let Some(index) = index {
                let leaf = prior
                    .iter()
                    .find(|leaf| leaf.index == index)
                    .ok_or_else(|| invalid("removed leaf missing from prior tree"))?;
                let credential =
                    DeviceCredential::from_identity(&leaf.signing_identity).map_err(|r| Error::policy(vec![r]))?;
                removals.merge(&LeafRemovals {
                    records: vec![LeafRemoval {
                        user_id: credential.user_id,
                        device_id: credential.device_id,
                        signature_key: leaf.signing_identity.signature_key.to_vec(),
                        epoch: epoch.epoch,
                    }],
                });
            }
        }
        if group.group_context().mls_encode_to_vec().map_err(Error::codec)? != record.group_context
            || group.export_tree()? != record.ratchet_tree
        {
            return Err(invalid("record does not match the replayed transcript and tree"));
        }
        check_roster(
            group.group_context(),
            &group.roster().members(),
            directory.as_ref(),
            owner,
        )?;
        *state.removals.lock().unwrap() = removals.clone();
    }
    if group.group_context() != target || group.export_tree()? != target_tree {
        return Err(invalid("history does not reach the authenticated joining state"));
    }
    let roles = check_roster(target, &group.roster().members(), directory.as_ref(), owner)?;
    Ok(ReplayResult {
        removals,
        authority: EpochAuthority {
            epoch: target.epoch,
            roles: roles_info(&roles),
            members: group
                .roster()
                .members()
                .iter()
                .filter_map(|m| leaf_info(m.index, &m.signing_identity))
                .collect(),
            group_context: hex::encode(target.mls_encode_to_vec().map_err(Error::codec)?),
            ratchet_tree: hex::encode(target_tree),
        },
    })
}

/// The caller independently authenticates the anchor and owner before using
/// this result. No leaf key, live session or MLS epoch secret is required.
pub fn verify_epoch_authority(
    project_id: &[u8],
    anchor: &[u8],
    records: &[Vec<u8>],
    target_record: &[u8],
    owner: &[u8],
    directory: Arc<dyn DeviceListVerifier>,
) -> Res<EpochAuthority> {
    let mut input = target_record;
    let record = EpochRecordV1::mls_decode(&mut input).map_err(Error::codec)?;
    if !input.is_empty() || record.version != 1 {
        return Err(invalid("invalid target record"));
    }
    let mut context_bytes = record.group_context.as_slice();
    let target = GroupContext::mls_decode(&mut context_bytes).map_err(Error::codec)?;
    if !context_bytes.is_empty() || target.group_id != group_id(project_id) || target.epoch != record.epoch {
        return Err(invalid("target records another project or epoch"));
    }
    Ok(replay_authority(anchor, records, &target, &record.ratchet_tree, directory, owner)?.authority)
}

/// An independently accepted account state can vouch for its exact historical
/// prefix when a later revocation has no signed time. The complete prefix must
/// reach that context AND tree before any requested historical result escapes.
/// Unknown-time credentials remain refused beyond it, and ordinary joins never
/// call this path. Known signed cutoffs are enforced throughout.
pub fn verify_epoch_authority_bound(
    project_id: &[u8],
    anchor: &[u8],
    records: &[Vec<u8>],
    target_record: &[u8],
    owner: &[u8],
    directory: crate::directory::DeviceDirectory,
    authenticated_group_info: &[u8],
) -> Res<EpochAuthority> {
    if authenticated_group_info.is_empty() {
        return verify_epoch_authority(project_id, anchor, records, target_record, owner, Arc::new(directory));
    }
    use mls_rs::extension::built_in::RatchetTreeExt;
    let trusted = message(authenticated_group_info)?
        .into_group_info()
        .ok_or_else(|| invalid("authenticated endpoint is not a GroupInfo"))?;
    let start = message(anchor)?
        .into_group_info()
        .ok_or_else(|| invalid("anchor is not a GroupInfo"))?;
    let context = trusted.group_context();
    if context.group_id != group_id(project_id) {
        return Err(invalid("authenticated endpoint belongs to another project"));
    }
    let count = context
        .epoch
        .checked_sub(start.group_context().epoch)
        .and_then(|n| usize::try_from(n).ok())
        .filter(|n| *n <= records.len())
        .ok_or_else(|| invalid("authenticated endpoint is outside the archive"))?;
    let tree = trusted
        .extensions()
        .get_as::<RatchetTreeExt>()
        .map_err(|_| invalid("malformed authenticated endpoint tree"))?
        .ok_or_else(|| invalid("missing authenticated endpoint tree"))?
        .mls_encode_to_vec()
        .map_err(Error::codec)?;
    let directory = Arc::new(directory.with_authenticated_prefix(context.epoch));
    // This replay also verifies an epoch-zero endpoint's signature and tree.
    replay_authority(anchor, &records[..count], context, &tree, directory.clone(), owner)?;
    let mut input = target_record;
    let target = EpochRecordV1::mls_decode(&mut input).map_err(Error::codec)?;
    let requested = target
        .epoch
        .checked_sub(start.group_context().epoch)
        .and_then(|n| usize::try_from(n).ok())
        .filter(|n| *n <= records.len())
        .ok_or_else(|| invalid("requested epoch is outside the archive"))?;
    if records.len() != count.max(requested) {
        return Err(invalid(
            "unexpected records beyond the authenticated or requested epoch",
        ));
    }
    verify_epoch_authority(
        project_id,
        anchor,
        &records[..requested],
        target_record,
        owner,
        directory,
    )
}

pub fn verify(
    anchor: &[u8],
    records: &[Vec<u8>],
    target: &GroupContext,
    target_tree: &[u8],
    extensions: &ExtensionList,
    directory: Arc<dyn DeviceListVerifier>,
) -> Res<LeafRemovals> {
    let removals = replay(anchor, records, target, target_tree, directory)?;
    let carried = extensions
        .get_as::<LeafRemovals>()
        .map_err(|_| invalid("malformed removal extension"))?
        .unwrap_or_default();
    let mut normalized = LeafRemovals::default();
    normalized.merge(&carried);
    if normalized != removals {
        return Err(Error::policy(vec![Reason::new(
            "removal-history-mismatch",
            "GroupInfo removal records differ from the authenticated epoch archive",
        )]));
    }
    Ok(removals)
}
