//! In-memory stores whose contents are exported as one blob. mls-rs storage
//! callbacks cannot await IndexedDB, so the host seals and writes the whole
//! blob after each change instead (spike finding).

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use mls_rs_codec::{MlsDecode, MlsEncode, MlsSize};
use mls_rs_core::{
    group::{EpochRecord, GroupState, GroupStateStorage},
    psk::{ExternalPskId, PreSharedKey, PreSharedKeyStorage},
};
use zeroize::Zeroizing;

use crate::error::StoreError;
use crate::model::rejoin_psk_epoch;

/// Prior epochs mls-rs keeps for one group.
const EPOCH_RETENTION: usize = 3;

#[derive(Clone, Default, MlsSize, MlsEncode, MlsDecode)]
pub struct StoredEpoch {
    pub id: u64,
    pub data: Vec<u8>,
}

#[derive(Clone, Default, MlsSize, MlsEncode, MlsDecode)]
pub struct StoredGroup {
    pub group_id: Vec<u8>,
    pub state: Vec<u8>,
    pub epochs: Vec<StoredEpoch>,
}

/// Holds at most the one group this session belongs to.
#[derive(Clone, Default)]
pub struct GroupStore(pub Arc<Mutex<Option<StoredGroup>>>);

impl GroupStore {
    pub fn snapshot(&self) -> Option<StoredGroup> {
        self.0.lock().unwrap().clone()
    }

    pub fn restore(&self, group: Option<StoredGroup>) {
        *self.0.lock().unwrap() = group;
    }
}

impl GroupStateStorage for GroupStore {
    type Error = StoreError;

    fn state(&self, group_id: &[u8]) -> Result<Option<Zeroizing<Vec<u8>>>, Self::Error> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .as_ref()
            .filter(|g| g.group_id == group_id)
            .map(|g| Zeroizing::new(g.state.clone())))
    }

    fn epoch(&self, group_id: &[u8], epoch_id: u64) -> Result<Option<Zeroizing<Vec<u8>>>, Self::Error> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .as_ref()
            .filter(|g| g.group_id == group_id)
            .and_then(|g| {
                g.epochs
                    .iter()
                    .find(|e| e.id == epoch_id)
                    .map(|e| Zeroizing::new(e.data.clone()))
            }))
    }

    fn write(
        &mut self,
        state: GroupState,
        inserts: Vec<EpochRecord>,
        updates: Vec<EpochRecord>,
    ) -> Result<(), Self::Error> {
        let mut slot = self.0.lock().unwrap();
        if slot.as_ref().is_some_and(|g| g.group_id != state.id) {
            return Err(StoreError("a session holds exactly one group".into()));
        }
        let group = slot.get_or_insert_with(|| StoredGroup {
            group_id: state.id.clone(),
            ..Default::default()
        });
        group.state = state.data.to_vec();
        for update in updates {
            if let Some(e) = group.epochs.iter_mut().find(|e| e.id == update.id) {
                e.data = update.data.to_vec();
            }
        }
        for insert in inserts {
            group.epochs.push(StoredEpoch {
                id: insert.id,
                data: insert.data.to_vec(),
            });
        }
        while group.epochs.len() > EPOCH_RETENTION {
            group.epochs.remove(0);
        }
        Ok(())
    }

    fn max_epoch_id(&self, group_id: &[u8]) -> Result<Option<u64>, Self::Error> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .as_ref()
            .filter(|g| g.group_id == group_id)
            .and_then(|g| g.epochs.iter().map(|e| e.id).max()))
    }
}

/// Rejoin PSKs by epoch. Only `ozc-rejoin/<epoch>` ids resolve.
#[derive(Clone, Default)]
pub struct PskStore(pub Arc<Mutex<BTreeMap<u64, Zeroizing<Vec<u8>>>>>);

impl PskStore {
    /// Keep `epoch` and the `window` epochs before it; drop older ones.
    pub fn insert(&self, epoch: u64, secret: Vec<u8>, window: u64) {
        let mut map = self.0.lock().unwrap();
        map.insert(epoch, Zeroizing::new(secret));
        let newest = *map.keys().next_back().unwrap_or(&epoch);
        map.retain(|e, _| e.saturating_add(window) >= newest);
    }

    pub fn get_epoch(&self, epoch: u64) -> Option<Vec<u8>> {
        self.0.lock().unwrap().get(&epoch).map(|s| s.to_vec())
    }

    pub fn entries(&self) -> Vec<StoredEpoch> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|(id, data)| StoredEpoch {
                id: *id,
                data: data.to_vec(),
            })
            .collect()
    }

    pub fn restore(&self, entries: Vec<StoredEpoch>) {
        *self.0.lock().unwrap() = entries.into_iter().map(|e| (e.id, Zeroizing::new(e.data))).collect();
    }
}

impl PreSharedKeyStorage for PskStore {
    type Error = StoreError;

    fn get(&self, id: &ExternalPskId) -> Result<Option<PreSharedKey>, Self::Error> {
        Ok(rejoin_psk_epoch(id)
            .and_then(|epoch| self.get_epoch(epoch))
            .map(PreSharedKey::new))
    }
}
