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
  generateDeviceSigningKeyPair,
  generateEncryptionKeyPair,
  generateIdentityKeyPair,
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
  chainEntryHash,
  checkChain,
  checkNextLink,
  followsLink,
  type ChainLink,
  type ChainOptions
} from './chain';
export {
  DEVICE_SIGNATURE_PURPOSES,
  SIGNATURE_VERSION_1,
  checkRevocationCutoff,
  currentEncryptionKey,
  decodeDeviceListEntry,
  deviceListEntryHash,
  encodeDeviceListEntry,
  findDevice,
  isDeviceLiveAt,
  readDeviceSignature,
  signDeviceListEntry,
  signWithDevice,
  verifyDeviceList,
  verifyDeviceSignature,
  type AncestryLookup,
  type CertifiedDevice,
  type CutoffSubject,
  type DeviceListEntry,
  type DeviceRecord,
  type DeviceSignatureInfo,
  type DeviceSignatureOptions,
  type DeviceSignaturePurpose,
  type DeviceSigner,
  type EncryptionKeyRecord,
  type RevocationCutoff,
  type SignedDeviceListEntry,
  type VerifiedDeviceList,
  type VerifiedDeviceSignature
} from './devices';
export {
  signProjectEnvelope,
  verifyProjectEnvelopeSignature,
  verifyVersionChain,
  versionHash,
  type VersionSignatureOptions
} from './signing';
export {
  ROSTER_ENTRY_TYPES,
  ROSTER_ROLES,
  checkVersionEpoch,
  decodeRosterEntry,
  encodeRosterEntry,
  rosterEntryHash,
  signRosterEntry,
  signRosterEntryWithIdentity,
  verifyRosterChain,
  type AnchorTransferEntry,
  type EpochEntry,
  type MembershipEntry,
  type RosterAnchor,
  type RosterChainOptions,
  type RosterDeviceLists,
  type RosterEntry,
  type RosterEntryType,
  type RosterKeyWrap,
  type RosterMember,
  type RosterRole,
  type RosterSignatureKind,
  type RosterSigner,
  type RosterState,
  type SelfRemovalEntry,
  type SignedRosterEntry,
  type VerifiedRosterEntry
} from './roster';
export {
  CONTACT_ACTIONS,
  checkContactDeviceList,
  contactsEntryHash,
  decodeContactsEntry,
  deviceListChainsFrom,
  encodeContactsEntry,
  isVerifiedContact,
  signContactsEntry,
  verifyContactsList,
  type ContactAction,
  type ContactDeviceListCheck,
  type ContactPin,
  type ContactStatus,
  type ContactsListEntry,
  type SignedContactsEntry,
  type VerifiedContactsList
} from './contacts';
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
