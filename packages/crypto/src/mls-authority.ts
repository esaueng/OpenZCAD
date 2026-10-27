/** Authenticated application anchors for public MLS history (ADR-024 8-C5b). */
import {
  concatBytes,
  equalBytes,
  fromBase64Url,
  toBase64Url,
  toHex,
  isUint,
  snapshotBytes,
  utf8,
  type Bytes
} from './bytes';
import {
  signStatement,
  statementValid,
  verifyingKey,
  decodeGroupReset,
  verifyGroupReset,
  type VerifiedDeviceList,
  type SignedStatement
} from './devices';
import { E2eeError } from './errors';
import type { SigningPrivateKey } from './external-keys';
import { isEnvelopeId } from './header';
import { hkdfBaseKey, subtle } from './primitives';

export const MAX_MLS_AUTHORITY_BYTES = 768 * 1024;
export const MLS_AUTHORITY_MAC_INFO =
  'OpenZCAD E2EE v1 MLS authority trust mac';

export interface MlsAuthorityRoot {
  /** The first group is generation zero. Key epochs never restart. */
  readonly generation: number;
  readonly keyEpochBase: number;
  readonly groupInfo: string;
  /** For a reset root, the authenticated terminal state of its predecessor. */
  readonly previousGroupInfo?: string;
  readonly resetAuthority?: {
    readonly statement: string;
    readonly signature: string;
  };
}
export interface MlsAuthorityCheckpoint {
  readonly generation: number;
  readonly keyEpoch: number;
  readonly groupInfo: string;
}
export interface MlsAuthorityManifest {
  readonly projectId: string;
  readonly ownerUserId: string;
  readonly ownerIdentityKeyHash: string;
  readonly roots: readonly MlsAuthorityRoot[];
  readonly checkpoint: MlsAuthorityCheckpoint | null;
  readonly signerDeviceId: string;
}
export interface MlsAuthorityTrust {
  readonly userId: string;
  readonly projectId: string;
  readonly sequence: number;
  readonly accountKeyGeneration: number;
  readonly accountKeySequence: number;
  readonly signerDeviceId: string;
  readonly manifest: { readonly statement: string; readonly signature: string };
  /** Membership state accepted by this account, independently of the server. */
  readonly latestKeyEpoch: number;
  readonly latestGroupInfo: string;
}
export interface SignedMlsAuthorityTrust {
  readonly record: Uint8Array;
  readonly recordMac: Uint8Array;
  readonly signature: Uint8Array;
}

function fail(message = 'The MLS authority record is malformed.'): never {
  throw new E2eeError('malformed', message);
}
const uint = (value: unknown): value is number => isUint(value, 0xffffffff);
const isList = (value: unknown): boolean => Array.isArray(value);
function binary(value: unknown, max = 256 * 1024): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > Math.ceil((max * 4) / 3)
  )
    fail();
  const bytes = fromBase64Url(value);
  if (bytes.length === 0 || bytes.length > max || toBase64Url(bytes) !== value)
    fail();
  return value;
}
function identifier(value: unknown): string {
  if (!isEnvelopeId(value)) fail();
  return value;
}
function encode(value: unknown): Bytes {
  const result = utf8(JSON.stringify(value));
  if (result.length > MAX_MLS_AUTHORITY_BYTES)
    fail('The MLS authority record exceeds its byte limit.');
  return result;
}
function parse(bytes: Uint8Array): Record<string, unknown> {
  const owned = snapshotBytes(
    bytes,
    'MLS authority record',
    MAX_MLS_AUTHORITY_BYTES,
    'malformed'
  );
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(owned));
  } catch {
    return fail();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

export function encodeMlsAuthorityManifest(value: MlsAuthorityManifest): Bytes {
  if (
    !value ||
    !isList(value.roots) ||
    value.roots.length === 0 ||
    value.roots.length > 64 ||
    typeof value.ownerIdentityKeyHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.ownerIdentityKeyHash)
  )
    fail();
  let prior = -1;
  const roots = value.roots.map((root, generation) => {
    if (
      !root ||
      root.generation !== generation ||
      !uint(root.keyEpochBase) ||
      root.keyEpochBase <= prior ||
      (generation === 0 && root.keyEpochBase !== 0)
    )
      fail();
    prior = root.keyEpochBase;
    return {
      generation,
      keyEpochBase: root.keyEpochBase,
      groupInfo: binary(root.groupInfo),
      ...(generation === 0
        ? {}
        : {
            previousGroupInfo: binary(root.previousGroupInfo),
            resetAuthority: {
              statement: binary(root.resetAuthority?.statement, 1024),
              signature: binary(root.resetAuthority?.signature, 65)
            }
          })
    };
  });
  const checkpoint = value.checkpoint;
  if (
    checkpoint !== null &&
    (!checkpoint ||
      !uint(checkpoint.generation) ||
      !uint(checkpoint.keyEpoch) ||
      !roots[checkpoint.generation] ||
      checkpoint.keyEpoch < roots[checkpoint.generation]!.keyEpochBase ||
      (roots[checkpoint.generation + 1] &&
        checkpoint.keyEpoch >= roots[checkpoint.generation + 1]!.keyEpochBase))
  )
    fail();
  return encode({
    v: 1,
    kind: 'MLS-authority-manifest',
    projectId: identifier(value.projectId),
    ownerUserId: identifier(value.ownerUserId),
    ownerIdentityKeyHash: value.ownerIdentityKeyHash,
    roots,
    checkpoint:
      checkpoint === null
        ? null
        : {
            generation: checkpoint.generation,
            keyEpoch: checkpoint.keyEpoch,
            groupInfo: binary(checkpoint.groupInfo)
          },
    signerDeviceId: identifier(value.signerDeviceId)
  });
}
export function decodeMlsAuthorityManifest(
  bytes: Uint8Array
): MlsAuthorityManifest {
  const value = parse(bytes);
  if (value.v !== 1 || value.kind !== 'MLS-authority-manifest') fail();
  const record = value as unknown as MlsAuthorityManifest;
  if (!equalBytes(encodeMlsAuthorityManifest(record), bytes))
    fail('The MLS authority manifest is not canonical.');
  return {
    projectId: record.projectId,
    ownerUserId: record.ownerUserId,
    ownerIdentityKeyHash: record.ownerIdentityKeyHash,
    roots: record.roots,
    checkpoint: record.checkpoint,
    signerDeviceId: record.signerDeviceId
  };
}
/** The identity's reset approval binds the prior roots and exact terminal state. */
export async function mlsAuthorityResetHash(
  manifest: MlsAuthorityManifest,
  latestKeyEpoch: number,
  latestGroupInfo: string
): Promise<Bytes> {
  const normalized = decodeMlsAuthorityManifest(
    encodeMlsAuthorityManifest({ ...manifest, checkpoint: null })
  );
  if (!uint(latestKeyEpoch)) fail();
  return new Uint8Array(
    await subtle().digest(
      'SHA-256',
      encode({
        v: 1,
        kind: 'MLS-authority-reset',
        projectId: normalized.projectId,
        ownerUserId: normalized.ownerUserId,
        ownerIdentityKeyHash: normalized.ownerIdentityKeyHash,
        roots: normalized.roots,
        latestKeyEpoch,
        latestGroupInfo: binary(latestGroupInfo)
      })
    )
  );
}

/** Verify a reset's identity approval without trusting its server metadata. */
export async function verifyMlsAuthorityReset(
  manifest: MlsAuthorityManifest,
  generation: number,
  owner: VerifiedDeviceList
) {
  const root = manifest.roots[generation];
  if (
    !root?.previousGroupInfo ||
    !root.resetAuthority ||
    generation < 1 ||
    owner.userId !== manifest.ownerUserId ||
    toHex(owner.identityKeyHash) !== manifest.ownerIdentityKeyHash
  )
    fail();
  const signed = {
    statement: fromBase64Url(root.resetAuthority.statement),
    signature: fromBase64Url(root.resetAuthority.signature)
  };
  const value = await verifyGroupReset(signed, owner, {
    generation: decodeGroupReset(signed.statement).generation
  });
  const expected = await mlsAuthorityResetHash(
    { ...manifest, roots: manifest.roots.slice(0, generation) },
    root.keyEpochBase - 1,
    root.previousGroupInfo
  );
  if (
    value.projectId !== manifest.projectId ||
    value.priorGroupGeneration + 1 !== generation ||
    value.priorKeyEpoch + 1 !== root.keyEpochBase ||
    !value.authorityHash ||
    !equalBytes(value.authorityHash, expected)
  )
    fail('The identity reset does not bind these roots and membership state.');
  return value;
}

export async function signMlsAuthorityManifest(
  key: SigningPrivateKey,
  value: MlsAuthorityManifest
): Promise<SignedStatement> {
  const statement = encodeMlsAuthorityManifest(value);
  return {
    statement,
    signature: await signStatement(key, 'MLS authority manifest', statement)
  };
}
export async function verifyMlsAuthorityManifest(
  signed: SignedStatement,
  signer: Uint8Array | CryptoKey
): Promise<MlsAuthorityManifest> {
  const statement = snapshotBytes(
    signed.statement,
    'MLS authority manifest',
    MAX_MLS_AUTHORITY_BYTES
  );
  const signature = snapshotBytes(
    signed.signature,
    'MLS authority signature',
    65
  );
  const value = decodeMlsAuthorityManifest(statement);
  if (
    !(await statementValid(
      (await verifyingKey(signer)).key,
      'MLS authority manifest',
      statement,
      signature
    ))
  )
    fail('The MLS authority manifest signature did not verify.');
  return value;
}

export function encodeMlsAuthorityTrust(value: MlsAuthorityTrust): Bytes {
  if (
    !value ||
    !uint(value.sequence) ||
    value.sequence === 0 ||
    !uint(value.accountKeyGeneration) ||
    value.accountKeyGeneration === 0 ||
    !uint(value.accountKeySequence) ||
    !uint(value.latestKeyEpoch) ||
    !value.manifest
  )
    fail();
  const statement = binary(value.manifest.statement, MAX_MLS_AUTHORITY_BYTES);
  const signature = binary(value.manifest.signature, 65);
  const signatureBytes = fromBase64Url(signature);
  if (signatureBytes.length !== 65 || signatureBytes[0] !== 1) fail();
  const manifest = decodeMlsAuthorityManifest(fromBase64Url(statement));
  if (
    manifest.projectId !== value.projectId ||
    value.latestKeyEpoch < manifest.roots.at(-1)!.keyEpochBase
  )
    fail();
  return encode({
    v: 1,
    kind: 'MLS-authority-trust',
    userId: identifier(value.userId),
    projectId: identifier(value.projectId),
    sequence: value.sequence,
    accountKeyGeneration: value.accountKeyGeneration,
    accountKeySequence: value.accountKeySequence,
    signerDeviceId: identifier(value.signerDeviceId),
    manifest: { statement, signature },
    latestKeyEpoch: value.latestKeyEpoch,
    latestGroupInfo: binary(value.latestGroupInfo)
  });
}
export function decodeMlsAuthorityTrust(bytes: Uint8Array): MlsAuthorityTrust {
  const value = parse(bytes);
  if (value.v !== 1 || value.kind !== 'MLS-authority-trust') fail();
  const record = value as unknown as MlsAuthorityTrust;
  if (!equalBytes(encodeMlsAuthorityTrust(record), bytes))
    fail('The MLS authority trust record is not canonical.');
  return {
    userId: record.userId,
    projectId: record.projectId,
    sequence: record.sequence,
    accountKeyGeneration: record.accountKeyGeneration,
    accountKeySequence: record.accountKeySequence,
    signerDeviceId: record.signerDeviceId,
    manifest: record.manifest,
    latestKeyEpoch: record.latestKeyEpoch,
    latestGroupInfo: record.latestGroupInfo
  };
}
async function macKey(accountKey: Uint8Array): Promise<CryptoKey> {
  return subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: utf8(MLS_AUTHORITY_MAC_INFO)
    },
    await hkdfBaseKey(accountKey, 'An account key'),
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify']
  );
}
export async function signMlsAuthorityTrust(
  accountKey: Uint8Array,
  deviceKey: SigningPrivateKey,
  value: MlsAuthorityTrust
): Promise<SignedMlsAuthorityTrust> {
  const record = encodeMlsAuthorityTrust(value);
  const account = snapshotBytes(accountKey, 'Account key', 32);
  try {
    const recordMac = new Uint8Array(
      await subtle().sign('HMAC', await macKey(account), record)
    );
    return {
      record,
      recordMac,
      signature: await signStatement(
        deviceKey,
        'MLS authority trust',
        concatBytes(record, recordMac)
      )
    };
  } finally {
    account.fill(0);
  }
}
export async function openMlsAuthorityTrust(
  accountKey: Uint8Array,
  signer: Uint8Array | CryptoKey,
  signed: SignedMlsAuthorityTrust
): Promise<MlsAuthorityTrust> {
  const record = snapshotBytes(
    signed.record,
    'MLS authority trust',
    MAX_MLS_AUTHORITY_BYTES
  );
  const mac = snapshotBytes(signed.recordMac, 'MLS authority MAC', 32);
  const signature = snapshotBytes(
    signed.signature,
    'MLS authority signature',
    65
  );
  const value = decodeMlsAuthorityTrust(record);
  const account = snapshotBytes(accountKey, 'Account key', 32);
  const signerKey = verifyingKey(signer);
  try {
    const key = (await signerKey).key;
    if (
      mac.length !== 32 ||
      !(await subtle().verify('HMAC', await macKey(account), mac, record)) ||
      !(await statementValid(
        key,
        'MLS authority trust',
        concatBytes(record, mac),
        signature
      ))
    )
      fail('The MLS authority trust authentication did not verify.');
    return value;
  } finally {
    account.fill(0);
  }
}

/** Delivery-service defense only: this does not authenticate the account MAC. */
export async function verifyMlsAuthorityTrustSigner(
  signer: Uint8Array | CryptoKey,
  signed: SignedMlsAuthorityTrust
): Promise<MlsAuthorityTrust> {
  const record = snapshotBytes(
    signed.record,
    'MLS authority trust',
    MAX_MLS_AUTHORITY_BYTES
  );
  const mac = snapshotBytes(signed.recordMac, 'MLS authority MAC', 32);
  const signature = snapshotBytes(
    signed.signature,
    'MLS authority signature',
    65
  );
  const value = decodeMlsAuthorityTrust(record);
  if (
    mac.length !== 32 ||
    !(await statementValid(
      (await verifyingKey(signer)).key,
      'MLS authority trust',
      concatBytes(record, mac),
      signature
    ))
  )
    fail('The MLS authority device signature did not verify.');
  return value;
}
