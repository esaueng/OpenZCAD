//! Authenticate removal history against the public MLS transcript, anchored
//! to the GroupContext the Welcome (or external join) actually authenticates.
//! This is not historical device-list authorization: today's revocations must
//! not retroactively invalidate an old Commit. Live joins still use ProjectIdentity
//! and ProjectRules. No archive state is installed until verification succeeds.
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

use mls_rs::{
    external_client::{ExternalClient, ExternalReceivedMessage},
    group::{proposal::Proposal, CommitEffect, Sender},
    ExtensionList, IdentityProvider, MlsMessage,
};
use mls_rs_codec::{MlsDecode, MlsEncode};
use mls_rs_core::{
    group::GroupContext,
    identity::{CredentialType, MemberValidationContext, SigningIdentity},
    time::MlsTime,
};
use mls_rs_crypto_rustcrypto::RustCryptoProvider;

use crate::{
    directory::{CredentialStatus, DeviceListVerifier},
    error::{Error, PolicyError, Reason, Res},
    model::*,
    policy::ProjectIdentity,
    session::EpochRecordV1,
};

#[derive(Clone, Default)]
struct ArchiveIdentity;

impl IdentityProvider for ArchiveIdentity {
    type Error = PolicyError;

    fn validate_member(
        &self,
        identity: &SigningIdentity,
        _: Option<MlsTime>,
        _: MemberValidationContext<'_>,
    ) -> Result<(), Self::Error> {
        DeviceCredential::from_identity(identity)?;
        Ok(())
    }

    fn validate_external_sender(
        &self,
        _: &SigningIdentity,
        _: Option<MlsTime>,
        _: Option<&ExtensionList>,
    ) -> Result<(), Self::Error> {
        Err(Reason::new("proposal-forbidden", "external senders are not used").into())
    }

    fn identity(&self, identity: &SigningIdentity, extensions: &ExtensionList) -> Result<Vec<u8>, Self::Error> {
        ProjectIdentity::default().identity(identity, extensions)
    }

    fn valid_successor(
        &self,
        predecessor: &SigningIdentity,
        successor: &SigningIdentity,
        extensions: &ExtensionList,
    ) -> Result<bool, Self::Error> {
        ProjectIdentity::default().valid_successor(predecessor, successor, extensions)
    }

    fn supported_types(&self) -> Vec<CredentialType> {
        vec![DEVICE_CREDENTIAL]
    }
}

fn invalid(detail: &str) -> Error {
    Error::input(format!("removal archive: {detail}"))
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
    directory: &dyn DeviceListVerifier,
) -> Res<LeafRemovals> {
    let client = ExternalClient::builder()
        .crypto_provider(RustCryptoProvider::with_enabled_cipher_suites(vec![SUITE]))
        .identity_provider(ArchiveIdentity)
        .extension_type(ROLES_EXT)
        .custom_proposal_types([mls_rs_core::group::ProposalType::SELF_REMOVE])
        .build();
    let mut group = client.observe_group(message(anchor)?, None, None)?;
    let initial = group.group_context().clone();
    let roles = ProjectRoles::from_extensions(&initial.extensions).map_err(|r| Error::policy(vec![r]))?;
    let members = group.roster().members();
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
        LeafRemovals::default()
    } else {
        checkpoint_removals(anchor, &initial, &roles, &members, directory)?
    };
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
    }
    if group.group_context() != target || group.export_tree()? != target_tree {
        return Err(invalid("history does not reach the authenticated joining state"));
    }
    Ok(removals)
}

pub fn verify(
    anchor: &[u8],
    records: &[Vec<u8>],
    target: &GroupContext,
    target_tree: &[u8],
    extensions: &ExtensionList,
    directory: &dyn DeviceListVerifier,
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
