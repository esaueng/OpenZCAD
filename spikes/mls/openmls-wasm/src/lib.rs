//! ADR-024 MLS spike, OpenMLS flavour. Throwaway code: one exported async
//! function runs the whole scenario and returns a JSON report, mirroring the
//! mls-rs crate. OpenMLS has no policy callback, so the app's role policy
//! (`authorize_commit`) runs on every `StagedCommit` before it is merged.

use std::collections::{BTreeMap, HashMap};

use openmls::prelude::{
    tls_codec::{Deserialize as _, Serialize as _},
    *,
};
use openmls::schedule::{
    psk::{ExternalPsk, Psk, ResumptionPsk, ResumptionPskUsage},
    PreSharedKeyId,
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_memory_storage::MemoryStorage;
use openmls_rust_crypto::RustCrypto;
use openmls_traits::OpenMlsProvider;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

const CS: Ciphersuite = Ciphersuite::MLS_128_DHKEMP256_AES128GCM_SHA256_P256; // 0x0002
const ROLES_EXT: u16 = 0xF0A1;
const EXPORTER_LABEL: &str = "openzcad project key";

type R<T> = Result<T, String>;

fn s<E: std::fmt::Debug>(e: E) -> String {
    let text = format!("{e:?}");
    text.chars().take(200).collect()
}

// ---------------------------------------------------------------------------
// Provider: RustCrypto plus an exportable in-memory store

#[derive(Default)]
struct Provider {
    crypto: RustCrypto,
    storage: MemoryStorage,
}

impl OpenMlsProvider for Provider {
    type CryptoProvider = RustCrypto;
    type RandProvider = RustCrypto;
    type StorageProvider = MemoryStorage;

    fn storage(&self) -> &Self::StorageProvider {
        &self.storage
    }
    fn crypto(&self) -> &Self::CryptoProvider {
        &self.crypto
    }
    fn rand(&self) -> &Self::RandProvider {
        &self.crypto
    }
}

// ---------------------------------------------------------------------------
// App policy

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
enum Role {
    Viewer,
    Editor,
    Owner,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
struct RoleEntry {
    role: Role,
    /// Epoch from which this role applies (added or last changed).
    since: u64,
}

fn roles_ext(entries: &[(&str, Role)]) -> R<Extensions<GroupContext>> {
    let with_since: Vec<_> = entries.iter().map(|(u, r)| (*u, *r, 0)).collect();
    roles_ext_since(&with_since)
}

fn roles_ext_since(entries: &[(&str, Role, u64)]) -> R<Extensions<GroupContext>> {
    let map: BTreeMap<String, RoleEntry> = entries
        .iter()
        .map(|(u, role, since)| (u.to_string(), RoleEntry { role: *role, since: *since }))
        .collect();
    let bytes = serde_json::to_vec(&map).map_err(s)?;
    // OpenMLS refuses a GroupContextExtensions proposal carrying an extension
    // the RequiredCapabilities extension does not list.
    let required = RequiredCapabilitiesExtension::new(
        &[ExtensionType::Unknown(ROLES_EXT)],
        &[ProposalType::SelfRemove],
        &[CredentialType::Basic],
    );
    Extensions::from_vec(vec![
        Extension::RequiredCapabilities(required),
        Extension::Unknown(ROLES_EXT, UnknownExtension(bytes)),
    ])
    .map_err(s)
}

fn roles_of(exts: &Extensions<GroupContext>) -> R<BTreeMap<String, RoleEntry>> {
    let ext = exts.unknown(ROLES_EXT).ok_or("roles extension missing")?;
    serde_json::from_slice(&ext.0).map_err(s)
}

fn user_of(credential: &Credential) -> R<String> {
    let basic = BasicCredential::try_from(credential.clone()).map_err(s)?;
    let id = String::from_utf8(basic.identity().to_vec()).map_err(s)?;
    Ok(id.split('/').next().unwrap_or_default().to_string())
}

/// Certified device signing keys per user (stands in for verified device
/// lists).
#[derive(Clone, Default)]
struct Directory {
    keys: HashMap<String, Vec<Vec<u8>>>,
    revoked: Vec<Vec<u8>>,
    /// Epoch of each user's newest device revocation.
    revoked_at: HashMap<String, u64>,
}

impl Directory {
    fn certify(&mut self, user: &str, key: &[u8]) {
        self.keys.entry(user.into()).or_default().push(key.to_vec());
    }
    fn revoke(&mut self, user: &str, key: &[u8], epoch: u64) {
        self.revoked.push(key.to_vec());
        self.revoked_at.insert(user.into(), epoch);
    }
    fn is_revoked(&self, key: &[u8]) -> bool {
        self.revoked.iter().any(|k| k == key)
    }
    fn check(&self, credential: &Credential, key: &[u8]) -> R<()> {
        let user = user_of(credential)?;
        if self.is_revoked(key) {
            return Err("credential revoked".into());
        }
        if self.keys.get(&user).map(|k| k.iter().any(|k| k == key)).unwrap_or(false) {
            Ok(())
        } else {
            Err(format!("device key not certified for user {user}"))
        }
    }
}

fn leaf_user(group: &MlsGroup, index: LeafNodeIndex) -> R<String> {
    user_of(group.member(index).ok_or("unknown leaf")?)
}

/// The app's commit validation. Returns Err to make the caller discard the
/// staged commit instead of merging it.
fn authorize_commit(
    group: &MlsGroup,
    sender: &Sender,
    staged: &StagedCommit,
    dir: &Directory,
    rejoin_window: Option<u64>,
) -> R<()> {
    let roles = roles_of(group.extensions())?;
    let new_roles = roles_of(staged.group_context().extensions())?;

    // Every added leaf: certified device of a user holding a role afterwards.
    for add in staged.add_proposals() {
        let leaf = add.add_proposal().key_package().leaf_node();
        dir.check(leaf.credential(), leaf.signature_key().as_slice())?;
        if !new_roles.contains_key(&user_of(leaf.credential())?) {
            return Err("added leaf's user holds no role".into());
        }
    }

    match sender {
        Sender::NewMemberCommit => {
            // Collect every failed rule so the spike can show which fired.
            let leaf = staged.update_path_leaf_node().ok_or("external commit without path")?;
            let mut reasons: Vec<String> = Vec::new();
            if let Err(e) = dir.check(leaf.credential(), leaf.signature_key().as_slice()) {
                reasons.push(e);
            }
            let joiner = user_of(leaf.credential())?;
            let entry = roles.get(&joiner);
            if entry.is_none() {
                reasons.push("identity not listed in the roles extension".into());
            }
            let mut psk_epoch = None;
            for q in staged.queued_proposals() {
                match q.proposal() {
                    Proposal::ExternalInit(_) | Proposal::SelfRemove => {}
                    Proposal::Remove(r) if leaf_user(group, r.removed())? == joiner => {}
                    Proposal::PreSharedKey(p) => match rejoin_psk_epoch(p) {
                        Some(e) => psk_epoch = Some(e),
                        None => reasons.push("PSK is not a rejoin PSK".into()),
                    },
                    other => reasons.push(format!("{:?} not allowed in an external commit", other.proposal_type())),
                }
            }
            if let Some(window) = rejoin_window {
                match psk_epoch {
                    None => reasons.push("no rejoin PSK".into()),
                    Some(e) => {
                        if let Some(r) = dir.revoked_at.get(&joiner) {
                            if e < *r {
                                reasons.push(format!("PSK epoch {e} before newest revocation {r}"));
                            }
                        }
                        if let Some(entry) = entry {
                            if e < entry.since {
                                reasons.push(format!("PSK epoch {e} before role change {}", entry.since));
                            }
                        }
                        let now = group.epoch().as_u64();
                        if now.saturating_sub(e) > window {
                            reasons.push(format!("PSK epoch {e} outside the {window}-epoch window (now {now})"));
                        }
                    }
                }
            }
            if !reasons.is_empty() {
                return Err(reasons.join("; "));
            }
        }
        Sender::Member(_) => {
            for q in staged.queued_proposals() {
                let Sender::Member(proposer) = q.sender() else {
                    return Err("only members may propose".into());
                };
                let proposer_user = leaf_user(group, *proposer)?;
                let role = roles.get(&proposer_user).ok_or("proposer holds no role")?.role;
                let ok = match q.proposal() {
                    Proposal::Update(_) | Proposal::SelfRemove => true,
                    Proposal::Remove(r) => {
                        role == Role::Owner || leaf_user(group, r.removed())? == proposer_user
                    }
                    Proposal::Add(_) | Proposal::GroupContextExtensions(_) => role == Role::Owner,
                    _ => false,
                };
                if !ok {
                    return Err(format!(
                        "role {role:?} may not send {:?}",
                        q.proposal().proposal_type()
                    ));
                }
            }
            // A committer's own update path may not change its identity.
            if let (Some(leaf), Sender::Member(i)) = (staged.update_path_leaf_node(), sender) {
                if leaf_user(group, *i)? != user_of(leaf.credential())? {
                    return Err("committer changed user".into());
                }
                dir.check(leaf.credential(), leaf.signature_key().as_slice())?;
            }
        }
        _ => return Err("unsupported sender".into()),
    }
    let _ = Role::Viewer;
    Ok(())
}

// ---------------------------------------------------------------------------
// Host hooks

struct Hooks {
    obj: JsValue,
}

impl Hooks {
    fn now(&self) -> f64 {
        let f: js_sys::Function = js_sys::Reflect::get(&self.obj, &"now".into()).unwrap().into();
        f.call0(&self.obj).unwrap().as_f64().unwrap()
    }

    async fn persist(&self, label: &str, bytes: &[u8]) -> R<Vec<u8>> {
        let f: js_sys::Function = js_sys::Reflect::get(&self.obj, &"persist".into()).map_err(s)?.into();
        let promise: js_sys::Promise = f
            .call2(&self.obj, &label.into(), &js_sys::Uint8Array::from(bytes))
            .map_err(s)?
            .into();
        let out = JsFuture::from(promise).await.map_err(s)?;
        Ok(js_sys::Uint8Array::new(&out).to_vec())
    }
}

// ---------------------------------------------------------------------------
// Report (same shape as the mls-rs crate)

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
// Devices and wire helpers

struct Device {
    name: String,
    provider: Provider,
    signer: SignatureKeyPair,
    cwk: CredentialWithKey,
    group: Option<MlsGroup>,
    /// Rejoin policy window this device enforces (None: no PSK rule).
    window: Option<u64>,
    /// Rejoin PSKs this device kept (wrapped under the account key in the
    /// real design).
    saved: Vec<(u64, Vec<u8>)>,
}

fn capabilities() -> Capabilities {
    Capabilities::new(
        None,
        Some(&[CS]),
        Some(&[ExtensionType::Unknown(ROLES_EXT)]),
        Some(&[ProposalType::SelfRemove]),
        Some(&[CredentialType::Basic]),
    )
}

/// External joiners must restate their capabilities: the default leaf
/// does not support the roles extension, and OpenMLS rejects it.
fn leaf_params() -> LeafNodeParameters {
    LeafNodeParameters::builder().with_capabilities(capabilities()).build()
}

fn join_config() -> MlsGroupJoinConfig {
    MlsGroupJoinConfig::builder()
        .use_ratchet_tree_extension(true)
        .wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
        .max_past_epochs(3)
        .build()
}

fn new_device(user: &str, device: &str, dir: &mut Directory, certify: bool) -> R<Device> {
    let signer = SignatureKeyPair::new(CS.signature_algorithm()).map_err(s)?;
    let credential: Credential = BasicCredential::new(format!("{user}/{device}").into_bytes()).into();
    if certify {
        dir.certify(user, signer.public());
    }
    Ok(Device {
        name: device.into(),
        provider: Provider::default(),
        cwk: CredentialWithKey { credential, signature_key: signer.public().into() },
        signer,
        group: None,
        window: None,
        saved: Vec::new(),
    })
}

/// Serialize to wire bytes and parse back, as the Delivery Service would.
fn wire(msg: &MlsMessageOut) -> R<(MlsMessageIn, usize)> {
    let bytes = msg.tls_serialize_detached().map_err(s)?;
    let parsed = MlsMessageIn::tls_deserialize_exact(&bytes).map_err(s)?;
    Ok((parsed, bytes.len()))
}

fn key_package(d: &Device) -> R<(KeyPackage, usize)> {
    let bundle = KeyPackage::builder()
        .leaf_node_capabilities(capabilities())
        .build(CS, &d.provider, &d.signer, d.cwk.clone())
        .map_err(s)?;
    let msg = MlsMessageOut::from(bundle.key_package().clone());
    let (parsed, len) = wire(&msg)?;
    let MlsMessageBodyIn::KeyPackage(kp_in) = parsed.extract() else {
        return Err("not a key package".into());
    };
    let kp = kp_in.validate(d.provider.crypto(), ProtocolVersion::Mls10).map_err(s)?;
    Ok((kp, len))
}

fn join(d: &mut Device, welcome: &MlsMessageOut, dir: &Directory) -> R<()> {
    let (msg, _) = wire(welcome)?;
    let MlsMessageBodyIn::Welcome(welcome) = msg.extract() else {
        return Err("not a welcome".into());
    };
    let staged = StagedWelcome::new_from_welcome(&d.provider, &join_config(), welcome, None).map_err(s)?;
    // The joiner checks every leaf in the tree before accepting.
    for m in staged.members() {
        dir.check(&m.credential, &m.signature_key)?;
    }
    d.group = Some(staged.into_group(&d.provider).map_err(s)?);
    Ok(())
}

/// Process a handshake message on one device, applying the app policy.
fn receive(
    hooks: &Hooks,
    report: &mut Report,
    d: &mut Device,
    msg: &MlsMessageOut,
    dir: &Directory,
) -> R<()> {
    let (parsed, _) = wire(msg)?;
    let protocol = parsed.try_into_protocol_message().map_err(s)?;
    let t = hooks.now();
    let provider = &d.provider;
    let group = d.group.as_mut().ok_or("no group")?;
    let processed = group
        .process_message(provider, protocol)
        .map_err(|e| format!("{} rejected: {}", d.name, s(e)))?;
    let sender = processed.sender().clone();
    match processed.into_content() {
        ProcessedMessageContent::StagedCommitMessage(staged) => {
            authorize_commit(group, &sender, &staged, dir, d.window)
                .map_err(|e| format!("{} policy rejected: {e}", d.name))?;
            group.merge_staged_commit(provider, *staged).map_err(s)?;
            report.commit_process_ms.push(hooks.now() - t);
        }
        ProcessedMessageContent::ProposalMessage(p) => {
            // Proposals are policy-checked again when committed.
            group.store_pending_proposal(provider.storage(), *p).map_err(s)?;
        }
        _ => return Err("unexpected message".into()),
    }
    Ok(())
}

fn deliver(
    hooks: &Hooks,
    report: &mut Report,
    msg: &MlsMessageOut,
    to: &mut [&mut Device],
    dir: &Directory,
) -> R<()> {
    for d in to.iter_mut() {
        receive(hooks, report, d, msg, dir)?;
    }
    Ok(())
}

fn commit(d: &mut Device) -> R<CommitMessageBundle> {
    let provider = &d.provider;
    let signer = &d.signer;
    let group = d.group.as_mut().ok_or("no group")?;
    group.self_update(provider, signer, LeafNodeParameters::default()).map_err(s)
}

fn merge_own(d: &mut Device) -> R<()> {
    let provider = &d.provider;
    d.group.as_mut().ok_or("no group")?.merge_pending_commit(provider).map_err(s)
}

fn check_agreement(report: &mut Report, project_id: &[u8], devices: &[&Device]) -> R<String> {
    let mut seen: Option<(u64, Vec<u8>, Vec<u8>)> = None;
    for d in devices {
        let group = d.group.as_ref().ok_or("missing group")?;
        let epoch = group.epoch().as_u64();
        let auth = group.epoch_authenticator().as_slice().to_vec();
        let key = group
            .export_secret(d.provider.crypto(), EXPORTER_LABEL, project_id, 32)
            .map_err(s)?;
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

fn group_info_in(msg: &MlsMessageOut) -> R<openmls::messages::group_info::VerifiableGroupInfo> {
    match wire(msg)?.0.extract() {
        MlsMessageBodyIn::GroupInfo(gi) => Ok(gi),
        _ => Err("not group info".into()),
    }
}

/// OpenMLS ships no browser storage; the memory store's map is public, so
/// the spike length-prefixes its entries into one blob.
fn storage_bytes(p: &Provider) -> R<Vec<u8>> {
    let values = p.storage.values.read().unwrap();
    let mut entries: Vec<_> = values.iter().collect();
    entries.sort();
    let mut out = (entries.len() as u32).to_be_bytes().to_vec();
    for (k, v) in entries {
        out.extend((k.len() as u32).to_be_bytes());
        out.extend((v.len() as u32).to_be_bytes());
        out.extend(k);
        out.extend(v);
    }
    Ok(out)
}

fn storage_from_bytes(bytes: &[u8]) -> R<MemoryStorage> {
    let mut at = 0usize;
    let mut take = |n: usize| -> R<&[u8]> {
        let slice = bytes.get(at..at + n).ok_or("truncated state")?;
        at += n;
        Ok(slice)
    };
    let u32_at = |b: &[u8]| u32::from_be_bytes(b.try_into().unwrap()) as usize;
    let count = u32_at(take(4)?);
    let storage = MemoryStorage::default();
    {
        let mut map = storage.values.write().unwrap();
        for _ in 0..count {
            let kl = u32_at(take(4)?);
            let vl = u32_at(take(4)?);
            let k = take(kl)?.to_vec();
            let v = take(vl)?.to_vec();
            map.insert(k, v);
        }
    }
    Ok(storage)
}

// ---------------------------------------------------------------------------
// Scenario

#[wasm_bindgen]
pub async fn run_scenario(project_id: String, hooks: JsValue, rounds: u32) -> Result<String, JsValue> {
    let hooks = Hooks { obj: hooks };
    let mut report = Report {
        library: "openmls",
        version: "0.9.1",
        crypto: "openmls_rust_crypto 0.6.0 (RustCrypto, compiled to WASM)",
        cipher_suite: 2,
        ..Default::default()
    };
    if let Err(e) = scenario(&hooks, &mut report, project_id.as_bytes(), rounds).await {
        report.step("aborted", Err(e));
    }
    serde_json::to_string(&report).map_err(|e| JsValue::from_str(&e.to_string()))
}

async fn scenario(hooks: &Hooks, report: &mut Report, project_id: &[u8], rounds: u32) -> R<()> {
    let mut dir = Directory::default();
    let group_id = GroupId::from_slice(&[b"project:".as_slice(), project_id].concat());

    let mut a1 = new_device("A", "A1", &mut dir, true)?;
    let mut a2 = new_device("A", "A2", &mut dir, true)?;
    let mut b1 = new_device("B", "B1", &mut dir, true)?;

    // 1. Create, KeyPackage, Add, Welcome --------------------------------
    a1.group = Some(
        MlsGroup::builder()
            .with_group_id(group_id.clone())
            .ciphersuite(CS)
            .use_ratchet_tree_extension(true)
            .with_wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
            .max_past_epochs(3)
            .with_capabilities(capabilities())
            .with_group_context_extensions(roles_ext(&[("A", Role::Owner)])?)
            .build(&a1.provider, &a1.signer, a1.cwk.clone())
            .map_err(s)?,
    );
    let (kp, kp_len) = key_package(&a2)?;
    report.sizes.insert("key_package".into(), kp_len);
    let t = hooks.now();
    let (commit_out, welcome, _) = {
        let p = &a1.provider;
        a1.group.as_mut().unwrap().add_members(p, &a1.signer, &[kp]).map_err(s)?
    };
    report.add_commit_ms.push(hooks.now() - t);
    merge_own(&mut a1)?;
    let _ = commit_out;
    report.sizes.insert("welcome_1_joiner".into(), wire(&welcome)?.1);
    let t = hooks.now();
    join(&mut a2, &welcome, &dir)?;
    report.welcome_join_ms.push(hooks.now() - t);
    let r = check_agreement(report, project_id, &[&a1, &a2]);
    report.step("create + add A2 via Welcome", r);

    // Owner adds B's device and grants B the editor role in one Commit.
    let (kp, _) = key_package(&b1)?;
    let t = hooks.now();
    let bundle = {
        let p = &a1.provider;
        let signer = &a1.signer;
        a1.group.as_mut().unwrap()
            .commit_builder()
            .propose_adds([kp])
            .propose_group_context_extensions(roles_ext(&[("A", Role::Owner), ("B", Role::Editor)])?)
            .map_err(s)?
            .load_psks(p.storage())
            .map_err(s)?
            .build(p.rand(), p.crypto(), signer, |_| true)
            .map_err(s)?
            .stage_commit(p)
            .map_err(s)?
    };
    report.add_commit_ms.push(hooks.now() - t);
    merge_own(&mut a1)?;
    let (commit_msg, welcome, _) = bundle.into_messages();
    deliver(hooks, report, &commit_msg, &mut [&mut a2], &dir)?;
    let t = hooks.now();
    join(&mut b1, &welcome.ok_or("no welcome")?, &dir)?;
    report.welcome_join_ms.push(hooks.now() - t);
    let r = check_agreement(report, project_id, &[&a1, &a2, &b1]);
    report.step("add B1 with editor role", r);

    // 2. Update -----------------------------------------------------------
    let (update, _) = {
        let p = &b1.provider;
        let signer = &b1.signer;
        b1.group.as_mut().unwrap().propose_self_update(p, signer, LeafNodeParameters::default()).map_err(s)?
    };
    deliver(hooks, report, &update, &mut [&mut a1, &mut a2], &dir)?;
    let t = hooks.now();
    let bundle = {
        let p = &a1.provider;
        let signer = &a1.signer;
        a1.group.as_mut().unwrap().commit_to_pending_proposals(p, signer).map_err(s)?.0
    };
    report.commit_create_ms.push(hooks.now() - t);
    merge_own(&mut a1)?;
    // B1 drops its own pending update proposal's private key bookkeeping by
    // processing the commit like everyone else.
    deliver(hooks, report, &bundle, &mut [&mut a2, &mut b1], &dir)?;
    let r = check_agreement(report, project_id, &[&a1, &a2, &b1]);
    report.step("Update proposal by B1, committed by A1", r);

    // 3. Commit timing: rotating self-update commits ----------------------
    for round in 0..rounds {
        let (committer, others): (&mut Device, [&mut Device; 2]) = match round % 3 {
            0 => (&mut a1, [&mut a2, &mut b1]),
            1 => (&mut a2, [&mut a1, &mut b1]),
            _ => (&mut b1, [&mut a1, &mut a2]),
        };
        let t = hooks.now();
        let bundle = commit(committer)?;
        report.commit_create_ms.push(hooks.now() - t);
        merge_own(committer)?;
        let msg = bundle.into_commit();
        report.sizes.insert("commit_path_only".into(), wire(&msg)?.1);
        let [x, y] = others;
        deliver(hooks, report, &msg, &mut [x, y], &dir)?;
        check_agreement(report, project_id, &[&a1, &a2, &b1])?;
    }
    report.step("timed path-only commits", Ok(format!("{rounds} rounds")));

    // 4. Welcome timing: add and remove a temporary device of A -----------
    for i in 0..rounds.min(5) {
        let mut tmp = new_device("A", &format!("T{i}"), &mut dir, true)?;
        let (kp, _) = key_package(&tmp)?;
        let t = hooks.now();
        let (commit_msg, welcome, _) = {
            let p = &a1.provider;
            a1.group.as_mut().unwrap().add_members(p, &a1.signer, &[kp]).map_err(s)?
        };
        report.add_commit_ms.push(hooks.now() - t);
        merge_own(&mut a1)?;
        report.sizes.insert("welcome_4_member_group".into(), wire(&welcome)?.1);
        deliver(hooks, report, &commit_msg, &mut [&mut a2, &mut b1], &dir)?;
        let t = hooks.now();
        join(&mut tmp, &welcome, &dir)?;
        report.welcome_join_ms.push(hooks.now() - t);
        check_agreement(report, project_id, &[&a1, &a2, &b1, &tmp])?;
        let idx = tmp.group.as_mut().unwrap().own_leaf_index();
        let (commit_msg, _, _) = {
            let p = &a1.provider;
            a1.group.as_mut().unwrap().remove_members(p, &a1.signer, &[idx]).map_err(s)?
        };
        merge_own(&mut a1)?;
        deliver(hooks, report, &commit_msg, &mut [&mut a2, &mut b1], &dir)?;
    }
    let r = check_agreement(report, project_id, &[&a1, &a2, &b1]);
    report.step("timed Welcome joins", r);

    // 5. Policy: an editor's Add is rejected by every receiver -------------
    {
        let b2 = new_device("B", "B2", &mut dir, true)?;
        let (kp, _) = key_package(&b2)?;
        // OpenMLS has no send-side role policy, so B1 can build it.
        let (commit_msg, _, _) = {
            let p = &b1.provider;
            b1.group.as_mut().unwrap().add_members(p, &b1.signer, &[kp]).map_err(s)?
        };
        let r1 = receive(hooks, report, &mut a1, &commit_msg, &dir);
        let r2 = receive(hooks, report, &mut a2, &commit_msg, &dir);
        let p = &b1.provider;
        b1.group.as_mut().unwrap().clear_pending_commit(p.storage()).map_err(s)?;
        let r = match (r1, r2) {
            (Err(e), Err(_)) => Ok(format!("both A devices rejected: {e}")),
            _ => Err("an editor's Add was merged".into()),
        };
        report.step("policy: editor Add rejected", r);
    }

    // 6. Policy: external commit from an uncertified device is rejected ----
    {
        let gi = {
            let p = &a1.provider;
            a1.group.as_mut().unwrap().export_group_info(p.crypto(), &a1.signer, true).map_err(s)?
        };
        report.sizes.insert("group_info_with_external_pub".into(), wire(&gi)?.1);
        let rogue = new_device("A", "rogue", &mut dir, false)?;
        let vgi = group_info_in(&gi)?;
        let built = MlsGroup::external_commit_builder()
            .with_config(join_config())
            .build_group(&rogue.provider, vgi, rogue.cwk.clone())
            .map_err(s)
            .map(|b| b.leaf_node_parameters(leaf_params()))
            .and_then(|b| b.load_psks(rogue.provider.storage()).map_err(s))
            .and_then(|b| b.build(rogue.provider.rand(), rogue.provider.crypto(), &rogue.signer, |_| true).map_err(s))
            .and_then(|b| b.finalize(&rogue.provider).map_err(s));
        let r = match built {
            Err(e) => Err(format!("rogue could not build: {e}")),
            Ok((_, bundle)) => match receive(hooks, report, &mut a1, &bundle.into_commit(), &dir) {
                Err(e) => Ok(format!("A1 rejected: {e}")),
                Ok(()) => Err("uncertified external commit merged".into()),
            },
        };
        report.step("policy: uncertified external commit rejected", r);
    }

    // 7. Conflicting commits for one epoch: first wins, loser rebases ------
    {
        let epoch = a1.group.as_mut().unwrap().epoch().as_u64();
        let first = commit(&mut a2)?.into_commit();
        let second = commit(&mut b1)?.into_commit();
        merge_own(&mut a2)?;
        {
            let p = &b1.provider;
            b1.group.as_mut().unwrap().clear_pending_commit(p.storage()).map_err(s)?;
        }
        deliver(hooks, report, &first, &mut [&mut a1, &mut b1], &dir)?;
        let stale = receive(hooks, report, &mut a1, &second, &dir);
        let rebased = commit(&mut b1)?.into_commit();
        merge_own(&mut b1)?;
        deliver(hooks, report, &rebased, &mut [&mut a1, &mut a2], &dir)?;
        let r = check_agreement(report, project_id, &[&a1, &a2, &b1]).and_then(|d| {
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
        let before = storage_bytes(&a1.provider)?.len();
        a1.signer.store(a1.provider.storage()).map_err(s)?;
        let bytes = storage_bytes(&a1.provider)?;
        report.sizes.insert("state_a1_3_members".into(), bytes.len());
        report.sizes.insert("signature_key_pair_record".into(), bytes.len() - before);
        let restored = hooks.persist("openmls/A1", &bytes).await?;
        let storage = storage_from_bytes(&restored)?;
        let signer = SignatureKeyPair::read(&storage, a1.signer.public(), a1.signer.signature_scheme())
            .ok_or("signature key missing after reload")?;
        let group = MlsGroup::load(&storage, &group_id).map_err(s)?.ok_or("group missing after reload")?;
        a1.provider = Provider { crypto: RustCrypto::default(), storage };
        a1.signer = signer;
        a1.group = Some(group);
        let msg = commit(&mut a1)?.into_commit();
        merge_own(&mut a1)?;
        deliver(hooks, report, &msg, &mut [&mut a2, &mut b1], &dir)?;
        let r = check_agreement(report, project_id, &[&a1, &a2, &b1]);
        report.step(
            "state persisted, reloaded, commits again",
            r.map(|d| format!("{} B state; {d}", bytes.len())),
        );
    }

    // 9. External-commit rejoin of A2 after its storage was wiped ----------
    {
        let old_index = a2.group.as_mut().unwrap().own_leaf_index();
        let gi = {
            let p = &a1.provider;
            a1.group.as_mut().unwrap().export_group_info(p.crypto(), &a1.signer, true).map_err(s)?
        };
        let vgi = group_info_in(&gi)?;
        // Wiped browser: new device key, re-certified by A's identity key.
        // OpenMLS only auto-removes an old leaf with the SAME signature key,
        // so the stale leaf has to be removed by the owner afterwards.
        let mut a2b = new_device("A", "A2", &mut dir, true)?;
        let t = hooks.now();
        let (group, bundle) = MlsGroup::external_commit_builder()
            .with_config(join_config())
            .build_group(&a2b.provider, vgi, a2b.cwk.clone())
            .map_err(s)?
            .leaf_node_parameters(leaf_params())
            .load_psks(a2b.provider.storage())
            .map_err(s)?
            .build(a2b.provider.rand(), a2b.provider.crypto(), &a2b.signer, |_| true)
            .map_err(s)?
            .finalize(&a2b.provider)
            .map_err(s)?;
        report.external_commit_ms.push(hooks.now() - t);
        a2b.group = Some(group);
        deliver(hooks, report, &bundle.into_commit(), &mut [&mut a1, &mut b1], &dir)?;
        // Owner removes the stale leaf of the wiped browser.
        let (msg, _, _) = {
            let p = &a1.provider;
            a1.group.as_mut().unwrap().remove_members(p, &a1.signer, &[old_index]).map_err(s)?
        };
        merge_own(&mut a1)?;
        deliver(hooks, report, &msg, &mut [&mut a2b, &mut b1], &dir)?;
        a2 = a2b;
        let r = check_agreement(report, project_id, &[&a1, &a2, &b1]);
        report.step(
            "external-commit rejoin of wiped A2",
            r.map(|d| format!("stale leaf needed a separate Remove; {d}")),
        );
    }

    // 10. Remove one of A's devices ----------------------------------------
    {
        let idx = a2.group.as_mut().unwrap().own_leaf_index();
        let (msg, _, _) = {
            let p = &a1.provider;
            a1.group.as_mut().unwrap().remove_members(p, &a1.signer, &[idx]).map_err(s)?
        };
        merge_own(&mut a1)?;
        deliver(hooks, report, &msg, &mut [&mut b1], &dir)?;
        let removed = receive(hooks, report, &mut a2, &msg, &dir);
        let inactive = !a2.group.as_mut().unwrap().is_active();
        let next = commit(&mut a1)?.into_commit();
        merge_own(&mut a1)?;
        deliver(hooks, report, &next, &mut [&mut b1], &dir)?;
        let follow = receive(hooks, report, &mut a2, &next, &dir);
        let r = check_agreement(report, project_id, &[&a1, &b1]).and_then(|d| {
            if follow.is_ok() {
                Err("removed device processed a later commit".into())
            } else {
                Ok(format!("A2 processed removal: {}, inactive: {inactive}; {d}", removed.is_ok()))
            }
        });
        report.step("remove A2", r);
    }

    // 11. B leaves with SelfRemove, committed by A1 -----------------------
    {
        let proposal = {
            let p = &b1.provider;
            let signer = &b1.signer;
            b1.group.as_mut().unwrap().leave_group_via_self_remove(p, signer).map_err(s)?
        };
        deliver(hooks, report, &proposal, &mut [&mut a1], &dir)?;
        let bundle = {
            let p = &a1.provider;
            a1.group.as_mut().unwrap().commit_to_pending_proposals(p, &a1.signer).map_err(s)?.0
        };
        merge_own(&mut a1)?;
        let b_seen = receive(hooks, report, &mut b1, &bundle, &dir);
        let members = a1.group.as_mut().unwrap().members().count();
        let r = if members == 1 {
            check_agreement(report, project_id, &[&a1]).map(|d| {
                format!("SelfRemove committed; B1 processed: {}; {d}", b_seen.is_ok())
            })
        } else {
            Err(format!("{members} members remain"))
        };
        report.step("B self-removal (SelfRemove)", r);
    }

    let bytes = storage_bytes(&a1.provider)?;
    report.sizes.insert("state_a1_1_member".into(), bytes.len());
    Ok(())
}

// ---------------------------------------------------------------------------
// Rejoin scenario (ADR-024 review: external Commit needs an unrevoked
// credential, a listed identity, and a rejoin PSK later than the user's
// newest revocation and role change and inside a retention window). A
// resumption PSK cannot be supplied by an external joiner (see R0), so the
// epoch secret is an exporter output carried as an external PSK.

const WINDOW: u64 = 4;
const REJOIN_LABEL: &str = "openzcad rejoin psk";
const REJOIN_PREFIX: &[u8] = b"ozc-rejoin/";

fn rejoin_psk(epoch: u64) -> Psk {
    Psk::External(ExternalPsk::new([REJOIN_PREFIX, &epoch.to_be_bytes()].concat()))
}

/// OpenMLS has no public accessor for a received proposal's PSK id, so the
/// spike re-serializes it: psktype(1) = external, then a varint-length id.
fn rejoin_psk_epoch(p: &PreSharedKeyProposal) -> Option<u64> {
    let bytes = p.tls_serialize_detached().ok()?;
    if bytes.first() != Some(&1) {
        return None;
    }
    let (len, start) = match bytes.get(1)? >> 6 {
        0 => ((bytes[1] & 0x3f) as usize, 2),
        1 => (((bytes[1] as usize & 0x3f) << 8) | *bytes.get(2)? as usize, 3),
        _ => return None,
    };
    let id = bytes.get(start..start + len)?;
    let rest = id.strip_prefix(REJOIN_PREFIX)?;
    Some(u64::from_be_bytes(rest.try_into().ok()?))
}

fn store_psk(d: &Device, psk: Psk, secret: &[u8]) -> R<()> {
    PreSharedKeyId::new(CS, d.provider.rand(), psk)
        .map_err(s)?
        .store(&d.provider, secret)
        .map_err(s)
}

fn record_psks(project_id: &[u8], devices: &mut [&mut Device]) -> R<()> {
    for d in devices.iter_mut() {
        let group = d.group.as_ref().ok_or("missing group")?;
        let epoch = group.epoch().as_u64();
        let secret = group
            .export_secret(d.provider.crypto(), REJOIN_LABEL, project_id, 32)
            .map_err(s)?;
        store_psk(d, rejoin_psk(epoch), &secret)?;
        d.saved.push((epoch, secret));
    }
    Ok(())
}

fn saved_psk(d: &Device, epoch: u64) -> R<Vec<u8>> {
    d.saved
        .iter()
        .find(|(e, _)| *e == epoch)
        .map(|(_, s)| s.clone())
        .ok_or_else(|| format!("{} holds no PSK for epoch {epoch}", d.name))
}

fn tick(
    hooks: &Hooks,
    report: &mut Report,
    project_id: &[u8],
    committer: &mut Device,
    others: &mut [&mut Device],
    dir: &Directory,
) -> R<()> {
    let msg = commit(committer)?.into_commit();
    merge_own(committer)?;
    deliver(hooks, report, &msg, others, dir)?;
    record_psks(project_id, &mut [committer])?;
    record_psks(project_id, others)
}

fn remove(
    hooks: &Hooks,
    report: &mut Report,
    owner: &mut Device,
    leaf: LeafNodeIndex,
    roles: Option<Extensions<GroupContext>>,
    others: &mut [&mut Device],
    dir: &Directory,
) -> R<MlsMessageOut> {
    let bundle = {
        let p = &owner.provider;
        let signer = &owner.signer;
        let mut b = owner.group.as_mut().unwrap().commit_builder().propose_removals([leaf]);
        if let Some(r) = roles {
            b = b.propose_group_context_extensions(r).map_err(s)?;
        }
        b.load_psks(p.storage())
            .map_err(s)?
            .build(p.rand(), p.crypto(), signer, |_| true)
            .map_err(s)?
            .stage_commit(p)
            .map_err(s)?
    };
    merge_own(owner)?;
    let msg = bundle.into_commit();
    deliver(hooks, report, &msg, others, dir)?;
    Ok(msg)
}

/// A removed device that kept its certified key, with fresh storage.
fn rejoiner(d: &Device) -> Device {
    Device {
        name: format!("{} (rejoining)", d.name),
        provider: Provider::default(),
        signer: d.signer.clone(),
        cwk: d.cwk.clone(),
        group: None,
        window: None,
        saved: Vec::new(),
    }
}

fn external_commit(
    joiner: &mut Device,
    gi: &MlsMessageOut,
    psk: Psk,
) -> R<(MlsGroup, CommitMessageBundle)> {
    let vgi = group_info_in(gi)?;
    let psk_id = PreSharedKeyId::new(CS, joiner.provider.rand(), psk).map_err(s)?;
    MlsGroup::external_commit_builder()
        .with_config(join_config())
        .build_group(&joiner.provider, vgi, joiner.cwk.clone())
        .map_err(s)?
        .leaf_node_parameters(leaf_params())
        .add_psk_proposal(PreSharedKeyProposal::new(psk_id))
        .load_psks(joiner.provider.storage())
        .map_err(s)?
        .build(joiner.provider.rand(), joiner.provider.crypto(), &joiner.signer, |_| true)
        .map_err(s)?
        .finalize(&joiner.provider)
        .map_err(s)
}

fn try_rejoin(
    hooks: &Hooks,
    report: &mut Report,
    joiner: &mut Device,
    psk_epoch: u64,
    secret: Vec<u8>,
    gi: &MlsMessageOut,
    receivers: &mut [&mut Device],
    dir: &Directory,
) -> R<Result<(), String>> {
    store_psk(joiner, rejoin_psk(psk_epoch), &secret)?;
    let (group, bundle) = match external_commit(joiner, gi, rejoin_psk(psk_epoch)) {
        Ok(x) => x,
        Err(e) => return Ok(Err(format!("joiner could not build: {e}"))),
    };
    let msg = bundle.into_commit();
    for r in receivers.iter_mut() {
        if let Err(e) = receive(hooks, report, r, &msg, dir) {
            return Ok(Err(e));
        }
    }
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

fn gi_of(d: &mut Device) -> R<MlsMessageOut> {
    let p = &d.provider;
    d.group.as_mut().unwrap().export_group_info(p.crypto(), &d.signer, true).map_err(s)
}

#[wasm_bindgen]
pub async fn run_rejoin_scenario(project_id: String, hooks: JsValue) -> Result<String, JsValue> {
    let hooks = Hooks { obj: hooks };
    let mut report = Report {
        library: "openmls",
        version: "0.9.1",
        crypto: "openmls_rust_crypto 0.6.0 (RustCrypto, compiled to WASM)",
        cipher_suite: 2,
        ..Default::default()
    };
    if let Err(e) = rejoin_scenario(&hooks, &mut report, project_id.as_bytes()).await {
        report.step("aborted", Err(e));
    }
    serde_json::to_string(&report).map_err(|e| JsValue::from_str(&e.to_string()))
}

async fn rejoin_scenario(hooks: &Hooks, report: &mut Report, project_id: &[u8]) -> R<()> {
    let mut dir = Directory::default();
    let w = Some(WINDOW);
    let new = |user: &str, dev: &str, dir: &mut Directory| -> R<Device> {
        let mut d = new_device(user, dev, dir, true)?;
        d.window = w;
        Ok(d)
    };
    let create = |d: &mut Device, id: &[u8], roles: Extensions<GroupContext>| -> R<()> {
        d.group = Some(
            MlsGroup::builder()
                .with_group_id(GroupId::from_slice(id))
                .ciphersuite(CS)
                .use_ratchet_tree_extension(true)
                .with_wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
                .max_past_epochs(3)
                .with_capabilities(capabilities())
                .with_group_context_extensions(roles)
                .build(&d.provider, &d.signer, d.cwk.clone())
                .map_err(s)?,
        );
        Ok(())
    };

    // R1. A wiped sole member rejoins from its saved PSK. -------------------
    {
        let mut s1 = new("A", "S1", &mut dir)?;
        create(&mut s1, &[b"solo:".as_slice(), project_id].concat(), roles_ext_since(&[("A", Role::Owner, 0)])?)?;
        commit(&mut s1)?;
        merge_own(&mut s1)?;
        record_psks(project_id, &mut [&mut s1])?;
        let epoch = s1.group.as_ref().unwrap().epoch().as_u64();
        let old_leaf = s1.group.as_ref().unwrap().own_leaf_index();
        let gi = gi_of(&mut s1)?;
        let psk = hooks.persist("openmls/rejoin-psk", &saved_psk(&s1, epoch)?).await?;
        drop(s1);
        let mut s2 = new("A", "S1", &mut dir)?;
        store_psk(&s2, rejoin_psk(epoch), &psk)?;
        let r = match external_commit(&mut s2, &gi, rejoin_psk(epoch)) {
            Err(e) => Err(format!("sole-member rejoin failed: {e}")),
            Ok((group, _)) => {
                s2.group = Some(group);
                let ghosts = s2.group.as_ref().unwrap().members().count();
                // OpenMLS kept the wiped leaf (different key): remove it.
                let (_, _, _) = {
                    let p = &s2.provider;
                    s2.group.as_mut().unwrap().remove_members(p, &s2.signer, &[old_leaf]).map_err(s)?
                };
                merge_own(&mut s2)?;
                Ok(format!(
                    "rejoined with PSK of epoch {epoch}; {ghosts} leaves until the stale one was removed; now epoch {}, {} member(s)",
                    s2.group.as_ref().unwrap().epoch().as_u64(),
                    s2.group.as_ref().unwrap().members().count()
                ))
            }
        };
        report.step("rejoin: wiped sole member", r);
    }

    // Shared group: A1 (owner), A2, A3, B1 (editor). -----------------------
    let mut a1 = new("A", "A1", &mut dir)?;
    let mut a2 = new("A", "A2", &mut dir)?;
    let mut a3 = new("A", "A3", &mut dir)?;
    let mut b1 = new("B", "B1", &mut dir)?;
    create(&mut a1, &[b"project:".as_slice(), project_id].concat(), roles_ext_since(&[("A", Role::Owner, 0)])?)?;
    let kps = vec![key_package(&a2)?.0, key_package(&a3)?.0, key_package(&b1)?.0];
    let bundle = {
        let p = &a1.provider;
        let signer = &a1.signer;
        a1.group
            .as_mut()
            .unwrap()
            .commit_builder()
            .propose_adds(kps)
            .propose_group_context_extensions(roles_ext_since(&[("A", Role::Owner, 0), ("B", Role::Editor, 1)])?)
            .map_err(s)?
            .load_psks(p.storage())
            .map_err(s)?
            .build(p.rand(), p.crypto(), signer, |_| true)
            .map_err(s)?
            .stage_commit(p)
            .map_err(s)?
    };
    merge_own(&mut a1)?;
    let (_, welcome, _) = bundle.into_messages();
    let welcome = welcome.ok_or("no welcome")?;
    for d in [&mut a2, &mut a3, &mut b1] {
        join(d, &welcome, &dir)?;
    }
    record_psks(project_id, &mut [&mut a1, &mut a2, &mut a3, &mut b1])?; // epoch 1
    tick(hooks, report, project_id, &mut a1, &mut [&mut a2, &mut a3, &mut b1], &dir)?; // 2

    // R0. Can an external joiner carry a resumption PSK at all?
    {
        let gi = gi_of(&mut a1)?;
        let mut probe = rejoiner(&a3);
        let gid = a1.group.as_ref().unwrap().group_id().clone();
        let psk = Psk::Resumption(ResumptionPsk::new(ResumptionPskUsage::Application, gid, 1u64.into()));
        let r = match external_commit(&mut probe, &gi, psk) {
            Ok(_) => "accepted by the joiner's builder".to_string(),
            Err(e) => format!("not possible: the joiner has no resumption secrets ({e})"),
        };
        report.step("library: resumption PSK in an external Commit", Ok(r));
    }

    // A1 removes A2 and A revokes A2's key (epoch 3).
    let leaf = a2.group.as_ref().unwrap().own_leaf_index();
    remove(hooks, report, &mut a1, leaf, None, &mut [&mut a3, &mut b1], &dir)?;
    let revoked_at = a1.group.as_ref().unwrap().epoch().as_u64();
    dir.revoke("A", a2.signer.public(), revoked_at);
    record_psks(project_id, &mut [&mut a1, &mut a3, &mut b1])?;
    tick(hooks, report, project_id, &mut a1, &mut [&mut a3, &mut b1], &dir)?; // 4
    tick(hooks, report, project_id, &mut a3, &mut [&mut a1, &mut b1], &dir)?; // 5

    // R2. Revoked device, fresh PSK: rejected for revocation only.
    {
        let now = a1.group.as_ref().unwrap().epoch().as_u64();
        let gi = gi_of(&mut a1)?;
        let mut a2x = rejoiner(&a2);
        let r = try_rejoin(hooks, report, &mut a2x, now, saved_psk(&a1, now)?, &gi, &mut [&mut a1, &mut b1], &dir);
        report.step(
            "rejoin refused: revoked device with a fresh PSK",
            expect_rejected(r, "revoked", &["window", "PSK epoch"]),
        );
    }

    // A1 removes A3 without revoking it (epoch 6).
    let leaf = a3.group.as_ref().unwrap().own_leaf_index();
    let msg = remove(hooks, report, &mut a1, leaf, None, &mut [&mut b1], &dir)?;
    let _ = receive(hooks, report, &mut a3, &msg, &dir);
    record_psks(project_id, &mut [&mut a1, &mut b1])?;

    // R3a. Unrevoked removed device, PSK from before A's newest revocation.
    {
        let gi = gi_of(&mut a1)?;
        let old = revoked_at - 1;
        let mut a3x = rejoiner(&a3);
        let r = try_rejoin(hooks, report, &mut a3x, old, saved_psk(&a3, old)?, &gi, &mut [&mut a1, &mut b1], &dir);
        report.step(
            "rejoin refused: PSK older than the user's newest revocation",
            expect_rejected(r, &format!("before newest revocation {revoked_at}"), &["revoked;", "window"]),
        );
    }

    // R3b. PSK after the revocation and inside the window: accepted.
    {
        let now = a1.group.as_ref().unwrap().epoch().as_u64();
        let gi = gi_of(&mut a1)?;
        let newest = a3.saved.last().ok_or("no saved psk")?.0;
        let mut a3x = rejoiner(&a3);
        a3x.window = w;
        let t = hooks.now();
        let r = try_rejoin(hooks, report, &mut a3x, newest, saved_psk(&a3, newest)?, &gi, &mut [&mut a1, &mut b1], &dir)?;
        report.external_commit_ms.push(hooks.now() - t);
        let r = match r {
            Ok(()) => {
                a3x.saved = std::mem::take(&mut a3.saved);
                a3 = a3x;
                record_psks(project_id, &mut [&mut a1, &mut a3, &mut b1])?;
                check_agreement(report, project_id, &[&a1, &a3, &b1])
                    .map(|d| format!("PSK of epoch {newest} at epoch {now}; {d}"))
            }
            Err(e) => Err(e),
        };
        report.step("rejoin accepted: unrevoked device, PSK inside the window", r);
    }

    // Remove A3 again, then advance past the window.
    let leaf = a3.group.as_ref().unwrap().own_leaf_index();
    let msg = remove(hooks, report, &mut a1, leaf, None, &mut [&mut b1], &dir)?;
    let _ = receive(hooks, report, &mut a3, &msg, &dir);
    record_psks(project_id, &mut [&mut a1, &mut b1])?;
    let newest = a3.saved.last().ok_or("no saved psk")?.0;
    while a1.group.as_ref().unwrap().epoch().as_u64() <= newest + WINDOW {
        tick(hooks, report, project_id, &mut a1, &mut [&mut b1], &dir)?;
    }

    // R3c. PSK after the revocation but outside the retention window.
    {
        let gi = gi_of(&mut a1)?;
        let mut a3x = rejoiner(&a3);
        let r = try_rejoin(hooks, report, &mut a3x, newest, saved_psk(&a3, newest)?, &gi, &mut [&mut a1, &mut b1], &dir);
        report.step(
            "rejoin refused: PSK outside the retention window",
            expect_rejected(r, "window", &["revoked", "revocation"]),
        );
    }

    // R4. B downgraded to viewer and B1 removed in one Commit (not revoked);
    // B1 tries to come back with a PSK from before the change.
    {
        let leaf = b1.group.as_ref().unwrap().own_leaf_index();
        let changed = a1.group.as_ref().unwrap().epoch().as_u64() + 1;
        let roles = roles_ext_since(&[("A", Role::Owner, 0), ("B", Role::Viewer, changed)])?;
        let msg = remove(hooks, report, &mut a1, leaf, Some(roles), &mut [], &dir)?;
        let _ = receive(hooks, report, &mut b1, &msg, &dir);
        record_psks(project_id, &mut [&mut a1])?;
        let gi = gi_of(&mut a1)?;
        let before = b1.saved.last().ok_or("no saved psk")?.0;
        let mut b1x = rejoiner(&b1);
        let r = try_rejoin(hooks, report, &mut b1x, before, saved_psk(&b1, before)?, &gi, &mut [&mut a1], &dir);
        report.step(
            "rejoin refused: PSK from before the member's role change",
            expect_rejected(r, &format!("before role change {changed}"), &["revoked", "not listed", "window"]),
        );
    }

    // R5. B dropped from the roles extension; PSK from before the removal.
    {
        tick(hooks, report, project_id, &mut a1, &mut [], &dir)?;
        let bundle = {
            let p = &a1.provider;
            let signer = &a1.signer;
            a1.group
                .as_mut()
                .unwrap()
                .commit_builder()
                .propose_group_context_extensions(roles_ext_since(&[("A", Role::Owner, 0)])?)
                .map_err(s)?
                .load_psks(p.storage())
                .map_err(s)?
                .build(p.rand(), p.crypto(), signer, |_| true)
                .map_err(s)?
                .stage_commit(p)
                .map_err(s)?
        };
        merge_own(&mut a1)?;
        let _ = bundle;
        record_psks(project_id, &mut [&mut a1])?;
        let gi = gi_of(&mut a1)?;
        let before = b1.saved.last().ok_or("no saved psk")?.0;
        let mut b1x = rejoiner(&b1);
        let r = try_rejoin(hooks, report, &mut b1x, before, saved_psk(&b1, before)?, &gi, &mut [&mut a1], &dir);
        report.step(
            "rejoin refused: removed member, PSK from before removal",
            expect_rejected(r, "not listed in the roles extension", &["revoked"]),
        );
    }
    report.final_epoch = a1.group.as_ref().unwrap().epoch().as_u64();
    Ok(())
}
