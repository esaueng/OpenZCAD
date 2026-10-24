//! OpenZCAD's MLS group-key layer (ADR-024, "MLS assessment"): mls-rs 0.56
//! with the RustCrypto provider on cipher suite 0x0002, compiled to WASM and
//! driven from a module Worker by `@openzcad/mls`.
//!
//! Structured results cross the boundary as JSON with bytes in hex; raw
//! messages and state cross as `Uint8Array`. Errors are JS `Error`s with
//! `kind` (`policy`, `mls`, `state`, `input`) and, for policy refusals,
//! `reasons`, each with a stable `code`.

mod archive;
mod directory;
mod error;
mod model;
mod policy;
mod session;
mod storage;

use std::sync::Arc;

use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::directory::DeviceDirectory;
use crate::error::Error;
use crate::session::{CommitSpec, Session};

fn to_js(error: Error) -> JsValue {
    let js = js_sys::Error::new(&error.message);
    js.set_name("MlsError");
    let _ = js_sys::Reflect::set(&js, &"kind".into(), &error.kind.into());
    let reasons = serde_json::to_string(&error.reasons).unwrap_or_else(|_| "[]".into());
    let _ = js_sys::Reflect::set(&js, &"reasonsJson".into(), &reasons.into());
    js.into()
}

fn json<T: Serialize>(value: &T) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(|e| to_js(Error::state(e.to_string())))
}

/// Versions compiled into this module, for diagnostics and the review.
#[wasm_bindgen(js_name = buildInfo)]
pub fn build_info() -> String {
    format!(
        "{{\"crate\":\"openzcad-mls {}\",\"mls\":\"mls-rs 0.56.0\",\"crypto\":\"mls-rs-crypto-rustcrypto 0.22.1\",\"cipherSuite\":2}}",
        env!("CARGO_PKG_VERSION")
    )
}

/// The bytes a device signs to certify a leaf key, for verifying other
/// members' leaves.
#[wasm_bindgen(js_name = leafCertificationPayload)]
pub fn leaf_certification_payload(
    project_id: &str,
    user_id: &str,
    device_id: &str,
    signature_key: &[u8],
) -> Result<Vec<u8>, JsValue> {
    model::certification_payload(
        project_id.as_bytes(),
        user_id.as_bytes(),
        device_id.as_bytes(),
        signature_key,
    )
    .map_err(to_js)
}

#[wasm_bindgen(js_name = rejoinPskId)]
pub fn rejoin_psk_id(epoch: u64) -> Vec<u8> {
    model::rejoin_psk_id(epoch).to_vec()
}

/// Decode a history-archive epoch record (see `EpochRecordV1`).
#[wasm_bindgen(js_name = decodeEpochRecord)]
pub fn decode_epoch_record(bytes: &[u8]) -> Result<String, JsValue> {
    use mls_rs_codec::MlsDecode;
    let mut input = bytes;
    let record = session::EpochRecordV1::mls_decode(&mut input).map_err(|e| to_js(Error::codec(e)))?;
    if !input.is_empty() || record.version != 1 {
        return Err(to_js(Error::input("not a version 1 epoch record")));
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Out {
        version: u8,
        epoch: u64,
        group_context: String,
        ratchet_tree: String,
        commit: String,
        proposals: Vec<String>,
    }
    json(&Out {
        version: record.version,
        epoch: record.epoch,
        group_context: hex::encode(&record.group_context),
        ratchet_tree: hex::encode(&record.ratchet_tree),
        commit: hex::encode(&record.commit),
        proposals: record.proposals.iter().map(hex::encode).collect(),
    })
}

#[wasm_bindgen]
pub struct MlsSession {
    inner: Session,
}

#[wasm_bindgen]
impl MlsSession {
    /// A fresh per-project leaf signing key for this device. It must be
    /// certified before it can create, join or rejoin a group.
    pub fn generate(project_id: &str, user_id: &str, device_id: &str) -> Result<MlsSession, JsValue> {
        Session::generate(project_id.as_bytes(), user_id.as_bytes(), device_id.as_bytes())
            .map(|inner| MlsSession { inner })
            .map_err(to_js)
    }

    /// Restore an exported session (the caller has already unsealed it).
    pub fn import(state: &[u8], project_id: &str) -> Result<MlsSession, JsValue> {
        Session::import(state, project_id.as_bytes())
            .map(|inner| MlsSession { inner })
            .map_err(to_js)
    }

    pub fn export(&mut self) -> Result<Vec<u8>, JsValue> {
        self.inner.export().map_err(to_js)
    }

    #[wasm_bindgen(js_name = signatureKey)]
    pub fn signature_key(&self) -> Vec<u8> {
        self.inner.signature_key()
    }

    #[wasm_bindgen(js_name = certificationPayload)]
    pub fn certification_payload(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.certification_payload().map_err(to_js)
    }

    pub fn certify(&mut self, certification: &[u8]) -> Result<(), JsValue> {
        self.inner.certify(certification).map_err(to_js)
    }

    /// Replace the verified device directory (JSON, see `DeviceDirectory`).
    #[wasm_bindgen(js_name = setDirectory)]
    pub fn set_directory(&self, directory_json: &str) -> Result<(), JsValue> {
        let directory = DeviceDirectory::from_json(directory_json).map_err(to_js)?;
        self.inner.policy.directory.set(Arc::new(directory));
        Ok(())
    }

    #[wasm_bindgen(js_name = createGroup)]
    pub fn create_group(&mut self, rejoin_window: u32) -> Result<String, JsValue> {
        json(&self.inner.create_group(rejoin_window).map_err(to_js)?)
    }

    #[wasm_bindgen(js_name = keyPackage)]
    pub fn key_package(&mut self) -> Result<Vec<u8>, JsValue> {
        let out = self.inner.key_package().map_err(to_js)?;
        Ok(out)
    }

    #[wasm_bindgen(js_name = inspectWelcome)]
    pub fn inspect_welcome(&self, welcome: &[u8]) -> Result<String, JsValue> {
        json(&self.inner.inspect_welcome(welcome).map_err(to_js)?)
    }

    pub fn join(
        &mut self,
        welcome: &[u8],
        initial_group_info: &[u8],
        records: Vec<js_sys::Uint8Array>,
    ) -> Result<String, JsValue> {
        let records: Vec<_> = records.iter().map(|r| r.to_vec()).collect();
        json(&self.inner.join(welcome, initial_group_info, &records).map_err(to_js)?)
    }

    #[wasm_bindgen(js_name = beginJoin)]
    pub fn begin_join(&mut self, welcome: &[u8]) -> Result<(), JsValue> {
        self.inner.begin_join(welcome).map_err(to_js)
    }

    #[wasm_bindgen(js_name = completeJoin)]
    pub fn complete_join(
        &mut self,
        initial_group_info: &[u8],
        records: Vec<js_sys::Uint8Array>,
    ) -> Result<String, JsValue> {
        let records: Vec<_> = records.iter().map(|r| r.to_vec()).collect();
        json(&self.inner.complete_join(initial_group_info, &records).map_err(to_js)?)
    }

    #[wasm_bindgen(js_name = discardJoin)]
    pub fn discard_join(&mut self) -> Result<(), JsValue> {
        self.inner.discard_join().map_err(to_js)
    }

    #[wasm_bindgen(js_name = archiveKey)]
    pub fn archive_key(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.archive_key().map_err(to_js)
    }

    /// `spec_json`: `{ remove?, setRoles?, dropUsers?, rejoinWindow? }`.
    pub fn commit(&mut self, spec_json: &str, key_packages: Vec<js_sys::Uint8Array>) -> Result<String, JsValue> {
        let spec: CommitSpec =
            serde_json::from_str(spec_json).map_err(|e| to_js(Error::input(format!("commit spec: {e}"))))?;
        let key_packages = key_packages.iter().map(|k| k.to_vec()).collect();
        json(&self.inner.commit(spec, key_packages).map_err(to_js)?)
    }

    #[wasm_bindgen(js_name = confirmCommit)]
    pub fn confirm_commit(&mut self) -> Result<String, JsValue> {
        json(&self.inner.confirm_commit().map_err(to_js)?)
    }

    #[wasm_bindgen(js_name = discardCommit)]
    pub fn discard_commit(&mut self) -> Result<(), JsValue> {
        self.inner.discard_commit().map_err(to_js)
    }

    #[wasm_bindgen(js_name = proposeAdd)]
    pub fn propose_add(&mut self, key_package: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.inner.propose_add(key_package).map_err(to_js)
    }

    #[wasm_bindgen(js_name = proposeUpdate)]
    pub fn propose_update(&mut self) -> Result<Vec<u8>, JsValue> {
        self.inner.propose_update().map_err(to_js)
    }

    #[wasm_bindgen(js_name = proposeSelfRemove)]
    pub fn propose_self_remove(&mut self) -> Result<Vec<u8>, JsValue> {
        self.inner.propose_self_remove().map_err(to_js)
    }

    pub fn process(&mut self, message: &[u8]) -> Result<String, JsValue> {
        json(&self.inner.process(message).map_err(to_js)?)
    }

    #[wasm_bindgen(js_name = groupInfo)]
    pub fn group_info(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.group_info().map_err(to_js)
    }

    #[wasm_bindgen(js_name = inspectGroupInfo)]
    pub fn inspect_group_info(&self, group_info: &[u8]) -> Result<String, JsValue> {
        json(&self.inner.inspect_group_info(group_info).map_err(to_js)?)
    }

    /// `remove`: a stale leaf of this user to replace in the same Commit.
    pub fn rejoin(
        &mut self,
        group_info: &[u8],
        psk_epoch: u64,
        psk: &[u8],
        remove: Option<u32>,
        initial_group_info: &[u8],
        records: Vec<js_sys::Uint8Array>,
    ) -> Result<String, JsValue> {
        let records: Vec<_> = records.iter().map(|r| r.to_vec()).collect();
        json(
            &self
                .inner
                .rejoin(group_info, psk_epoch, psk, remove, initial_group_info, &records)
                .map_err(to_js)?,
        )
    }

    #[wasm_bindgen(js_name = beginRejoin)]
    pub fn begin_rejoin(
        &mut self,
        group_info: &[u8],
        psk_epoch: u64,
        psk: &[u8],
        remove: Option<u32>,
    ) -> Result<String, JsValue> {
        json(
            &self
                .inner
                .begin_rejoin(group_info, psk_epoch, psk, remove)
                .map_err(to_js)?,
        )
    }

    #[wasm_bindgen(js_name = completeRejoin)]
    pub fn complete_rejoin(
        &mut self,
        initial_group_info: &[u8],
        records: Vec<js_sys::Uint8Array>,
    ) -> Result<(), JsValue> {
        let records: Vec<_> = records.iter().map(|r| r.to_vec()).collect();
        self.inner.complete_rejoin(initial_group_info, &records).map_err(to_js)
    }

    /// The room accepted the external Commit.
    #[wasm_bindgen(js_name = confirmRejoin)]
    pub fn confirm_rejoin(&mut self) -> Result<(), JsValue> {
        self.inner.confirm_rejoin().map_err(to_js)
    }

    /// Another Commit won the epoch: restore the session as before the rejoin.
    #[wasm_bindgen(js_name = discardRejoin)]
    pub fn discard_rejoin(&mut self) -> Result<(), JsValue> {
        self.inner.discard_rejoin().map_err(to_js)
    }

    pub fn status(&self) -> Result<String, JsValue> {
        json(&self.inner.status().map_err(to_js)?)
    }

    #[wasm_bindgen(js_name = projectKey)]
    pub fn project_key(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.project_key().map_err(to_js)
    }

    #[wasm_bindgen(js_name = epochAuthenticator)]
    pub fn epoch_authenticator(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.epoch_authenticator().map_err(to_js)
    }

    #[wasm_bindgen(js_name = rejoinPsk)]
    pub fn rejoin_psk(&self) -> Result<String, JsValue> {
        json(&self.inner.rejoin_psk().map_err(to_js)?)
    }

    /// Test hook: stop this client checking its own outgoing Commits, so a
    /// test can prove that receivers refuse them. Receivers always check.
    #[wasm_bindgen(js_name = insecureSkipSendChecksForTests)]
    pub fn insecure_skip_send_checks_for_tests(&self, skip: bool) {
        self.inner.set_skip_send_checks(skip);
    }
}
