/**
 * Typed handles over the engine, whether it runs in a Worker or in-process.
 */
import { DEFAULT_REJOIN_WINDOW } from './constants';
import type { AsyncEngineApi } from './engine';
import type {
  BuildInfo,
  CommitRequest,
  DeviceDirectory,
  EpochChange,
  EpochRecord,
  GroupInfoSummary,
  LeafInit,
  PendingCommit,
  Processed,
  RejoinPsk,
  RejoinRequest,
  RejoinResult,
  SessionStatus
} from './types';

export class Mls {
  constructor(
    private readonly api: AsyncEngineApi,
    private readonly onClose: () => void = () => {}
  ) {}

  buildInfo(): Promise<BuildInfo> {
    return this.api.buildInfo();
  }

  /** The bytes a device signs to certify a leaf key. */
  leafCertificationPayload(
    projectId: string,
    userId: string,
    deviceId: string,
    signatureKey: Uint8Array
  ): Promise<Uint8Array> {
    return this.api.leafCertificationPayload(
      projectId,
      userId,
      deviceId,
      signatureKey
    );
  }

  decodeEpochRecord(record: Uint8Array): Promise<EpochRecord> {
    return this.api.decodeEpochRecord(record);
  }

  /**
   * A new per-project leaf signing key for this device. Certify it with the
   * device key (`certificationPayload`, then `certify`) before use.
   */
  async generate(init: LeafInit): Promise<MlsSession> {
    return new MlsSession(
      this.api,
      await this.api.generate(init),
      init.projectId
    );
  }

  /** Restore a session sealed with `MlsSession.seal`. */
  async open(
    sealed: Uint8Array,
    key: CryptoKey,
    projectId: string
  ): Promise<MlsSession> {
    return new MlsSession(
      this.api,
      await this.api.open(sealed, key, projectId),
      projectId
    );
  }

  close(): void {
    this.onClose();
  }
}

/**
 * One device's membership in one project's MLS group. Every method that
 * changes state should be followed by `seal` and a write to IndexedDB before
 * its output is sent to the room.
 */
export class MlsSession {
  constructor(
    private readonly api: AsyncEngineApi,
    readonly id: number,
    readonly projectId: string
  ) {}

  signatureKey(): Promise<Uint8Array> {
    return this.api.signatureKey(this.id);
  }

  certificationPayload(): Promise<Uint8Array> {
    return this.api.certificationPayload(this.id);
  }

  certify(certification: Uint8Array): Promise<void> {
    return this.api.certify(this.id, certification);
  }

  /** Replace the verified device directory the policy reads. */
  setDirectory(directory: DeviceDirectory): Promise<void> {
    return this.api.setDirectory(this.id, directory);
  }

  /** Create the project's group with this device as the owner's only leaf. */
  createGroup(options: { rejoinWindow?: number } = {}): Promise<EpochChange> {
    return this.api.createGroup(
      this.id,
      options.rejoinWindow ?? DEFAULT_REJOIN_WINDOW
    );
  }

  keyPackage(): Promise<Uint8Array> {
    return this.api.keyPackage(this.id);
  }

  /** The group's members before joining, to verify their credentials first. */
  inspectWelcome(welcome: Uint8Array): Promise<GroupInfoSummary> {
    return this.api.inspectWelcome(this.id, welcome);
  }

  /** Join only after replaying every epoch record through the Welcome epoch. */
  join(welcome: Uint8Array, history: Uint8Array[]): Promise<EpochChange> {
    return this.api.join(this.id, welcome, history);
  }

  /**
   * Build a Commit (including every proposal received this epoch). It stays
   * pending until the room accepts it (`confirmCommit`) or another Commit
   * wins the epoch (`discardCommit`).
   */
  commit(request: CommitRequest = {}): Promise<PendingCommit> {
    return this.api.commit(this.id, request);
  }

  confirmCommit(): Promise<EpochChange> {
    return this.api.confirmCommit(this.id);
  }

  discardCommit(): Promise<void> {
    return this.api.discardCommit(this.id);
  }

  /** An Add by reference, for another member to commit. */
  proposeAdd(keyPackage: Uint8Array): Promise<Uint8Array> {
    return this.api.proposeAdd(this.id, keyPackage);
  }

  proposeUpdate(): Promise<Uint8Array> {
    return this.api.proposeUpdate(this.id);
  }

  /** Leave: a SelfRemove proposal another member commits. */
  proposeSelfRemove(): Promise<Uint8Array> {
    return this.api.proposeSelfRemove(this.id);
  }

  /** Process a proposal or Commit delivered by the room. */
  process(message: Uint8Array): Promise<Processed> {
    return this.api.process(this.id, message);
  }

  /** A GroupInfo that lets a listed member's device rejoin. */
  groupInfo(): Promise<Uint8Array> {
    return this.api.groupInfo(this.id);
  }

  inspectGroupInfo(groupInfo: Uint8Array): Promise<GroupInfoSummary> {
    return this.api.inspectGroupInfo(this.id, groupInfo);
  }

  /**
   * Rejoin by external Commit with a rejoin PSK. The new epoch is provisional
   * until the room accepts the Commit (`confirmRejoin`); if another Commit
   * wins the epoch, `discardRejoin` restores the session as it was.
   */
  rejoin(groupInfo: Uint8Array, request: RejoinRequest): Promise<RejoinResult> {
    return this.api.rejoin(this.id, groupInfo, request);
  }

  confirmRejoin(): Promise<void> {
    return this.api.confirmRejoin(this.id);
  }

  discardRejoin(): Promise<void> {
    return this.api.discardRejoin(this.id);
  }

  status(): Promise<SessionStatus> {
    return this.api.status(this.id);
  }

  /** `MLS-Exporter("openzcad project key", project id, 32)` for this epoch. */
  projectKey(): Promise<Uint8Array> {
    return this.api.projectKey(this.id);
  }

  /** RFC 9420 §8.7, for out-of-band comparison (the project state code). */
  epochAuthenticator(): Promise<Uint8Array> {
    return this.api.epochAuthenticator(this.id);
  }

  /** This epoch's rejoin PSK, to wrap under the account key. */
  rejoinPsk(): Promise<RejoinPsk> {
    return this.api.rejoinPsk(this.id);
  }

  /** Export the whole session sealed under a non-extractable AES-256-GCM key. */
  seal(key: CryptoKey): Promise<Uint8Array> {
    return this.api.seal(this.id, key);
  }

  free(): Promise<void> {
    return this.api.free(this.id);
  }

  /**
   * Tests only: stop this client checking its own outgoing Commits, so a test
   * can prove the receivers refuse them. It weakens nothing: receivers always
   * check, and a malicious client could skip its own checks anyway.
   */
  insecureSkipSendChecksForTests(skip: boolean): Promise<void> {
    return this.api.insecureSkipSendChecksForTests(this.id, skip);
  }
}
