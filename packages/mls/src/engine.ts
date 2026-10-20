/**
 * The engine runs inside the module Worker (or in-process in Node tests):
 * it owns the WASM sessions, converts the JSON results to typed objects and
 * seals state so plaintext MLS secrets never leave it.
 */
import type * as Wasm from '../pkg/openzcad_mls.js';
import { MlsError, toMlsError } from './errors';
import { fromHex, toHex } from './hex';
import { openState, sealState } from './sealed';
import type {
  BuildInfo,
  CommitRequest,
  DeviceDirectory,
  EpochChange,
  EpochRecord,
  GroupInfoSummary,
  LeafInfo,
  LeafInit,
  PendingCommit,
  Processed,
  ProjectRoles,
  ProposalType,
  RejoinPsk,
  RejoinRequest,
  RejoinResult,
  RemovedLeaf,
  Role,
  SessionStatus
} from './types';

export type WasmModule = typeof Wasm;

/** Every operation, keyed by name. Session operations take the session id first. */
export interface EngineApi {
  buildInfo(): BuildInfo;
  leafCertificationPayload(
    projectId: string,
    userId: string,
    deviceId: string,
    signatureKey: Uint8Array
  ): Uint8Array;
  decodeEpochRecord(record: Uint8Array): EpochRecord;
  generate(init: LeafInit): number;
  open(sealed: Uint8Array, key: CryptoKey, projectId: string): Promise<number>;
  seal(id: number, key: CryptoKey): Promise<Uint8Array>;
  free(id: number): void;
  signatureKey(id: number): Uint8Array;
  certificationPayload(id: number): Uint8Array;
  certify(id: number, certification: Uint8Array): void;
  setDirectory(id: number, directory: DeviceDirectory): void;
  createGroup(id: number, rejoinWindow: number): EpochChange;
  keyPackage(id: number): Uint8Array;
  inspectWelcome(id: number, welcome: Uint8Array): GroupInfoSummary;
  join(id: number, welcome: Uint8Array): EpochChange;
  commit(id: number, request: CommitRequest): PendingCommit;
  confirmCommit(id: number): EpochChange;
  discardCommit(id: number): void;
  proposeAdd(id: number, keyPackage: Uint8Array): Uint8Array;
  proposeUpdate(id: number): Uint8Array;
  proposeSelfRemove(id: number): Uint8Array;
  process(id: number, message: Uint8Array): Processed;
  groupInfo(id: number): Uint8Array;
  inspectGroupInfo(id: number, groupInfo: Uint8Array): GroupInfoSummary;
  rejoin(
    id: number,
    groupInfo: Uint8Array,
    request: RejoinRequest
  ): RejoinResult;
  confirmRejoin(id: number): void;
  discardRejoin(id: number): void;
  status(id: number): SessionStatus;
  projectKey(id: number): Uint8Array;
  epochAuthenticator(id: number): Uint8Array;
  rejoinPsk(id: number): RejoinPsk;
  insecureSkipSendChecksForTests(id: number, skip: boolean): void;
}

export type EngineMethod = keyof EngineApi;

/** The same operations, asynchronous: what a Worker client offers. */
export type AsyncEngineApi = {
  [K in EngineMethod]: (
    ...args: Parameters<EngineApi[K]>
  ) => Promise<Awaited<ReturnType<EngineApi[K]>>>;
};

// ---------------------------------------------------------------------------
// JSON shapes from WASM (bytes in hex)

interface LeafJson {
  index: number;
  userId: string;
  deviceId: string;
  signatureKey: string;
  certification: string;
}

interface RolesJson {
  rejoinWindow: number;
  users: { userId: string; role: Role; since: number }[];
}

interface ChangeJson {
  epoch: number;
  removedSelf: boolean;
  removed: { userId: string; deviceId: string; signatureKey: string }[];
  added: LeafJson[];
  rolesChanged: boolean;
  epochRecord: string | null;
}

const leaf = (l: LeafJson): LeafInfo => ({
  index: l.index,
  userId: l.userId,
  deviceId: l.deviceId,
  signatureKey: fromHex(l.signatureKey),
  certification: fromHex(l.certification)
});

const roles = (r: RolesJson | null): ProjectRoles | null =>
  r && { rejoinWindow: r.rejoinWindow, users: r.users.map((u) => ({ ...u })) };

const removed = (r: ChangeJson['removed'][number]): RemovedLeaf => ({
  userId: r.userId,
  deviceId: r.deviceId,
  signatureKey: fromHex(r.signatureKey)
});

const change = (c: ChangeJson): EpochChange => ({
  epoch: c.epoch,
  removedSelf: c.removedSelf,
  removed: c.removed.map(removed),
  added: c.added.map(leaf),
  rolesChanged: c.rolesChanged,
  epochRecord: c.epochRecord === null ? null : fromHex(c.epochRecord)
});

const summary = (s: {
  epoch: number;
  projectMatches: boolean;
  members: LeafJson[];
  roles: RolesJson | null;
}): GroupInfoSummary => ({
  epoch: s.epoch,
  projectMatches: s.projectMatches,
  members: s.members.map(leaf),
  roles: roles(s.roles)
});

function parse<T>(json: string): T {
  return JSON.parse(json) as T;
}

function checkEpoch(epoch: number): bigint {
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new MlsError('input', 'an epoch is a non-negative safe integer');
  }
  return BigInt(epoch);
}

function directoryJson(directory: DeviceDirectory): string {
  return JSON.stringify({
    users: directory.users.map((user) => ({
      userId: user.userId,
      revocationCutoffEpoch: user.revocationCutoffEpoch ?? null,
      devices: user.devices.map((device) => ({
        deviceId: device.deviceId,
        status: device.status,
        leafKeys: device.leafKeys.map(toHex),
        replacedBy: device.replacedBy ?? null
      }))
    }))
  });
}

export class MlsEngine implements EngineApi {
  private readonly sessions = new Map<number, Wasm.MlsSession>();
  private readonly projects = new Map<number, string>();
  private nextId = 1;

  constructor(private readonly wasm: WasmModule) {}

  private session(id: number): Wasm.MlsSession {
    const session = this.sessions.get(id);
    if (!session) throw new MlsError('state', `no MLS session ${id}`);
    return session;
  }

  private add(session: Wasm.MlsSession, projectId: string): number {
    const id = this.nextId++;
    this.sessions.set(id, session);
    this.projects.set(id, projectId);
    return id;
  }

  /** Run a WASM call and turn its error into an MlsError. */
  private run<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      throw toMlsError(error);
    }
  }

  buildInfo(): BuildInfo {
    return parse<BuildInfo>(this.wasm.buildInfo());
  }

  leafCertificationPayload(
    projectId: string,
    userId: string,
    deviceId: string,
    signatureKey: Uint8Array
  ): Uint8Array {
    return this.run(() =>
      this.wasm.leafCertificationPayload(
        projectId,
        userId,
        deviceId,
        signatureKey
      )
    );
  }

  decodeEpochRecord(record: Uint8Array): EpochRecord {
    const json = parse<{
      version: number;
      epoch: number;
      groupContext: string;
      ratchetTree: string;
      commit: string;
      proposals: string[];
    }>(this.run(() => this.wasm.decodeEpochRecord(record)));
    return {
      version: json.version,
      epoch: json.epoch,
      groupContext: fromHex(json.groupContext),
      ratchetTree: fromHex(json.ratchetTree),
      commit: fromHex(json.commit),
      proposals: json.proposals.map(fromHex)
    };
  }

  generate(init: LeafInit): number {
    const session = this.run(() =>
      this.wasm.MlsSession.generate(init.projectId, init.userId, init.deviceId)
    );
    return this.add(session, init.projectId);
  }

  async open(
    sealed: Uint8Array,
    key: CryptoKey,
    projectId: string
  ): Promise<number> {
    const state = await openState(key, projectId, sealed);
    try {
      return this.add(
        this.run(() => this.wasm.MlsSession.import(state, projectId)),
        projectId
      );
    } finally {
      state.fill(0);
    }
  }

  async seal(id: number, key: CryptoKey): Promise<Uint8Array> {
    const projectId = this.projects.get(id) ?? '';
    const state = this.run(() => this.session(id).export());
    try {
      return await sealState(key, projectId, state);
    } finally {
      state.fill(0);
    }
  }

  free(id: number): void {
    this.sessions.get(id)?.free();
    this.sessions.delete(id);
    this.projects.delete(id);
  }

  signatureKey(id: number): Uint8Array {
    return this.run(() => this.session(id).signatureKey());
  }

  certificationPayload(id: number): Uint8Array {
    return this.run(() => this.session(id).certificationPayload());
  }

  certify(id: number, certification: Uint8Array): void {
    this.run(() => this.session(id).certify(certification));
  }

  setDirectory(id: number, directory: DeviceDirectory): void {
    this.run(() => this.session(id).setDirectory(directoryJson(directory)));
  }

  createGroup(id: number, rejoinWindow: number): EpochChange {
    return change(
      parse(this.run(() => this.session(id).createGroup(rejoinWindow)))
    );
  }

  keyPackage(id: number): Uint8Array {
    return this.run(() => this.session(id).keyPackage());
  }

  inspectWelcome(id: number, welcome: Uint8Array): GroupInfoSummary {
    return summary(
      parse(this.run(() => this.session(id).inspectWelcome(welcome)))
    );
  }

  join(id: number, welcome: Uint8Array): EpochChange {
    return change(parse(this.run(() => this.session(id).join(welcome))));
  }

  commit(id: number, request: CommitRequest): PendingCommit {
    const spec = JSON.stringify({
      remove: request.remove ?? [],
      setRoles: request.setRoles ?? [],
      dropUsers: request.dropUsers ?? [],
      rejoinWindow: request.rejoinWindow ?? null
    });
    const out = parse<{ commit: string; welcome: string | null }>(
      this.run(() => this.session(id).commit(spec, request.add ?? []))
    );
    return {
      commit: fromHex(out.commit),
      welcome: out.welcome === null ? null : fromHex(out.welcome)
    };
  }

  confirmCommit(id: number): EpochChange {
    return change(parse(this.run(() => this.session(id).confirmCommit())));
  }

  discardCommit(id: number): void {
    this.run(() => this.session(id).discardCommit());
  }

  proposeAdd(id: number, keyPackage: Uint8Array): Uint8Array {
    return this.run(() => this.session(id).proposeAdd(keyPackage));
  }

  proposeUpdate(id: number): Uint8Array {
    return this.run(() => this.session(id).proposeUpdate());
  }

  proposeSelfRemove(id: number): Uint8Array {
    return this.run(() => this.session(id).proposeSelfRemove());
  }

  process(id: number, message: Uint8Array): Processed {
    const out = parse<{
      kind: 'proposal' | 'commit';
      proposalType: ProposalType | null;
      sender: number | null;
      change: ChangeJson | null;
    }>(this.run(() => this.session(id).process(message)));
    if (out.kind === 'commit' && out.change) {
      return { kind: 'commit', sender: out.sender, change: change(out.change) };
    }
    return {
      kind: 'proposal',
      proposalType: out.proposalType ?? 'other',
      sender: out.sender
    };
  }

  groupInfo(id: number): Uint8Array {
    return this.run(() => this.session(id).groupInfo());
  }

  inspectGroupInfo(id: number, groupInfo: Uint8Array): GroupInfoSummary {
    return summary(
      parse(this.run(() => this.session(id).inspectGroupInfo(groupInfo)))
    );
  }

  rejoin(
    id: number,
    groupInfo: Uint8Array,
    request: RejoinRequest
  ): RejoinResult {
    const out = parse<{ commit: string; change: ChangeJson }>(
      this.run(() =>
        this.session(id).rejoin(
          groupInfo,
          checkEpoch(request.psk.epoch),
          request.psk.secret,
          request.replaceLeaf
        )
      )
    );
    return { commit: fromHex(out.commit), change: change(out.change) };
  }

  confirmRejoin(id: number): void {
    this.run(() => this.session(id).confirmRejoin());
  }

  discardRejoin(id: number): void {
    this.run(() => this.session(id).discardRejoin());
  }

  status(id: number): SessionStatus {
    const s = parse<
      Omit<SessionStatus, 'signatureKey' | 'members' | 'roles'> & {
        signatureKey: string;
        members: LeafJson[];
        roles: RolesJson | null;
      }
    >(this.run(() => this.session(id).status()));
    return {
      ...s,
      signatureKey: fromHex(s.signatureKey),
      members: s.members.map(leaf),
      roles: roles(s.roles)
    };
  }

  projectKey(id: number): Uint8Array {
    return this.run(() => this.session(id).projectKey());
  }

  epochAuthenticator(id: number): Uint8Array {
    return this.run(() => this.session(id).epochAuthenticator());
  }

  rejoinPsk(id: number): RejoinPsk {
    const out = parse<{ epoch: number; secret: string }>(
      this.run(() => this.session(id).rejoinPsk())
    );
    return { epoch: out.epoch, secret: fromHex(out.secret) };
  }

  insecureSkipSendChecksForTests(id: number, skip: boolean): void {
    this.session(id).insecureSkipSendChecksForTests(skip);
  }
}

/** Wrap an in-process engine in the asynchronous interface. */
export function asyncEngine(engine: MlsEngine): AsyncEngineApi {
  return new Proxy({} as AsyncEngineApi, {
    get(_, method: string) {
      const fn = (
        engine as unknown as Record<string, (...args: unknown[]) => unknown>
      )[method];
      if (typeof fn !== 'function') return undefined;
      return async (...args: unknown[]) => fn.apply(engine, args);
    }
  });
}
