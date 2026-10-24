//! Derive removal history from the public MLS transcript, never from a
//! committer's unauthenticated application-state hints in GroupInfo.
//!
//! The observer verifies signatures, tree evolution and transcript hashes.
//! It has no epoch secrets and cannot verify historical confirmation MACs or
//! PSK possession. The caller binds its result to the exact GroupContext used
//! by the real MLS Welcome join or external Commit builder.

use mls_rs::{
    external_client::{ExternalClient, ExternalReceivedMessage},
    group::{proposal::Proposal, CommitEffect, Sender},
    ExtensionList, IdentityProvider, MlsMessage,
};
use mls_rs_codec::{MlsDecode, MlsEncode};
use mls_rs_core::{
    group::{GroupContext, ProposalType},
    identity::{CredentialType, MemberValidationContext, SigningIdentity},
    time::MlsTime,
};
use mls_rs_crypto_rustcrypto::RustCryptoProvider;

use crate::{
    error::{Error, PolicyError, Res},
    model::{group_id, DeviceCredential, LeafRemoval, LeafRemovals, DEVICE_CREDENTIAL, ROLES_EXT, SUITE},
    policy::ProjectIdentity,
    session::{EpochRecordV2, EPOCH_RECORD_VERSION},
};

pub fn decode_record(bytes: &[u8]) -> Res<EpochRecordV2> {
    let mut input = bytes;
    let record = EpochRecordV2::mls_decode(&mut input).map_err(Error::codec)?;
    if !input.is_empty() || record.version != EPOCH_RECORD_VERSION {
        return Err(Error::input("not a version 2 epoch record"));
    }
    Ok(record)
}

fn message(bytes: &[u8]) -> Res<MlsMessage> {
    let mut input = bytes;
    let message = MlsMessage::mls_decode(&mut input).map_err(Error::codec)?;
    if !input.is_empty() {
        return Err(Error::input("trailing bytes after an archived MLS message"));
    }
    Ok(message)
}

/// Revocation is evaluated by the real join at the current epoch. Replaying
/// old signatures must still work after their devices have been revoked.
/// This provider checks credential shape and stable user/device identities;
/// it does not claim to authenticate historical application permissions.
#[derive(Clone)]
struct HistoricalIdentity;

impl IdentityProvider for HistoricalIdentity {
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
        identity: &SigningIdentity,
        time: Option<MlsTime>,
        extensions: Option<&ExtensionList>,
    ) -> Result<(), Self::Error> {
        ProjectIdentity::default().validate_external_sender(identity, time, extensions)
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

pub fn verify_history(project: &[u8], expected: &GroupContext, history: &[Vec<u8>]) -> Res<LeafRemovals> {
    // Require the entire chain, including the current Add/Welcome epoch.
    // A suffix or an empty archive must never mean "no removals".
    if history.is_empty() || u64::try_from(history.len() - 1).ok() != Some(expected.epoch) {
        return Err(Error::input(
            "epoch history must cover every epoch from zero through the joining epoch",
        ));
    }
    let first = decode_record(&history[0])?;
    if first.epoch != 0 || !first.commit.is_empty() || !first.proposals.is_empty() || first.group_info.is_empty() {
        return Err(Error::input(
            "epoch history must start with the group's signed epoch-zero GroupInfo",
        ));
    }
    let client = ExternalClient::builder()
        .crypto_provider(RustCryptoProvider::with_enabled_cipher_suites(vec![SUITE]))
        .identity_provider(HistoricalIdentity)
        .extension_type(ROLES_EXT)
        .custom_proposal_types([ProposalType::SELF_REMOVE])
        .build();
    let mut observer = client.observe_group(message(&first.group_info)?, None, None)?;
    if observer.group_context().epoch != 0 || observer.group_context().group_id != group_id(project) {
        return Err(Error::input("epoch-zero GroupInfo is for a different group or epoch"));
    }
    let mut removals = LeafRemovals::default();
    for (epoch, bytes) in history.iter().enumerate() {
        let record = decode_record(bytes)?;
        if record.epoch != epoch as u64 {
            return Err(Error::input("epoch history is not contiguous and ordered"));
        }
        if epoch > 0 {
            if !record.group_info.is_empty() {
                return Err(Error::input("only epoch zero carries a bootstrap GroupInfo"));
            }
            let prior = observer.roster().members();
            for proposal in &record.proposals {
                if !matches!(
                    observer.process_incoming_message(message(proposal)?)?,
                    ExternalReceivedMessage::Proposal(_)
                ) {
                    return Err(Error::input("epoch history contains a non-proposal in its proposals"));
                }
            }
            let ExternalReceivedMessage::Commit(commit) =
                observer.process_incoming_message(message(&record.commit)?)?
            else {
                return Err(Error::input("epoch history contains a non-Commit"));
            };
            let CommitEffect::NewEpoch(next) = commit.effect else {
                return Err(Error::input("epoch history contains an unsupported transition"));
            };
            for info in next.applied_proposals {
                let index = match (info.proposal, info.sender) {
                    (Proposal::Remove(remove), _) => Some(remove.to_remove()),
                    (Proposal::SelfRemove(_), Sender::Member(index)) => Some(index),
                    _ => None,
                };
                if let Some(index) = index {
                    let member = prior
                        .iter()
                        .find(|m| m.index == index)
                        .ok_or_else(|| Error::input("removal has no prior leaf"))?;
                    let credential = DeviceCredential::from_identity(&member.signing_identity)
                        .map_err(|r| Error::policy(vec![r]))?;
                    removals.merge(&LeafRemovals {
                        records: vec![LeafRemoval {
                            user_id: credential.user_id,
                            device_id: credential.device_id,
                            signature_key: member.signing_identity.signature_key.to_vec(),
                            epoch: record.epoch,
                        }],
                    });
                }
            }
        }
        if observer.group_context().mls_encode_to_vec().map_err(Error::codec)? != record.group_context
            || observer.export_tree()? != record.ratchet_tree
        {
            return Err(Error::input(
                "epoch record does not match the replayed MLS context and tree",
            ));
        }
    }
    if observer.group_context() != expected {
        return Err(Error::input("epoch history does not match the joining GroupContext"));
    }
    Ok(removals)
}
