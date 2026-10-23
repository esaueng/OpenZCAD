//! Device keys for the OpenZCAD desktop app (ADR-024, "Unlock and devices").
//!
//! Each desktop device has an ECDSA P-256 signing key and an ECDH P-256 unlock
//! key. They are created here, kept in a [`SecretStore`] (the macOS Keychain in
//! the app, next to the refresh credential), and used only through [`sign`]
//! and [`derive`]: the renderer receives public keys, signatures and ECDH
//! secrets, never the private key bytes. Browsers keep non-extractable
//! WebCrypto keys instead; `@openzcad/crypto` accepts either form.
//!
//! The wire formats match WebCrypto exactly, so the web code verifies and
//! derives the same way for both: public keys are 65-byte uncompressed SEC1
//! points, signatures are the 64-byte IEEE P1363 `r || s` over SHA-256 of the
//! message, and an ECDH secret is the 32-byte x-coordinate.

use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};

/// Bytes of an uncompressed P-256 public key.
pub const PUBLIC_KEY_BYTES: usize = 65;
const SECRET_KEY_BYTES: usize = 32;
const KEY_ID_PREFIX: &str = "dk_";
const KEY_ID_HEX_BYTES: usize = 16;
/// Messages the renderer asks to sign are statements and envelope digests,
/// a few kilobytes at most; refuse anything absurd before hashing it.
const MAX_MESSAGE_BYTES: usize = 1 << 20;

/// Where the private halves live. Implementations must keep them on this
/// device only; the app uses the macOS Keychain.
pub trait SecretStore {
    fn put(&self, account: &str, secret: &[u8]) -> Result<(), String>;
    fn get(&self, account: &str) -> Result<Option<Vec<u8>>, String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// What the renderer learns about a newly created device key pair.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceKeyPublics {
    pub key_id: String,
    pub signing_public_key: Vec<u8>,
    pub unlock_public_key: Vec<u8>,
}

/// Fills a buffer with cryptographically secure random bytes.
pub type FillRandom<'a> = &'a mut dyn FnMut(&mut [u8]) -> Result<(), String>;

fn signing_account(key_id: &str) -> String {
    format!("{key_id}.signing")
}

fn unlock_account(key_id: &str) -> String {
    format!("{key_id}.unlock")
}

/// A key id is `dk_` and 32 lowercase hex digits: it names Keychain entries,
/// so nothing else may reach the store from the renderer.
pub fn is_key_id(value: &str) -> bool {
    value.strip_prefix(KEY_ID_PREFIX).is_some_and(|hex| {
        hex.len() == KEY_ID_HEX_BYTES * 2
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

fn checked_key_id(key_id: &str) -> Result<&str, String> {
    if is_key_id(key_id) {
        Ok(key_id)
    } else {
        Err("Invalid device key id.".to_string())
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A uniformly random valid scalar: candidates outside `[1, n)` are redrawn,
/// which happens with probability about 2^-32.
fn random_secret(fill_random: FillRandom<'_>) -> Result<SecretKey, String> {
    for _ in 0..64 {
        let mut bytes = [0u8; SECRET_KEY_BYTES];
        fill_random(&mut bytes)?;
        let candidate = SecretKey::from_slice(&bytes);
        bytes.fill(0);
        if let Ok(secret) = candidate {
            return Ok(secret);
        }
    }
    Err("Could not generate a device key.".to_string())
}

fn public_bytes(secret: &SecretKey) -> Vec<u8> {
    secret
        .public_key()
        .to_encoded_point(false)
        .as_bytes()
        .to_vec()
}

fn load_secret(store: &dyn SecretStore, account: &str) -> Result<SecretKey, String> {
    let mut bytes = store
        .get(account)?
        .ok_or_else(|| "This device's key is not in the Keychain.".to_string())?;
    let secret = SecretKey::from_slice(&bytes);
    bytes.fill(0);
    secret.map_err(|_| "This device's stored key is damaged.".to_string())
}

/// Creates a signing and an unlock key, stores both, and returns their
/// public halves under a fresh key id. If the second write fails the first is
/// removed, so a failed creation leaves nothing behind.
pub fn create(
    store: &dyn SecretStore,
    fill_random: FillRandom<'_>,
) -> Result<DeviceKeyPublics, String> {
    let mut id = [0u8; KEY_ID_HEX_BYTES];
    fill_random(&mut id)?;
    let key_id = format!("{KEY_ID_PREFIX}{}", hex(&id));
    let signing = random_secret(fill_random)?;
    let unlock = random_secret(fill_random)?;
    let mut signing_bytes = signing.to_bytes();
    let stored = store.put(&signing_account(&key_id), &signing_bytes);
    signing_bytes.fill(0);
    stored?;
    let mut unlock_bytes = unlock.to_bytes();
    let stored = store.put(&unlock_account(&key_id), &unlock_bytes);
    unlock_bytes.fill(0);
    if let Err(error) = stored {
        let _ = store.delete(&signing_account(&key_id));
        return Err(error);
    }
    Ok(DeviceKeyPublics {
        signing_public_key: public_bytes(&signing),
        unlock_public_key: public_bytes(&unlock),
        key_id,
    })
}

/// Signs `message` with the device signing key: ECDSA P-256 over SHA-256,
/// returned as the 64-byte `r || s` WebCrypto produces and verifies.
pub fn sign(store: &dyn SecretStore, key_id: &str, message: &[u8]) -> Result<Vec<u8>, String> {
    let key_id = checked_key_id(key_id)?;
    if message.len() > MAX_MESSAGE_BYTES {
        return Err("The message to sign is too large.".to_string());
    }
    let secret = load_secret(store, &signing_account(key_id))?;
    let signature: Signature = SigningKey::from(&secret).sign(message);
    Ok(signature.to_bytes().to_vec())
}

/// The 32-byte ECDH secret between the device unlock key and `peer`, a
/// 65-byte uncompressed P-256 public key, as WebCrypto's `deriveBits` returns.
pub fn derive(store: &dyn SecretStore, key_id: &str, peer: &[u8]) -> Result<Vec<u8>, String> {
    let key_id = checked_key_id(key_id)?;
    if peer.len() != PUBLIC_KEY_BYTES || peer[0] != 0x04 {
        return Err("Expected an uncompressed P-256 public key.".to_string());
    }
    let peer = PublicKey::from_sec1_bytes(peer)
        .map_err(|_| "The peer public key is not on P-256.".to_string())?;
    let secret = load_secret(store, &unlock_account(key_id))?;
    let shared = p256::ecdh::diffie_hellman(secret.to_nonzero_scalar(), peer.as_affine());
    Ok(shared.raw_secret_bytes().to_vec())
}

/// Removes both keys. Deleting keys that are already gone succeeds.
pub fn delete(store: &dyn SecretStore, key_id: &str) -> Result<(), String> {
    let key_id = checked_key_id(key_id)?;
    let signing = store.delete(&signing_account(key_id));
    let unlock = store.delete(&unlock_account(key_id));
    signing.and(unlock)
}

/// The macOS Keychain, as generic passwords under the app's own service and
/// beside its refresh credential. Entries do not sync off this Mac.
#[cfg(target_os = "macos")]
pub struct Keychain;

#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "app.esau.openzcad.device-keys";

#[cfg(target_os = "macos")]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

#[cfg(target_os = "macos")]
impl SecretStore for Keychain {
    fn put(&self, account: &str, secret: &[u8]) -> Result<(), String> {
        use security_framework::passwords::{set_generic_password_options, PasswordOptions};
        let mut options = PasswordOptions::new_generic_password(KEYCHAIN_SERVICE, account);
        options.set_access_synchronized(Some(false));
        set_generic_password_options(secret, options)
            .map_err(|_| "OpenZCAD could not save its device key to the Keychain.".to_string())
    }

    fn get(&self, account: &str) -> Result<Option<Vec<u8>>, String> {
        use security_framework::passwords::get_generic_password;
        match get_generic_password(KEYCHAIN_SERVICE, account) {
            Ok(secret) => Ok(Some(secret)),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(_) => Err("OpenZCAD could not read its device key from the Keychain.".to_string()),
        }
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        use security_framework::passwords::delete_generic_password;
        match delete_generic_password(KEYCHAIN_SERVICE, account) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(_) => {
                Err("OpenZCAD could not remove its device key from the Keychain.".to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Verifier;
    use p256::ecdsa::VerifyingKey;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryStore {
        secrets: RefCell<HashMap<String, Vec<u8>>>,
        fail_account: Option<String>,
    }

    impl SecretStore for MemoryStore {
        fn put(&self, account: &str, secret: &[u8]) -> Result<(), String> {
            if self.fail_account.as_deref() == Some(account) {
                return Err("store failed".to_string());
            }
            self.secrets
                .borrow_mut()
                .insert(account.to_string(), secret.to_vec());
            Ok(())
        }
        fn get(&self, account: &str) -> Result<Option<Vec<u8>>, String> {
            Ok(self.secrets.borrow().get(account).cloned())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.secrets.borrow_mut().remove(account);
            Ok(())
        }
    }

    /// Deterministic bytes for tests only; the app passes `getrandom`.
    fn counter_random() -> impl FnMut(&mut [u8]) -> Result<(), String> {
        // xorshift64: deterministic and non-repeating over these few bytes.
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        move |buffer: &mut [u8]| {
            for byte in buffer.iter_mut() {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                *byte = state as u8;
            }
            Ok(())
        }
    }

    fn created(store: &MemoryStore) -> DeviceKeyPublics {
        create(store, &mut counter_random()).expect("create")
    }

    #[test]
    fn creates_keys_whose_private_halves_stay_in_the_store() {
        let store = MemoryStore::default();
        let keys = created(&store);
        assert!(is_key_id(&keys.key_id));
        assert_eq!(keys.signing_public_key.len(), PUBLIC_KEY_BYTES);
        assert_eq!(keys.unlock_public_key.len(), PUBLIC_KEY_BYTES);
        assert_ne!(keys.signing_public_key, keys.unlock_public_key);
        let secrets = store.secrets.borrow();
        assert_eq!(secrets.len(), 2);
        for secret in secrets.values() {
            assert_eq!(secret.len(), SECRET_KEY_BYTES);
        }
    }

    #[test]
    fn signs_p1363_signatures_the_public_key_verifies() {
        let store = MemoryStore::default();
        let keys = created(&store);
        let message = b"v1 device approval grant signature";
        let signature = sign(&store, &keys.key_id, message).expect("sign");
        assert_eq!(signature.len(), 64);
        let verifying = VerifyingKey::from_sec1_bytes(&keys.signing_public_key).unwrap();
        let parsed = Signature::from_slice(&signature).unwrap();
        assert!(verifying.verify(message, &parsed).is_ok());
        assert!(verifying.verify(b"another message", &parsed).is_err());
    }

    #[test]
    fn derives_the_same_secret_from_both_sides() {
        let store = MemoryStore::default();
        let keys = created(&store);
        let peer = random_secret(&mut counter_random()).unwrap();
        let peer_public = public_bytes(&peer);
        let ours = derive(&store, &keys.key_id, &peer_public).expect("derive");
        let device_public = PublicKey::from_sec1_bytes(&keys.unlock_public_key).unwrap();
        let theirs =
            p256::ecdh::diffie_hellman(peer.to_nonzero_scalar(), device_public.as_affine());
        assert_eq!(ours.len(), 32);
        assert_eq!(ours[..], theirs.raw_secret_bytes()[..]);
    }

    #[test]
    fn refuses_bad_ids_peers_and_missing_keys() {
        let store = MemoryStore::default();
        let keys = created(&store);
        for id in [
            "",
            "dk_",
            "dk_XYZ",
            "../dk_00",
            "dk_0123456789abcdef0123456789ABCDEF",
        ] {
            assert!(sign(&store, id, b"m").is_err(), "{id}");
            assert!(derive(&store, id, &keys.unlock_public_key).is_err(), "{id}");
            assert!(delete(&store, id).is_err(), "{id}");
        }
        let mut compressed = keys.unlock_public_key.clone();
        compressed[0] = 0x02;
        assert!(derive(&store, &keys.key_id, &compressed[..33]).is_err());
        let mut off_curve = keys.unlock_public_key.clone();
        off_curve[64] ^= 1;
        assert!(derive(&store, &keys.key_id, &off_curve).is_err());
        assert!(sign(&store, &keys.key_id, &vec![0u8; MAX_MESSAGE_BYTES + 1]).is_err());
        delete(&store, &keys.key_id).expect("delete");
        assert!(store.secrets.borrow().is_empty());
        assert!(sign(&store, &keys.key_id, b"m").is_err());
        assert!(derive(&store, &keys.key_id, &keys.unlock_public_key).is_err());
        delete(&store, &keys.key_id).expect("delete twice");
    }

    #[test]
    fn a_failed_creation_leaves_nothing_behind() {
        let mut random = counter_random();
        let mut probe = [0u8; KEY_ID_HEX_BYTES];
        random(&mut probe).unwrap();
        let key_id = format!("{KEY_ID_PREFIX}{}", hex(&probe));
        let store = MemoryStore {
            fail_account: Some(unlock_account(&key_id)),
            ..MemoryStore::default()
        };
        assert!(create(&store, &mut counter_random()).is_err());
        assert!(store.secrets.borrow().is_empty());
    }

    /// Computed with WebCrypto in Node: the formats here must be exactly the
    /// ones the web code imports, verifies and derives with.
    #[test]
    fn matches_webcrypto() {
        fn bytes(hex: &str) -> Vec<u8> {
            (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                .collect()
        }
        let signing = SecretKey::from_slice(&[0x11; 32]).unwrap();
        let unlock = SecretKey::from_slice(&[0x22; 32]).unwrap();
        assert_eq!(
            public_bytes(&signing),
            bytes("040217e617f0b6443928278f96999e69a23a4f2c152bdf6d6cdf66e5b80282d4ed194a7debcb97712d2dda3ca85aa8765a56f45fc758599652f2897c65306e5794")
        );
        assert_eq!(
            public_bytes(&unlock),
            bytes("04d65a93977caa3d1b081852ff57a79e465f1660577304baead505dd3a48589cf350185e895372df6221ea3a137557e473fddb6755f05bd507c3c533fce9c91285")
        );
        let key_id = format!("{KEY_ID_PREFIX}{}", "ab".repeat(KEY_ID_HEX_BYTES));
        let store = MemoryStore::default();
        store
            .put(&signing_account(&key_id), &signing.to_bytes())
            .unwrap();
        store
            .put(&unlock_account(&key_id), &unlock.to_bytes())
            .unwrap();
        let peer = bytes("0451a7580833898ea1b183cbd7350a4099078c6ef1c1e18e970cd7683035f25e7d0110522712b0b5a7cff081685486984a94e6831edac46e7360fa9d834a7a81a1");
        assert_eq!(
            derive(&store, &key_id, &peer).unwrap(),
            bytes("5f1c591a4bba11bee0d5a2a642eef6385d59aab8d6a6f151d8d857e2e822a67f")
        );
        let message = b"openzcad keychain vector";
        let webcrypto = Signature::from_slice(&bytes("017c37f8f73e22540ac3a2c5b9bf9016679720328b1e16816e980121594ba5e57329e0aed2b083af35a593dcc171657772f99689a87e21d16160789c8b6cdd82")).unwrap();
        let verifying = *SigningKey::from(&signing).verifying_key();
        assert!(verifying.verify(message, &webcrypto).is_ok());
        let ours = Signature::from_slice(&sign(&store, &key_id, message).unwrap()).unwrap();
        assert!(verifying.verify(message, &ours).is_ok());
    }

    #[test]
    fn random_failures_surface() {
        let store = MemoryStore::default();
        let mut failing = |_: &mut [u8]| Err::<(), String>("no entropy".to_string());
        assert_eq!(create(&store, &mut failing), Err("no entropy".to_string()));
        assert!(store.secrets.borrow().is_empty());
    }
}
