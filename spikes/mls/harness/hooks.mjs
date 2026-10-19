// Host hooks shared by the Node harness and the browser worker.
//
// `persist(label, bytes)` is the IndexedDB experiment: the MLS group state
// is encrypted with AES-GCM under a non-extractable device key, written,
// read back after closing the database, decrypted and handed back to the
// WASM module, which reloads the group from it. Without IndexedDB (Node) the
// same encryption runs against an in-memory map.

const DB_NAME = 'openzcad-mls-spike';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('keys');
      req.result.createObjectStore('state');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

export function createHooks() {
  const memory = new Map();
  const evidence = [];

  async function persist(label, bytes) {
    const subtle = globalThis.crypto.subtle;
    const key = await subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    let exportRefused = false;
    try {
      await subtle.exportKey('raw', key);
    } catch {
      exportRefused = true;
    }
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const aad = new TextEncoder().encode(label);
    const sealed = new Uint8Array(
      await subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad },
        key,
        bytes
      )
    );
    const t0 = performance.now();

    let readKey;
    let readSealed;
    let store = 'memory';
    if (typeof indexedDB !== 'undefined') {
      store = 'indexeddb';
      let db = await openDb();
      await idb(db, 'keys', 'readwrite', (s) => s.put(key, label));
      await idb(db, 'state', 'readwrite', (s) => s.put({ iv, sealed }, label));
      db.close();
      db = await openDb(); // read back through a fresh connection
      readKey = await idb(db, 'keys', 'readonly', (s) => s.get(label));
      const row = await idb(db, 'state', 'readonly', (s) => s.get(label));
      db.close();
      readSealed = row;
    } else {
      memory.set(label, { key, iv, sealed });
      const row = memory.get(label);
      readKey = row.key;
      readSealed = row;
    }
    const plain = new Uint8Array(
      await subtle.decrypt(
        { name: 'AES-GCM', iv: readSealed.iv, additionalData: aad },
        readKey,
        readSealed.sealed
      )
    );
    evidence.push({
      label,
      store,
      stateBytes: bytes.length,
      sealedBytes: sealed.length,
      keyExtractable: readKey.extractable,
      exportRefused,
      roundTripMs: performance.now() - t0,
      identical:
        plain.length === bytes.length && plain.every((b, i) => b === bytes[i])
    });
    return plain;
  }

  return { hooks: { now: () => performance.now(), persist }, evidence };
}

/** mls-rs-crypto-webcrypto reaches SubtleCrypto through `web_sys::window()`,
 * which is an `instanceof Window` check. Workers and Node have no Window. */
export function installWindowShim() {
  if (typeof globalThis.Window === 'undefined') {
    globalThis.Window = globalThis.constructor;
  }
}

export function summarize(report) {
  const median = (xs) => {
    if (!xs.length) return null;
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return +(
      sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    ).toFixed(2);
  };
  return {
    library: report.library,
    failedSteps: report.steps
      .filter((s) => !s.ok)
      .map((s) => `${s.name}: ${s.detail}`),
    medianMs: {
      commitCreate: median(report.commit_create_ms),
      commitProcess: median(report.commit_process_ms),
      addCommitWithWelcome: median(report.add_commit_ms),
      welcomeJoin: median(report.welcome_join_ms),
      externalCommit: median(report.external_commit_ms)
    },
    samples: {
      commitCreate: report.commit_create_ms.length,
      commitProcess: report.commit_process_ms.length,
      welcomeJoin: report.welcome_join_ms.length
    },
    sizes: report.sizes,
    epochChecks: report.epoch_checks,
    finalEpoch: report.final_epoch
  };
}
