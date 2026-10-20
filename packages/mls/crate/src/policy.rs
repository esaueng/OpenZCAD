//! ADR-024 commit policy: `MlsRules::filter_proposals` (run on send and on
//! receive) and `IdentityProvider` (run on every new leaf).
//!
//! Rules, from the MLS assessment and the superseded Signed roster and Epoch
//! rotation sections:
//!
//! - Roles live in the roles GroupContext extension. Only the owner changes
//!   it, so only the owner adds identities or changes roles.
//! - Any member may Add a leaf for an identity already listed, with that
//!   identity's existing role (the recovery path that needs no owner).
//! - Every other change a member makes is to its own identity: Update of its
//!   leaf, SelfRemove, or Remove of another leaf of its own identity. A
//!   viewer's Commits therefore change nobody else's access; they may also
//!   carry other members' SelfRemove and Update proposals, which those
//!   members authorised.
//! - A leaf is valid only if the injected verifier says its credential is
//!   certified by an unrevoked device. Nothing signed by a revoked credential
//!   is accepted: not a Commit, not a proposal, not a new leaf.
//! - External Commits are rejoins and follow every rejoin rule (see
//!   [`ProjectRules::check_external_commit`]).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use mls_rs::{
    group::{proposal::BorrowedProposal, Roster, Sender},
    mls_rules::{CommitDirection, CommitOptions, CommitSource, EncryptionOptions, ProposalBundle},
    ExtensionList, IdentityProvider, MlsRules,
};
use mls_rs_core::{
    group::{GroupContext, Member},
    identity::{CredentialType, MemberValidationContext, SigningIdentity},
    time::MlsTime,
};

use crate::directory::{CredentialStatus, SharedDirectory};
use crate::error::{PolicyError, Reason};
use crate::model::{
    display_id, rejoin_psk_epoch, DeviceCredential, LeafRemovals, ProjectRoles, Role, DEVICE_CREDENTIAL,
};

/// State the policy reads that is not in the GroupContext.
#[derive(Clone, Default)]
pub struct PolicyState {
    pub directory: SharedDirectory,
    /// Recorded by this member from the group's own Commits (and seeded from
    /// a signed GroupInfo on join).
    pub removals: Arc<Mutex<LeafRemovals>>,
    /// Test-only: a client that skips its own send-side checks, so tests can
    /// prove receivers refuse. Receivers never skip.
    pub skip_send_checks: Arc<AtomicBool>,
}

fn describe(credential: &DeviceCredential) -> String {
    format!(
        "{}/{}",
        display_id(&credential.user_id),
        display_id(&credential.device_id)
    )
}

fn status_reason(credential: &DeviceCredential, key: &[u8], status: CredentialStatus, who: &str) -> Option<Reason> {
    match status {
        CredentialStatus::Certified => None,
        CredentialStatus::Revoked => Some(Reason::new(
            "credential-revoked",
            format!(
                "{who} {} is signed by a revoked device credential",
                describe(credential)
            ),
        )),
        CredentialStatus::Unknown => Some(Reason::new(
            "credential-unknown",
            format!(
                "{who} {} has no verified certification for key {}",
                describe(credential),
                hex::encode(key)
            ),
        )),
    }
}

// ---------------------------------------------------------------------------
// IdentityProvider

#[derive(Clone, Default)]
pub struct ProjectIdentity {
    pub state: PolicyState,
}

impl IdentityProvider for ProjectIdentity {
    type Error = PolicyError;

    fn validate_member(
        &self,
        identity: &SigningIdentity,
        _: Option<MlsTime>,
        context: MemberValidationContext<'_>,
    ) -> Result<(), Self::Error> {
        let credential = DeviceCredential::from_identity(identity)?;
        let key = identity.signature_key.as_bytes();
        let status = self
            .state
            .directory
            .get()
            .credential_status(&credential.user_id, &credential.device_id, key);
        // A new leaf (an Add, an Update, a commit path, an external joiner)
        // must be certified. A tree being joined may still hold a revoked
        // leaf awaiting its Remove: the joiner accepts it as known, and the
        // rules refuse anything it signs.
        let existing_tree = matches!(context, MemberValidationContext::ForNewGroup { .. });
        let status = if existing_tree && status == CredentialStatus::Revoked {
            CredentialStatus::Certified
        } else {
            status
        };
        let mut reasons: Vec<Reason> = status_reason(&credential, key, status, "leaf").into_iter().collect();
        if let Some(extensions) = context.new_extensions() {
            match ProjectRoles::from_extensions(extensions) {
                Ok(roles) if roles.role(&credential.user_id).is_none() => reasons.push(Reason::new(
                    "leaf-without-role",
                    format!(
                        "leaf {} belongs to a user the roles extension does not list",
                        describe(&credential)
                    ),
                )),
                Ok(_) => {}
                Err(reason) => reasons.push(reason),
            }
        }
        if reasons.is_empty() {
            Ok(())
        } else {
            Err(PolicyError { reasons })
        }
    }

    fn validate_external_sender(
        &self,
        _: &SigningIdentity,
        _: Option<MlsTime>,
        _: Option<&ExtensionList>,
    ) -> Result<(), Self::Error> {
        Err(Reason::new("proposal-forbidden", "external senders are not used").into())
    }

    fn identity(&self, identity: &SigningIdentity, _: &ExtensionList) -> Result<Vec<u8>, Self::Error> {
        let credential = DeviceCredential::from_identity(identity)?;
        Ok(
            mls_rs_codec::MlsEncode::mls_encode_to_vec(&(credential.user_id, credential.device_id))
                .map_err(|e| Reason::new("credential-invalid", format!("{e:?}")))?,
        )
    }

    /// Updates, commit paths and an external Commit's replaced leaf may change
    /// the device and key, never the user.
    fn valid_successor(
        &self,
        predecessor: &SigningIdentity,
        successor: &SigningIdentity,
        _: &ExtensionList,
    ) -> Result<bool, Self::Error> {
        Ok(
            DeviceCredential::from_identity(predecessor)?.user_id
                == DeviceCredential::from_identity(successor)?.user_id,
        )
    }

    fn supported_types(&self) -> Vec<CredentialType> {
        vec![DEVICE_CREDENTIAL]
    }
}

// ---------------------------------------------------------------------------
// MlsRules

#[derive(Clone, Default)]
pub struct ProjectRules {
    pub state: PolicyState,
}

fn leaf(roster: &Roster, index: u32) -> Result<(Member, DeviceCredential), Reason> {
    let member = roster
        .member_with_index(index)
        .map_err(|_| Reason::new("proposal-forbidden", format!("no leaf at index {index}")))?;
    let credential = DeviceCredential::from_identity(&member.signing_identity)?;
    Ok((member, credential))
}

impl MlsRules for ProjectRules {
    type Error = PolicyError;

    fn filter_proposals(
        &self,
        direction: CommitDirection,
        source: CommitSource,
        roster: &Roster,
        context: &GroupContext,
        proposals: ProposalBundle,
    ) -> Result<ProposalBundle, Self::Error> {
        if direction == CommitDirection::Send && self.state.skip_send_checks.load(Ordering::Relaxed) {
            return Ok(proposals);
        }
        let roles = ProjectRoles::from_extensions(&context.extensions)?;
        let reasons = match source {
            CommitSource::NewMember(identity) => {
                self.check_external_commit(&identity, roster, context, &roles, &proposals)
            }
            CommitSource::ExistingMember(committer) => {
                self.check_member_commit(&committer, roster, context, &roles, &proposals)
            }
        };
        if reasons.is_empty() {
            Ok(proposals)
        } else {
            Err(PolicyError { reasons })
        }
    }

    fn commit_options(&self, _: &Roster, _: &GroupContext, _: &ProposalBundle) -> Result<CommitOptions, Self::Error> {
        Ok(CommitOptions::new()
            .with_path_required(true)
            .with_ratchet_tree_extension(true))
    }

    /// Handshake messages stay PublicMessage: the room orders Commits by
    /// epoch, and SelfRemove must be public.
    fn encryption_options(&self, _: &Roster, _: &GroupContext) -> Result<EncryptionOptions, Self::Error> {
        Ok(EncryptionOptions::default())
    }
}

impl ProjectRules {
    fn check_member_commit(
        &self,
        committer: &Member,
        roster: &Roster,
        context: &GroupContext,
        roles: &ProjectRoles,
        proposals: &ProposalBundle,
    ) -> Vec<Reason> {
        let directory = self.state.directory.get();
        let removals = self.state.removals.lock().unwrap().clone();
        let mut reasons = Vec::new();
        let next_epoch = context.epoch + 1;

        // The committer: listed and not revoked. Existing leaves were
        // certified when they joined, so only revocation is checked here.
        match DeviceCredential::from_identity(&committer.signing_identity) {
            Err(reason) => reasons.push(reason),
            Ok(credential) => {
                let key = committer.signing_identity.signature_key.as_bytes();
                if directory.credential_status(&credential.user_id, &credential.device_id, key)
                    == CredentialStatus::Revoked
                {
                    reasons.push(Reason::new(
                        "credential-revoked",
                        format!(
                            "committer {} is signed by a revoked device credential",
                            describe(&credential)
                        ),
                    ));
                }
                if roles.role(&credential.user_id).is_none() {
                    reasons.push(Reason::new(
                        "role-not-listed",
                        format!("committer {} holds no role", describe(&credential)),
                    ));
                }
            }
        }

        let mut next_roles = roles.clone();
        let mut roles_changed = false;
        let mut removed: Vec<u32> = Vec::new();
        let mut adds: Vec<(SigningIdentity, Role)> = Vec::new();

        for info in proposals.iter_proposals() {
            let Sender::Member(sender_index) = info.sender else {
                reasons.push(Reason::new("proposal-forbidden", "only members may propose"));
                continue;
            };
            let (sender, sender_credential) = match leaf(roster, sender_index) {
                Ok(found) => found,
                Err(reason) => {
                    reasons.push(reason);
                    continue;
                }
            };
            let Some(sender_role) = roles.role(&sender_credential.user_id) else {
                reasons.push(Reason::new(
                    "role-not-listed",
                    format!("proposer {} holds no role", describe(&sender_credential)),
                ));
                continue;
            };
            if sender_index != committer.index
                && directory.credential_status(
                    &sender_credential.user_id,
                    &sender_credential.device_id,
                    sender.signing_identity.signature_key.as_bytes(),
                ) == CredentialStatus::Revoked
            {
                reasons.push(Reason::new(
                    "credential-revoked",
                    format!(
                        "proposer {} is signed by a revoked device credential",
                        describe(&sender_credential)
                    ),
                ));
            }
            match info.proposal {
                BorrowedProposal::Update(update) => {
                    // The successor rule (same user) is checked by mls-rs via
                    // valid_successor; its certification by validate_member.
                    let _ = update;
                }
                BorrowedProposal::SelfRemove(_) => removed.push(sender_index),
                BorrowedProposal::Remove(remove) => match leaf(roster, remove.to_remove()) {
                    Err(reason) => reasons.push(reason),
                    Ok((_, target)) => {
                        if sender_role != Role::Owner && target.user_id != sender_credential.user_id {
                            reasons.push(Reason::new(
                                "role-forbidden",
                                format!(
                                    "{} may remove only leaves of its own identity, not {}",
                                    sender_role.as_str(),
                                    describe(&target)
                                ),
                            ));
                        }
                        removed.push(remove.to_remove());
                    }
                },
                BorrowedProposal::Add(add) => adds.push((add.signing_identity().clone(), sender_role)),
                BorrowedProposal::GroupContextExtensions(extensions) => {
                    if sender_role != Role::Owner {
                        reasons.push(Reason::new(
                            "role-forbidden",
                            format!("{} may not change the roles extension", sender_role.as_str()),
                        ));
                    }
                    if roles_changed {
                        reasons.push(Reason::new(
                            "proposal-forbidden",
                            "more than one GroupContextExtensions proposal",
                        ));
                    }
                    roles_changed = true;
                    match ProjectRoles::from_extensions(extensions) {
                        Err(reason) => reasons.push(reason),
                        Ok(next) => {
                            reasons.extend(roles.check_transition(&next, next_epoch));
                            if extensions.len() != 1 {
                                reasons.push(Reason::new("roles-invalid", "only the roles extension may be set"));
                            }
                            next_roles = next;
                        }
                    }
                }
                other => reasons.push(Reason::new(
                    "proposal-forbidden",
                    format!(
                        "proposal type {:?} is not allowed in a member Commit",
                        other.proposal_type()
                    ),
                )),
            }
        }

        for (identity, sender_role) in adds {
            let credential = match DeviceCredential::from_identity(&identity) {
                Ok(credential) => credential,
                Err(reason) => {
                    reasons.push(reason);
                    continue;
                }
            };
            if removals.key_was_removed(identity.signature_key.as_bytes()) {
                reasons.push(Reason::new(
                    "leaf-key-reused",
                    format!(
                        "{} uses a leaf key already removed from this group",
                        describe(&credential)
                    ),
                ));
            }
            let now = roles.entry(&credential.user_id);
            let after = next_roles.entry(&credential.user_id);
            match after {
                None => reasons.push(Reason::new(
                    "leaf-without-role",
                    format!(
                        "added leaf {} belongs to a user the roles extension does not list",
                        describe(&credential)
                    ),
                )),
                Some(after) if sender_role != Role::Owner && now != Some(after) => reasons.push(Reason::new(
                    "role-forbidden",
                    format!(
                        "{} may add a leaf only for an identity already listed with its existing role, not {}",
                        sender_role.as_str(),
                        describe(&credential)
                    ),
                )),
                Some(_) => {}
            }
            // A recovery Add (by a non-owner) must bring a credential
            // certified after the identity's latest leaf removal (ADR-024), so
            // a key certified earlier and held back cannot return without a
            // fresh rejoin proof.
            if sender_role != Role::Owner {
                if let Some(cutoff) = removals.identity_cutoff(&credential.user_id) {
                    let certified = directory.certified_epoch(
                        &credential.user_id,
                        &credential.device_id,
                        identity.signature_key.as_bytes(),
                    );
                    if certified.is_none_or(|epoch| epoch < cutoff) {
                        reasons.push(Reason::new(
                            "leaf-certified-before-removal",
                            format!(
                                "{} was certified {} the identity's latest leaf removal (epoch {cutoff})",
                                describe(&credential),
                                certified.map_or("at no recorded epoch, not after".to_string(), |e| format!(
                                    "at epoch {e}, before"
                                ))
                            ),
                        ));
                    }
                }
            }
        }

        // Nobody stays in the tree without a role: dropping an identity from
        // the roles extension must remove all of its leaves in the same Commit.
        for member in roster.members() {
            if removed.contains(&member.index) {
                continue;
            }
            if let Ok(credential) = DeviceCredential::from_identity(&member.signing_identity) {
                if next_roles.role(&credential.user_id).is_none() && roles_changed {
                    reasons.push(Reason::new(
                        "leaf-without-role",
                        format!("leaf {} would remain without a role", describe(&credential)),
                    ));
                }
            }
        }
        reasons
    }

    /// An external Commit is accepted only as a rejoin (ADR-024, "Long-offline
    /// devices"):
    ///
    /// - the identity is listed in the current roles extension (a rejoin never
    ///   re-adds a removed member, and keeps the listed role);
    /// - the credential is certified and not revoked;
    /// - it carries exactly one rejoin PSK `ozc-rejoin/<epoch>`, whose epoch is
    ///   no earlier than the user's newest device revocation, the identity's
    ///   latest role change (`since`; removal drops the identity, and a re-add
    ///   sets a new `since`), and the latest recorded Remove of a leaf with
    ///   this device or key; and is within the rejoin window;
    /// - it removes at most one leaf, of its own user.
    ///
    /// The last-leaf exception: when the user's only remaining leaf carries a
    /// revoked credential, the replacement the revocation named may rejoin
    /// with a PSK from before the revocation, if this Commit removes that leaf.
    /// Every other rule still applies.
    pub fn check_external_commit(
        &self,
        identity: &SigningIdentity,
        roster: &Roster,
        context: &GroupContext,
        roles: &ProjectRoles,
        proposals: &ProposalBundle,
    ) -> Vec<Reason> {
        let directory = self.state.directory.get();
        let removals = self.state.removals.lock().unwrap().clone();
        let mut reasons = Vec::new();
        let joiner = match DeviceCredential::from_identity(identity) {
            Ok(credential) => credential,
            Err(reason) => return vec![reason],
        };
        let key = identity.signature_key.as_bytes();

        let entry = roles.entry(&joiner.user_id);
        if entry.is_none() {
            reasons.push(Reason::new(
                "identity-not-listed",
                format!("{} is not listed in the roles extension", display_id(&joiner.user_id)),
            ));
        }
        let status = directory.credential_status(&joiner.user_id, &joiner.device_id, key);
        reasons.extend(status_reason(&joiner, key, status, "joiner"));

        let mut psk_epochs = Vec::new();
        let mut removed: Option<(u32, DeviceCredential, Vec<u8>)> = None;
        for info in proposals.iter_proposals() {
            match info.proposal {
                BorrowedProposal::ExternalInit(_) => {}
                BorrowedProposal::Remove(remove) => match leaf(roster, remove.to_remove()) {
                    Err(reason) => reasons.push(reason),
                    Ok((member, target)) => {
                        if target.user_id != joiner.user_id {
                            reasons.push(Reason::new(
                                "external-commit-foreign-removal",
                                format!(
                                    "an external Commit may remove only its own user's leaf, not {}",
                                    describe(&target)
                                ),
                            ));
                        }
                        removed = Some((member.index, target, member.signing_identity.signature_key.to_vec()));
                    }
                },
                BorrowedProposal::Psk(psk) => match psk.external_psk_id().and_then(rejoin_psk_epoch) {
                    Some(epoch) => psk_epochs.push(epoch),
                    None => reasons.push(Reason::new(
                        "rejoin-psk-invalid",
                        "a PSK in an external Commit is not a rejoin PSK",
                    )),
                },
                other => reasons.push(Reason::new(
                    "external-commit-proposal",
                    format!(
                        "proposal type {:?} is not allowed in an external Commit",
                        other.proposal_type()
                    ),
                )),
            }
        }

        let last_leaf_exception = status == CredentialStatus::Certified
            && directory
                .replaces(&joiner.user_id, &joiner.device_id)
                .is_some_and(|revoked_device| {
                    let own: Vec<Member> = roster
                        .members()
                        .into_iter()
                        .filter(|m| {
                            DeviceCredential::from_identity(&m.signing_identity)
                                .is_ok_and(|c| c.user_id == joiner.user_id)
                        })
                        .collect();
                    let [only] = own.as_slice() else { return false };
                    let Ok(only_credential) = DeviceCredential::from_identity(&only.signing_identity) else {
                        return false;
                    };
                    only_credential.device_id == revoked_device
                        && directory.credential_status(
                            &only_credential.user_id,
                            &only_credential.device_id,
                            only.signing_identity.signature_key.as_bytes(),
                        ) == CredentialStatus::Revoked
                        && removed.as_ref().is_some_and(|(index, _, _)| *index == only.index)
                });

        match psk_epochs.as_slice() {
            [] => reasons.push(Reason::new(
                "rejoin-psk-missing",
                "an external Commit must carry a rejoin PSK",
            )),
            [epoch] => {
                let epoch = *epoch;
                let now = context.epoch;
                let window = u64::from(roles.rejoin_window);
                if epoch > now {
                    reasons.push(Reason::new(
                        "rejoin-psk-future",
                        format!("PSK epoch {epoch} is after the current epoch {now}"),
                    ));
                } else if now - epoch > window {
                    reasons.push(Reason::new(
                        "rejoin-psk-outside-window",
                        format!("PSK epoch {epoch} is outside the {window}-epoch window (now {now})"),
                    ));
                }
                if !last_leaf_exception {
                    if let Some(cutoff) = directory.revocation_cutoff(&joiner.user_id) {
                        if epoch < cutoff {
                            reasons.push(Reason::new(
                                "rejoin-psk-before-revocation",
                                format!("PSK epoch {epoch} is before the newest device revocation (epoch {cutoff})"),
                            ));
                        }
                    }
                }
                if let Some(entry) = entry {
                    if epoch < entry.since {
                        reasons.push(Reason::new(
                            "rejoin-psk-before-role-change",
                            format!(
                                "PSK epoch {epoch} is before the identity's latest role change (epoch {})",
                                entry.since
                            ),
                        ));
                    }
                }
                if let Some(cutoff) = removals.cutoff(&joiner.user_id, &joiner.device_id, key) {
                    if epoch < cutoff {
                        reasons.push(Reason::new(
                            "rejoin-psk-before-leaf-removal",
                            format!("PSK epoch {epoch} is before this device's latest leaf removal (epoch {cutoff})"),
                        ));
                    }
                }
            }
            _ => reasons.push(Reason::new(
                "rejoin-psk-multiple",
                "an external Commit may carry only one rejoin PSK",
            )),
        }
        reasons
    }
}
