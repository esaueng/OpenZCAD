//! Authenticate removal history against the public MLS transcript, anchored
//! to the GroupContext the Welcome (or external join) actually authenticates.
//! This is not historical device-list authorization: today's revocations must
//! not retroactively invalidate an old Commit. Live joins still use ProjectIdentity
//! and ProjectRules. No archive state is installed until verification succeeds.

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

pub fn verify(
    initial_group_info: &[u8],
    records: &[Vec<u8>],
    target: &GroupContext,
    target_tree: &[u8],
    extensions: &ExtensionList,
) -> Res<LeafRemovals> {
    let client = ExternalClient::builder()
        .crypto_provider(RustCryptoProvider::with_enabled_cipher_suites(vec![SUITE]))
        .identity_provider(ArchiveIdentity)
        .extension_type(ROLES_EXT)
        .custom_proposal_types([mls_rs_core::group::ProposalType::SELF_REMOVE])
        .build();
    let mut group = client.observe_group(MlsMessage::from_bytes(initial_group_info)?, None, None)?;
    let initial = group.group_context();
    let roles = ProjectRoles::from_extensions(&initial.extensions).map_err(|r| Error::policy(vec![r]))?;
    let members = group.roster().members();
    if initial.epoch != 0
        || initial.group_id != target.group_id
        || !initial.confirmed_transcript_hash.is_empty()
        || roles.users.len() != 1
        || !roles.check_shape().is_empty()
        || members.len() != 1
        || roles.role(
            &DeviceCredential::from_identity(&members[0].signing_identity)
                .map_err(|r| Error::policy(vec![r]))?
                .user_id,
        ) != Some(Role::Owner)
    {
        return Err(invalid("expected the project's initial owner GroupInfo"));
    }
    if u64::try_from(records.len()).ok() != Some(target.epoch) {
        return Err(invalid("expected every epoch from 1 through the joining epoch"));
    }
    let mut removals = LeafRemovals::default();
    for bytes in records {
        let mut input = bytes.as_slice();
        let record = EpochRecordV1::mls_decode(&mut input).map_err(Error::codec)?;
        if !input.is_empty() || record.version != 1 || record.epoch != group.group_context().epoch + 1 {
            return Err(invalid("invalid or nonconsecutive epoch record"));
        }
        let prior = group.roster().members();
        for proposal in record.proposals {
            if !matches!(
                group.process_incoming_message(MlsMessage::from_bytes(&proposal)?)?,
                ExternalReceivedMessage::Proposal(_)
            ) {
                return Err(invalid("expected a public proposal"));
            }
        }
        let description = match group.process_incoming_message(MlsMessage::from_bytes(&record.commit)?)? {
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
