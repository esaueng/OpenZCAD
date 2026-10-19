/**
 * End-to-end encryption primitives for ADR-024 (roadmap L11, Phase 2).
 * WebCrypto only: runs in browsers, Web Workers, the Tauri WKWebView and
 * Node 20+. Nothing in the application imports this package yet.
 *
 * Test-only entry points that inject keys or randomness (`…With`,
 * `envelopeKeyFromBytes`) live in the modules and are deliberately not
 * exported here.
 */
export { E2eeError, isE2eeError, type E2eeErrorCode } from './errors';
export {
  fromBase64Url,
  fromHex,
  toBase64Url,
  toHex,
  type Bytes
} from './bytes';
export {
  KEY_BYTES,
  generateSymmetricKey,
  type KeyMaterial
} from './primitives';
export {
  COMPRESSIONS,
  CONTENT_BLOB_KINDS,
  DEFAULT_CHUNK_SIZE,
  ENVELOPE_VERSION_1,
  MAX_BLOB_IDS,
  MAX_CHUNK_SIZE,
  MAX_ID_BYTES,
  MIN_CHUNK_SIZE,
  PLAINTEXT_CEILINGS,
  PROJECT_ENVELOPE_KINDS,
  type Compression,
  type ContentBlobHeader,
  type ContentBlobKind,
  type EnvelopeHeader,
  type EnvelopePrefix,
  type ProjectEnvelopeHeader,
  type ProjectEnvelopeHeaderInit,
  type ProjectEnvelopeKind
} from './header';
export {
  EnvelopeKey,
  checkBlobReferences,
  contentBlobReference,
  contentBlobReferenceFromJson,
  contentBlobReferenceToJson,
  createContentBlobReader,
  createContentBlobWriter,
  decryptContentBlob,
  decryptContentBlobStream,
  decryptProjectEnvelope,
  encryptContentBlob,
  encryptContentBlobStream,
  encryptProjectEnvelope,
  decodePayload,
  envelopeBodyLength,
  parseEnvelope,
  plaintextCap,
  type ContentBlobEncryptStream,
  type ContentBlobOptions,
  type ContentBlobWriterOptions,
  type ContentBlobReference,
  type ContentBlobReferenceJson,
  type DecryptProjectEnvelopeOptions,
  type EnvelopeReader,
  type EnvelopeShape,
  type EnvelopeWriter,
  type PayloadLimits,
  type ProjectEnvelopeExpectation,
  type ReadOptions
} from './envelope';
export {
  DEFAULT_MAX_PLAINTEXT_BYTES,
  gunzipBytes,
  gzipBytes
} from './compression';
export {
  PASSKEY_PRF_INPUT,
  exportPrivateKey,
  exportPublicKey,
  generateDeviceUnlockKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  importEncryptionPrivateKey,
  importEncryptionPublicKey,
  importSigningPrivateKey,
  importSigningPublicKey,
  importUnlockSecret
} from './keys';
export {
  IDENTITY_UNLOCK_METHODS,
  SEAL_VERSION_1,
  UNLOCK_METHODS,
  WRAP_VERSION_GCM,
  WRAP_VERSION_KW,
  encodeWrapContext,
  openSealedKey,
  sealKey,
  unwrapKey,
  wrapKey,
  wrapShareSnapshotKey,
  type IdentityUnlockMethod,
  type SealRecipient,
  type ShareSnapshotKeyContext,
  type ShareSnapshotKeyWraps,
  type UnlockMethod,
  type WrapContext,
  type WrapPurpose
} from './wrap';
export {
  SIGNATURE_VERSION_1,
  signProjectEnvelope,
  verifyProjectEnvelopeSignature,
  verifyVersionChain,
  versionHash,
  type VerifiedVersionSignature
} from './signing';
export {
  assetDedupeHash,
  commitDeviceApproval,
  contactVerificationCode,
  createApprovalNonce,
  deriveAssetDedupeKey,
  deviceApprovalCode,
  formatComparisonCode,
  formatRecoveryKey,
  generateRecoveryKey,
  identityFingerprint,
  parseRecoveryKey,
  projectStateCode,
  publicKeyHash,
  verifyDeviceApprovalCommitment,
  verifyScannedDeviceKey,
  type DeviceApprovalCodeInput,
  type DeviceApprovalCommitment,
  type ProjectStateInput
} from './codes';
