/**
 * The MLS scenarios: the spike's two scenarios ported to the package API,
 * every rejoin refusal, and the cases the spike did not run. Test code only
 * (not exported from the package): Vitest runs it in Node against the
 * in-process engine and through the Worker protocol, and `browser/` runs it
 * in a real module Worker. Steps in a suite run in order and share state.
 */
import type { Mls, MlsSession } from './client';
import { MlsError, type PolicyReasonCode } from './errors';
import { generateStateKey } from './sealed';
import type {
  CommitRequest,
  LeafKeyCertification,
  DeviceDirectory,
  EpochChange,
  RejoinPsk
} from './types';

export interface ScenarioStep<C> {
  name: string;
  run(context: C): Promise<string>;
}

export interface ScenarioSuite<C = unknown> {
  name: string;
  setup(mls: Mls): Promise<C>;
  steps: ScenarioStep<C>[];
}

function suite<C>(definition: ScenarioSuite<C>): ScenarioSuite {
  return {
    name: definition.name,
    setup: (mls) => definition.setup(mls),
    steps: definition.steps.map((step) => ({
      name: step.name,
      run: (context) => step.run(context as C)
    }))
  };
}

// ---------------------------------------------------------------------------
// Assertions (no test framework, so the suite also runs in a browser Worker)

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

async function refused(
  action: () => Promise<unknown>,
  expected: PolicyReasonCode[],
  forbidden: PolicyReasonCode[] = []
): Promise<string> {
  try {
    await action();
  } catch (error) {
    assert(
      error instanceof MlsError,
      `expected an MlsError, got ${String(error)}`
    );
    assert(
      error.kind === 'policy',
      `expected a policy refusal, got ${error.kind}: ${error.message}`
    );
    const codes = error.codes;
    for (const code of expected) {
      assert(
        codes.includes(code),
        `expected ${code}, got [${codes.join(', ')}]: ${error.message}`
      );
    }
    for (const code of forbidden) {
      assert(!codes.includes(code), `did not expect ${code}: ${error.message}`);
    }
    return `refused: ${codes.join(', ')}`;
  }
  throw new Error(
    `expected a refusal with ${expected.join(', ')}, but it was accepted`
  );
}

async function failsWith(
  action: () => Promise<unknown>,
  kind: MlsError['kind']
): Promise<string> {
  try {
    await action();
  } catch (error) {
    assert(
      error instanceof MlsError,
      `expected an MlsError, got ${String(error)}`
    );
    assert(
      error.kind === kind,
      `expected ${kind}, got ${error.kind}: ${error.message}`
    );
    return `${kind}: ${error.message.slice(0, 100)}`;
  }
  throw new Error(`expected a ${kind} error, but it succeeded`);
}

const ALL_REJOIN_CUTOFFS: PolicyReasonCode[] = [
  'credential-revoked',
  'identity-not-listed',
  'rejoin-psk-before-revocation',
  'rejoin-psk-before-role-change',
  'rejoin-psk-before-leaf-removal',
  'rejoin-psk-outside-window'
];

function only(
  ...codes: PolicyReasonCode[]
): [PolicyReasonCode[], PolicyReasonCode[]] {
  return [codes, ALL_REJOIN_CUTOFFS.filter((c) => !codes.includes(c))];
}

// ---------------------------------------------------------------------------
// Cast: devices, the verified device directory, the users' PSK stores

interface Device {
  name: string;
  userId: string;
  deviceId: string;
  session: MlsSession;
  live: boolean;
}

interface DeviceRecord {
  status: 'active' | 'revoked';
  leafKeys: LeafKeyCertification[];
  replacedBy?: string;
  cutoff?: number;
}

class World {
  readonly devices: Device[] = [];
  private readonly directory = new Map<string, Map<string, DeviceRecord>>();
  /** Each user's rejoin PSKs as that user's devices store them on the
   * server, wrapped under the account key (ADR-024, "Long-offline devices"). */
  private readonly accountPsks = new Map<string, Map<number, Uint8Array>>();
  /** The newest epoch any device has reached: new certifications count from here. */
  private latestEpoch = 0;

  constructor(
    readonly mls: Mls,
    readonly projectId: string
  ) {}

  snapshot(): DeviceDirectory {
    return {
      users: [...this.directory].map(([userId, devices]) => ({
        userId,
        devices: [...devices].map(([deviceId, d]) => ({
          deviceId,
          status: d.status,
          leafKeys: d.leafKeys,
          ...(d.replacedBy ? { replacedBy: d.replacedBy } : {}),
          ...(d.cutoff === undefined ? {} : { revocationCutoffEpoch: d.cutoff })
        }))
      }))
    };
  }

  async publish(): Promise<void> {
    const snapshot = this.snapshot();
    for (const d of this.devices)
      if (d.live) await d.session.setDirectory(snapshot);
  }

  private record(userId: string, deviceId: string): DeviceRecord {
    let devices = this.directory.get(userId);
    if (!devices)
      this.directory.set(userId, (devices = new Map<string, DeviceRecord>()));
    let record = devices.get(deviceId);
    if (!record)
      devices.set(deviceId, (record = { status: 'active', leafKeys: [] }));
    return record;
  }

  /** A device with a fresh leaf key, certified unless told otherwise. */
  async device(
    userId: string,
    deviceId: string,
    certified = true,
    certifiedEpoch: number | undefined = this.latestEpoch
  ): Promise<Device> {
    const session = await this.mls.generate({
      projectId: this.projectId,
      userId,
      deviceId
    });
    const key = await session.signatureKey();
    // The certification is the device's signature over this payload; the
    // policy only reads the verified directory, so any bytes stand in here.
    const payload = await session.certificationPayload();
    await session.certify(payload.slice(-16));
    if (certified) {
      this.record(userId, deviceId).leafKeys.push(
        certifiedEpoch === undefined ? { key } : { key, certifiedEpoch }
      );
    }
    const device: Device = {
      name: deviceId,
      userId,
      deviceId,
      session,
      live: true
    };
    this.devices.push(device);
    await this.publish();
    return device;
  }

  /** A device whose own directory wrongly trusts its uncertified key. */
  async trustSelf(d: Device): Promise<void> {
    const snapshot = this.snapshot();
    const self = {
      deviceId: d.deviceId,
      status: 'active' as const,
      leafKeys: [{ key: await d.session.signatureKey() }]
    };
    const user = snapshot.users.find((u) => u.userId === d.userId);
    if (user)
      user.devices = [
        ...user.devices.filter((x) => x.deviceId !== d.deviceId),
        self
      ];
    else snapshot.users.push({ userId: d.userId, devices: [self] });
    await d.session.setDirectory(snapshot);
  }

  async revoke(
    userId: string,
    deviceId: string,
    cutoff: number,
    replacedBy?: string
  ): Promise<void> {
    const record = this.record(userId, deviceId);
    record.status = 'revoked';
    if (replacedBy) record.replacedBy = replacedBy;
    record.cutoff = cutoff;
    await this.publish();
  }

  async storePsks(devices: Device[]): Promise<void> {
    for (const d of devices) {
      if (!d.live) continue;
      const psk = await d.session.rejoinPsk();
      this.latestEpoch = Math.max(this.latestEpoch, psk.epoch);
      let store = this.accountPsks.get(d.userId);
      if (!store)
        this.accountPsks.set(d.userId, (store = new Map<number, Uint8Array>()));
      store.set(psk.epoch, psk.secret);
    }
  }

  psk(userId: string, epoch: number): RejoinPsk {
    const secret = this.accountPsks.get(userId)?.get(epoch);
    assert(secret, `${userId} has no stored PSK for epoch ${epoch}`);
    return { epoch, secret };
  }

  newestPsk(userId: string, before = Number.MAX_SAFE_INTEGER): RejoinPsk {
    const epochs = [...(this.accountPsks.get(userId)?.keys() ?? [])].filter(
      (e) => e < before
    );
    assert(
      epochs.length > 0,
      `${userId} has no stored PSK before epoch ${before}`
    );
    return this.psk(userId, Math.max(...epochs));
  }

  /**
   * A copy of a device that has no group (removed, or never joined): the
   * same leaf key and certification in a new session, as a stolen or
   * restored device would hold. Each failed rejoin attempt uses a new copy.
   */
  async copy(d: Device, name: string): Promise<Device> {
    const key = await generateStateKey();
    const session = await this.mls.open(
      await d.session.seal(key),
      key,
      this.projectId
    );
    const status = await session.status();
    assert(!status.inGroup, `${d.name} still has a group`);
    const twin: Device = { ...d, name, session, live: true };
    this.devices.push(twin);
    await this.publish();
    return twin;
  }

  retire(...devices: Device[]): void {
    for (const d of devices) d.live = false;
  }
}

async function epochOf(d: Device): Promise<number> {
  const status = await d.session.status();
  assert(status.epoch !== null, `${d.name} has no group`);
  return status.epoch;
}

async function indexOf(d: Device): Promise<number> {
  const status = await d.session.status();
  assert(status.ownIndex !== null, `${d.name} has no group`);
  return status.ownIndex;
}

/** Every listed device is in one epoch with one authenticator and project key. */
async function agree(devices: Device[]): Promise<string> {
  let seen:
    | { epoch: number; auth: Uint8Array; key: Uint8Array; members: number }
    | undefined;
  for (const d of devices) {
    const status = await d.session.status();
    assert(status.epoch !== null, `${d.name} has no group`);
    const auth = await d.session.epochAuthenticator();
    const key = await d.session.projectKey();
    assert(key.length === 32, 'the project key is 32 bytes');
    if (!seen)
      seen = { epoch: status.epoch, auth, key, members: status.members.length };
    else
      assert(
        seen.epoch === status.epoch &&
          equalBytes(seen.auth, auth) &&
          equalBytes(seen.key, key) &&
          seen.members === status.members.length,
        `${d.name} disagrees at epoch ${status.epoch}`
      );
  }
  assert(seen, 'no devices');
  return `epoch ${seen.epoch}: ${devices.length} devices agree (${seen.members} leaves)`;
}

async function deliver(message: Uint8Array, to: Device[]): Promise<void> {
  for (const d of to) await d.session.process(message);
}

/** Commit, let the room accept it, deliver it, store everyone's PSKs. */
async function advance(
  world: World,
  committer: Device,
  others: Device[],
  request: CommitRequest = {}
): Promise<{
  change: EpochChange;
  commit: Uint8Array;
  welcome: Uint8Array | null;
}> {
  const pending = await committer.session.commit(request);
  const change = await committer.session.confirmCommit();
  const live: Device[] = [];
  for (const d of others) {
    const processed = await d.session.process(pending.commit);
    if (processed.kind === 'commit' && processed.change.removedSelf)
      world.retire(d);
    else live.push(d);
  }
  await world.storePsks([committer, ...live]);
  return { change, commit: pending.commit, welcome: pending.welcome };
}

async function join(
  world: World,
  welcome: Uint8Array | null,
  devices: Device[]
): Promise<void> {
  assert(welcome, 'the Commit produced no Welcome');
  for (const d of devices) await d.session.join(welcome);
  await world.storePsks(devices);
}

async function addDevices(
  world: World,
  committer: Device,
  others: Device[],
  joiners: Device[],
  request: CommitRequest = {}
): Promise<EpochChange> {
  const add = await Promise.all(joiners.map((d) => d.session.keyPackage()));
  const { change, welcome } = await advance(world, committer, others, {
    ...request,
    add
  });
  await join(world, welcome, joiners);
  return change;
}

async function createProject(
  world: World,
  owner: Device,
  rejoinWindow?: number
): Promise<EpochChange> {
  const change = await owner.session.createGroup(
    rejoinWindow ? { rejoinWindow } : {}
  );
  await world.storePsks([owner]);
  return change;
}

async function rejoin(
  world: World,
  joiner: Device,
  groupInfoFrom: Device,
  psk: RejoinPsk,
  receivers: Device[],
  replaceLeaf?: number
): Promise<string> {
  const groupInfo = await groupInfoFrom.session.groupInfo();
  const result = await joiner.session.rejoin(groupInfo, {
    psk,
    ...(replaceLeaf === undefined ? {} : { replaceLeaf })
  });
  await deliver(result.commit, receivers);
  await joiner.session.confirmRejoin();
  await world.storePsks([joiner, ...receivers]);
  return `PSK of epoch ${psk.epoch} accepted; now epoch ${result.change.epoch}`;
}

/** A rejoin whose joiner skips its own checks, so the receivers decide. */
async function tryRejoin(
  joiner: Device,
  groupInfoFrom: Device,
  psk: RejoinPsk,
  receivers: Device[],
  replaceLeaf?: number
): Promise<void> {
  await joiner.session.insecureSkipSendChecksForTests(true);
  const groupInfo = await groupInfoFrom.session.groupInfo();
  const result = await joiner.session.rejoin(groupInfo, {
    psk,
    ...(replaceLeaf === undefined ? {} : { replaceLeaf })
  });
  for (const r of receivers) await r.session.process(result.commit);
}

/** A Commit built by a client that skips its own checks; the receivers decide. */
async function tryCommit(
  committer: Device,
  request: CommitRequest,
  receivers: Device[]
): Promise<void> {
  await committer.session.insecureSkipSendChecksForTests(true);
  const pending = await committer.session.commit(request);
  try {
    for (const r of receivers) await r.session.process(pending.commit);
  } finally {
    await committer.session.discardCommit();
    await committer.session.insecureSkipSendChecksForTests(false);
  }
}

async function tick(
  world: World,
  committer: Device,
  others: Device[],
  times = 1
): Promise<number> {
  for (let i = 0; i < times; i += 1) await advance(world, committer, others);
  return epochOf(committer);
}

const project = (name: string) => `0f7c6a52-3d1e-4b8a-9f3e-${name}`;

// ---------------------------------------------------------------------------
// The spike's main scenario

interface MainCast {
  world: World;
  mls: Mls;
  a1: Device;
  a2: Device;
  b1: Device;
  b2?: Device;
}

const main = suite<MainCast>({
  name: 'group operations (spike main scenario)',
  async setup(mls) {
    const world = new World(mls, project('main'));
    return {
      world,
      mls,
      a1: await world.device('A', 'A1'),
      a2: await world.device('A', 'A2'),
      b1: await world.device('B', 'B1')
    };
  },
  steps: [
    {
      name: 'create the group; A2 joins by KeyPackage, Add and Welcome',
      async run({ world, mls, a1, a2 }) {
        const created = await createProject(world, a1);
        assert(
          created.epoch === 0 && created.epochRecord,
          'epoch 0 has a record'
        );
        const record = await mls.decodeEpochRecord(created.epochRecord);
        assert(
          record.epoch === 0 &&
            record.commit.length === 0 &&
            record.ratchetTree.length > 0,
          'first record'
        );
        const roles = (await a1.session.status()).roles;
        assert(
          roles?.users.length === 1 && roles.users[0]?.role === 'owner',
          'the creator is the owner'
        );
        const change = await addDevices(world, a1, [], [a2]);
        assert(
          change.added.length === 1 && change.added[0]?.deviceId === 'A2',
          'A2 added'
        );
        return agree([a1, a2]);
      }
    },
    {
      name: 'the owner adds B1 and grants the editor role in one Commit',
      async run({ world, a1, a2, b1 }) {
        const kp = await b1.session.keyPackage();
        const { change, welcome } = await advance(world, a1, [a2], {
          add: [kp],
          setRoles: [{ userId: 'B', role: 'editor' }]
        });
        assert(
          change.rolesChanged && welcome,
          'roles changed, Welcome produced'
        );
        const preview = await b1.session.inspectWelcome(welcome);
        assert(
          preview.projectMatches && preview.members.length === 3,
          'the Welcome lists every leaf'
        );
        const editor = preview.roles?.users.find((u) => u.userId === 'B');
        assert(
          editor?.role === 'editor' && editor.since === change.epoch,
          'B is editor since this epoch'
        );
        await join(world, welcome, [b1]);
        return agree([a1, a2, b1]);
      }
    },
    {
      name: 'B1 proposes an Update, A1 commits it; the record keeps the proposal',
      async run({ world, mls, a1, a2, b1 }) {
        const proposal = await b1.session.proposeUpdate();
        for (const d of [a1, a2]) {
          const processed = await d.session.process(proposal);
          assert(
            processed.kind === 'proposal' &&
              processed.proposalType === 'update',
            'an Update proposal'
          );
        }
        const { change, commit } = await advance(world, a1, [a2, b1]);
        assert(change.epochRecord, 'a record');
        const record = await mls.decodeEpochRecord(change.epochRecord);
        assert(
          equalBytes(record.commit, commit),
          'the record holds the Commit'
        );
        assert(
          record.proposals.length === 1 &&
            equalBytes(record.proposals[0]!, proposal),
          'and the proposal'
        );
        return agree([a1, a2, b1]);
      }
    },
    {
      name: 'path-only Commits from every member in turn',
      async run({ world, a1, a2, b1 }) {
        const all = [a1, a2, b1];
        for (let round = 0; round < 6; round += 1) {
          const committer = all[round % 3]!;
          await advance(
            world,
            committer,
            all.filter((d) => d !== committer)
          );
        }
        return agree(all);
      }
    },
    {
      name: 'a temporary device of A is added and removed three times',
      async run({ world, a1, a2, b1 }) {
        for (let i = 0; i < 3; i += 1) {
          const tmp = await world.device('A', `T${i}`);
          await addDevices(world, a1, [a2, b1], [tmp]);
          await agree([a1, a2, b1, tmp]);
          await advance(world, a1, [a2, b1, tmp], {
            remove: [await indexOf(tmp)]
          });
          assert(!tmp.live, 'the temporary device saw its removal');
        }
        return agree([a1, a2, b1]);
      }
    },
    {
      name: "policy: an editor's Add of a new identity is refused by its own client and by every receiver",
      async run({ world, a1, a2, b1 }) {
        const c1 = await world.device('C', 'C1');
        const kp = await c1.session.keyPackage();
        const request = {
          add: [kp],
          setRoles: [{ userId: 'C', role: 'editor' as const }]
        };
        await refused(() => b1.session.commit(request), ['role-forbidden']);
        const receivers = await refused(
          () => tryCommit(b1, request, [a1, a2]),
          ['role-forbidden']
        );
        const unlisted = await refused(
          () => tryCommit(b1, { add: [kp] }, [a1]),
          ['leaf-without-role']
        );
        world.retire(c1);
        return `${receivers}; without a role: ${unlisted}`;
      }
    },
    {
      name: 'any member adds a leaf for an already-listed identity with its existing role',
      async run(context) {
        const { world, a1, a2, b1 } = context;
        const b2 = await world.device('B', 'B2');
        await addDevices(world, b1, [a1, a2], [b2]);
        context.b2 = b2;
        return agree([a1, a2, b1, b2]);
      }
    },
    {
      name: 'policy: an external Commit from an uncertified device is refused',
      async run({ world, a1 }) {
        const rogue = await world.device('A', 'rogue', false);
        await world.trustSelf(rogue);
        const result = await refused(
          () => tryRejoin(rogue, a1, world.newestPsk('A'), [a1]),
          ['credential-unknown']
        );
        world.retire(rogue);
        return result;
      }
    },
    {
      name: 'two Commits for one epoch: the first wins, the stale one is refused, the loser rebases',
      async run({ world, a1, a2, b1, b2 }) {
        const first = await a2.session.commit();
        const second = await b1.session.commit();
        await a2.session.confirmCommit();
        await b1.session.discardCommit();
        await deliver(first.commit, [a1, b1, b2!]);
        await world.storePsks([a1, a2, b1, b2!]);
        const stale = await failsWith(
          () => a1.session.process(second.commit),
          'mls'
        );
        await advance(world, b1, [a1, a2, b2!]);
        return `${stale}; ${await agree([a1, a2, b1, b2!])}`;
      }
    },
    {
      name: 'state sealed under a non-extractable key reopens and commits again',
      async run(context) {
        const { world, mls, a1, a2, b1, b2 } = context;
        const key = await generateStateKey();
        const sealed = await a1.session.seal(key);
        await a1.session.free();
        const otherKey = await generateStateKey();
        const wrongKey = await failsWith(
          () => mls.open(sealed, otherKey, world.projectId),
          'state'
        );
        await failsWith(() => mls.open(sealed, key, project('other')), 'state');
        const tampered = sealed.slice();
        tampered[tampered.length - 1]! ^= 1;
        await failsWith(
          () => mls.open(tampered, key, world.projectId),
          'state'
        );
        const extractable = await crypto.subtle.generateKey(
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt']
        );
        await failsWith(() => a2.session.seal(extractable), 'input');
        a1.session = await mls.open(sealed, key, world.projectId);
        await world.publish();
        await advance(world, a1, [a2, b1, b2!]);
        return `${sealed.length} B sealed; ${wrongKey.slice(0, 40)}; ${await agree([a1, a2, b1, b2!])}`;
      }
    },
    {
      name: 'A2 loses its storage and rejoins by external Commit, replacing its stale leaf',
      async run(context) {
        const { world, a1, a2, b1, b2 } = context;
        const stale = await indexOf(a2);
        world.retire(a2);
        const fresh = await world.device('A', 'A2');
        const result = await rejoin(
          world,
          fresh,
          a1,
          world.newestPsk('A'),
          [a1, b1, b2!],
          stale
        );
        context.a2 = fresh;
        const members = (await a1.session.status()).members;
        assert(
          members.length === 4,
          'the stale leaf was replaced in the same Commit'
        );
        return `${result}; ${await agree([a1, fresh, b1, b2!])}`;
      }
    },
    {
      name: 'A1 removes A2; A2 sees the removal and cannot follow',
      async run({ world, a1, a2, b1, b2 }) {
        const { commit } = await advance(world, a1, [b1, b2!], {
          remove: [await indexOf(a2)]
        });
        const seen = await a2.session.process(commit);
        assert(
          seen.kind === 'commit' && seen.change.removedSelf,
          'A2 learns it was removed'
        );
        world.retire(a2);
        const next = await advance(world, a1, [b1, b2!]);
        await failsWith(() => a2.session.process(next.commit), 'state');
        return agree([a1, b1, b2!]);
      }
    },
    {
      name: 'B leaves by SelfRemove from both devices, committed by A1; the record keeps both proposals',
      async run({ world, mls, a1, b1, b2 }) {
        const p1 = await b1.session.proposeSelfRemove();
        const p2 = await b2!.session.proposeSelfRemove();
        await deliver(p1, [a1, b2!]);
        await deliver(p2, [a1, b1]);
        const { change } = await advance(world, a1, [b1, b2!]);
        assert(!b1.live && !b2!.live, 'both B devices saw their removal');
        assert(change.removed.length === 2, 'two leaves removed');
        const record = await mls.decodeEpochRecord(change.epochRecord!);
        assert(
          record.proposals.length === 2,
          'both SelfRemove proposals are archived'
        );
        const status = await a1.session.status();
        assert(status.members.length === 1, 'only A1 remains');
        return agree([a1]);
      }
    }
  ]
});

// ---------------------------------------------------------------------------
// The spike's rejoin scenario, plus the cases it did not run

interface RejoinCast {
  world: World;
  a1: Device;
  a2: Device;
  a3: Device;
  b1: Device;
  /** A's newest device revocation cutoff. */
  revokedAt: number;
}

const WINDOW = 4;

const rejoinRules = suite<RejoinCast>({
  name: 'rejoin by external Commit (ADR-024 rejoin rules)',
  async setup(mls) {
    const world = new World(mls, project('rejoin'));
    return {
      world,
      a1: await world.device('A', 'A1'),
      a2: await world.device('A', 'A2'),
      a3: await world.device('A', 'A3'),
      b1: await world.device('B', 'B1'),
      revokedAt: 0
    };
  },
  steps: [
    {
      name: 'a wiped sole member rejoins with its stored PSK',
      async run({ world }) {
        const solo = new World(world.mls, project('solo'));
        const s1 = await solo.device('S', 'S1');
        await createProject(solo, s1, WINDOW);
        await tick(solo, s1, []);
        const stale = await indexOf(s1);
        const groupInfo = await s1.session.groupInfo(); // as the server keeps it
        solo.retire(s1);
        const s2 = await solo.device('S', 'S2');
        const result = await s2.session.rejoin(groupInfo, {
          psk: solo.newestPsk('S'),
          replaceLeaf: stale
        });
        await s2.session.confirmRejoin();
        await solo.storePsks([s2]);
        await tick(solo, s2, []);
        const status = await s2.session.status();
        assert(status.members.length === 1, 'one leaf');
        return `rejoined at epoch ${result.change.epoch}; now ${status.epoch}`;
      }
    },
    {
      name: 'setup: A1 (owner), A2, A3 and B1 (editor); A2 removed and revoked',
      async run(context) {
        const { world, a1, a2, a3, b1 } = context;
        await createProject(world, a1, WINDOW);
        await addDevices(world, a1, [], [a2, a3, b1], {
          setRoles: [{ userId: 'B', role: 'editor' }]
        });
        await tick(world, a1, [a2, a3, b1]);
        // Removal and revocation: the revocation cutoff is the first epoch A2
        // never saw.
        const { change } = await advance(world, a1, [a2, a3, b1], {
          remove: [await indexOf(a2)]
        });
        context.revokedAt = change.epoch;
        await world.revoke('A', 'A2', change.epoch);
        await tick(world, a1, [a3, b1]);
        await tick(world, a3, [a1, b1]);
        return agree([a1, a3, b1]);
      }
    },
    {
      name: 'refused: a revoked device with a fresh PSK, for the revocation only',
      async run({ world, a1, a2, b1 }) {
        const thief = await world.copy(a2, 'A2 (stolen)');
        const psk = world.psk('A', await epochOf(a1));
        return refused(
          () => tryRejoin(thief, a1, psk, [a1, b1]),
          ...only('credential-revoked')
        );
      }
    },
    {
      name: 'refused: a removed and revoked device with its own PSK fails every rule it can',
      async run({ world, a1, a2, b1, revokedAt }) {
        const thief = await world.copy(a2, 'A2 (stolen, own PSK)');
        const psk = world.newestPsk('A', revokedAt);
        return refused(
          () => tryRejoin(thief, a1, psk, [a1, b1]),
          ...only(
            'credential-revoked',
            'rejoin-psk-before-revocation',
            'rejoin-psk-before-leaf-removal'
          )
        );
      }
    },
    {
      name: "refused: a new device of A with a PSK from before A's newest revocation",
      async run({ world, a1, a3, b1, revokedAt }) {
        await advance(world, a1, [a3, b1], { remove: [await indexOf(a3)] });
        const a4 = await world.device('A', 'A4');
        const psk = world.newestPsk('A', revokedAt);
        return refused(
          () => tryRejoin(a4, a1, psk, [a1, b1]),
          ...only('rejoin-psk-before-revocation')
        );
      }
    },
    {
      name: 'refused: a removed, unrevoked device with its own pre-removal PSK (per-leaf removal cutoff)',
      async run({ world, a1, a3, b1 }) {
        const removedAt = await epochOf(a1);
        const copy = await world.copy(a3, 'A3 (own PSK)');
        const psk = world.newestPsk('A', removedAt);
        return refused(
          () => tryRejoin(copy, a1, psk, [a1, b1]),
          ...only('rejoin-psk-before-leaf-removal')
        );
      }
    },
    {
      name: 'refused by a member who joined after the removal: the records travel in the Welcome',
      async run({ world, a1, a3, b1 }) {
        const removedAt = await epochOf(a1);
        const d1 = await world.device('D', 'D1');
        await addDevices(world, a1, [b1], [d1], {
          setRoles: [{ userId: 'D', role: 'viewer' }]
        });
        const copy = await world.copy(a3, 'A3 (own PSK, new member)');
        const result = await refused(
          () => tryRejoin(copy, a1, world.newestPsk('A', removedAt), [d1]),
          ...only('rejoin-psk-before-leaf-removal')
        );
        // D1 stops following here; drop D again so later steps stay as before.
        world.retire(d1);
        await advance(world, a1, [b1], { dropUsers: ['D'] });
        return result;
      }
    },
    {
      name: 'accepted: the same device with a PSK after its removal, by a receiver restored from sealed state',
      async run(context) {
        const { world, a1, a3, b1 } = context;
        const key = await generateStateKey();
        const sealed = await a1.session.seal(key);
        await a1.session.free();
        a1.session = await world.mls.open(sealed, key, world.projectId);
        await world.publish();
        const back = await world.copy(a3, 'A3 (back)');
        const result = await rejoin(
          world,
          back,
          a1,
          world.psk('A', await epochOf(a1)),
          [a1, b1]
        );
        context.a3 = back;
        return `${result}; ${await agree([a1, back, b1])}`;
      }
    },
    {
      name: 'a rejoin that loses its epoch to another Commit is discarded and retried',
      async run({ world, a1, a2, a3, b1 }) {
        // A failed rejoin leaves a removed session removed.
        const removed = await world.copy(a2, 'A2 (failed rejoin)');
        await failsWith(
          () =>
            removed.session.rejoin(new Uint8Array([1]), {
              psk: { epoch: 0, secret: new Uint8Array(32) }
            }),
          'mls'
        );
        assert(
          (await removed.session.status()).removed,
          'still removed after a failed rejoin'
        );
        world.retire(removed);
        const a8 = await world.device('A', 'A8');
        const groupInfo = await a1.session.groupInfo();
        const lost = await a8.session.rejoin(groupInfo, {
          psk: world.psk('A', await epochOf(a1))
        });
        let status = await a8.session.status();
        assert(status.pendingRejoin && status.inGroup, 'the rejoin is pending');
        await failsWith(() => a8.session.commit(), 'state');
        await failsWith(() => a8.session.projectKey(), 'state');
        // The room took B1's Commit for that epoch instead.
        await advance(world, b1, [a1, a3]);
        await failsWith(() => a1.session.process(lost.commit), 'mls');
        await a8.session.discardRejoin();
        status = await a8.session.status();
        assert(
          !status.pendingRejoin && !status.inGroup,
          'the session is back to no group'
        );
        const retried = await rejoin(
          world,
          a8,
          a1,
          world.psk('A', await epochOf(a1)),
          [a1, a3, b1]
        );
        world.retire(a8);
        await advance(world, a1, [a3, b1, a8], { remove: [await indexOf(a8)] });
        return `stale rejoin discarded; ${retried}`;
      }
    },
    {
      name: "refused: an external Commit that removes another user's leaf",
      async run({ world, a1, a3, b1 }) {
        const a9 = await world.device('A', 'A9');
        const psk = world.psk('A', await epochOf(a1));
        const foreign = await indexOf(b1);
        // mls-rs refuses through valid_successor (same user only) before the
        // rules run; the rules' own external-commit-foreign-removal check is
        // the second line.
        const refusal = await failsWith(
          () => tryRejoin(a9, a1, psk, [a1, a3, b1], foreign),
          'mls'
        );
        assert(refusal.includes('ExternalCommitRemovesOtherIdentity'), refusal);
        return refusal;
      }
    },
    {
      name: 'refused: a PSK from a future epoch, before any PSK lookup',
      async run({ world, a1, a3, b1 }) {
        const a6 = await world.device('A', 'A6');
        const psk = {
          epoch: (await epochOf(a1)) + 1,
          secret: crypto.getRandomValues(new Uint8Array(32))
        };
        return refused(
          () => tryRejoin(a6, a1, psk, [a1, a3, b1]),
          ['rejoin-psk-future']
        );
      }
    },
    {
      name: 'refused: the right PSK id with the wrong secret fails the key schedule',
      async run({ world, a1, a3, b1 }) {
        const a7 = await world.device('A', 'A7');
        const psk = {
          epoch: await epochOf(a1),
          secret: crypto.getRandomValues(new Uint8Array(32))
        };
        return failsWith(() => tryRejoin(a7, a1, psk, [a1, a3, b1]), 'mls');
      }
    },
    {
      name: 'refused: a PSK outside the retention window',
      async run({ world, a1, a3, b1 }) {
        const old = await epochOf(a1);
        await tick(world, a1, [a3, b1], WINDOW + 1);
        const a5 = await world.device('A', 'A5');
        return refused(
          () => tryRejoin(a5, a1, world.psk('A', old), [a1, a3, b1]),
          ...only('rejoin-psk-outside-window')
        );
      }
    },
    {
      name: 'refused: B downgraded to viewer and B1 removed in one Commit, PSK from before the change',
      async run({ world, a1, a3, b1 }) {
        const before = await epochOf(a1);
        await advance(world, a1, [a3, b1], {
          remove: [await indexOf(b1)],
          setRoles: [{ userId: 'B', role: 'viewer' }]
        });
        const removedDevice = await world.copy(b1, 'B1 (removed)');
        const both = await refused(
          () => tryRejoin(removedDevice, a1, world.psk('B', before), [a1, a3]),
          ...only(
            'rejoin-psk-before-role-change',
            'rejoin-psk-before-leaf-removal'
          )
        );
        const b2 = await world.device('B', 'B2');
        const roleOnly = await refused(
          () => tryRejoin(b2, a1, world.psk('B', before), [a1, a3]),
          ...only('rejoin-psk-before-role-change')
        );
        return `removed device: ${both}; other device: ${roleOnly}`;
      }
    },
    {
      name: 'refused: B dropped from the roles extension, whatever the PSK',
      async run({ world, a1, a3 }) {
        await advance(world, a1, [a3], { dropUsers: ['B'] });
        const b3 = await world.device('B', 'B3');
        return refused(
          () => tryRejoin(b3, a1, world.newestPsk('B'), [a1, a3]),
          ['identity-not-listed'],
          ['credential-revoked']
        );
      }
    }
  ]
});

// ---------------------------------------------------------------------------
// A member removed and re-added (not run by the spike)

interface ReaddCast {
  world: World;
  a1: Device;
  b1: Device;
  b1n?: Device;
  removedAt: number;
  readdedAt: number;
}

const readd = suite<ReaddCast>({
  name: 'a member removed and later re-added',
  async setup(mls) {
    const world = new World(mls, project('readd'));
    const a1 = await world.device('A', 'A1');
    const b1 = await world.device('B', 'B1');
    await createProject(world, a1, 8);
    await addDevices(world, a1, [], [b1], {
      setRoles: [{ userId: 'B', role: 'editor' }]
    });
    await tick(world, b1, [a1]);
    return { world, a1, b1, removedAt: 0, readdedAt: 0 };
  },
  steps: [
    {
      name: 'the owner drops B; B1 is removed with it',
      async run(context) {
        const { world, a1, b1 } = context;
        const { change } = await advance(world, a1, [b1], { dropUsers: ['B'] });
        assert(!b1.live && change.removed.length === 1, 'B1 removed');
        context.removedAt = change.epoch;
        await tick(world, a1, []);
        return agree([a1]);
      }
    },
    {
      name: 'the owner re-adds B with a new leaf',
      async run(context) {
        const { world, a1 } = context;
        const b1n = await world.device('B', 'B1n');
        const change = await addDevices(world, a1, [], [b1n], {
          setRoles: [{ userId: 'B', role: 'editor' }]
        });
        context.b1n = b1n;
        context.readdedAt = change.epoch;
        const since = (await a1.session.status()).roles?.users.find(
          (u) => u.userId === 'B'
        )?.since;
        assert(since === change.epoch, 'the re-add sets a new role epoch');
        return agree([a1, b1n]);
      }
    },
    {
      name: 'refused: the removed leaf key cannot be added back',
      async run({ a1, b1, b1n }) {
        const kp = await b1.session.keyPackage();
        await refused(
          () => a1.session.commit({ add: [kp] }),
          ['leaf-key-reused']
        );
        return refused(
          () => tryCommit(a1, { add: [kp] }, [b1n!]),
          ['leaf-key-reused']
        );
      }
    },
    {
      name: 'refused: the old device with its pre-removal PSK, by both the role and removal cutoffs',
      async run({ world, a1, b1, b1n, removedAt }) {
        const copy = await world.copy(b1, 'B1 (old)');
        return refused(
          () =>
            tryRejoin(copy, a1, world.newestPsk('B', removedAt), [a1, b1n!]),
          ...only(
            'rejoin-psk-before-role-change',
            'rejoin-psk-before-leaf-removal'
          )
        );
      }
    },
    {
      name: 'refused: another device of B with a pre-removal PSK, by the re-add epoch',
      async run({ world, a1, b1n, removedAt }) {
        const b3 = await world.device('B', 'B3');
        return refused(
          () => tryRejoin(b3, a1, world.newestPsk('B', removedAt), [a1, b1n!]),
          ...only('rejoin-psk-before-role-change')
        );
      }
    },
    {
      name: "accepted: the old, unrevoked device with a PSK from after the re-add (from B1n's store)",
      async run({ world, a1, b1, b1n }) {
        const copy = await world.copy(b1, 'B1 (back)');
        const result = await rejoin(
          world,
          copy,
          a1,
          world.psk('B', await epochOf(a1)),
          [a1, b1n!]
        );
        return `${result}; ${await agree([a1, b1n!, copy])}`;
      }
    },
    {
      name: "refused: the owner's recovery Add of a key certified before the identity's latest removal",
      async run({ world, a1, b1n, removedAt }) {
        const early = await world.device('B', 'B5', true, removedAt - 1);
        const kp = await early.session.keyPackage();
        const local = await refused(
          () => a1.session.commit({ add: [kp] }),
          ['leaf-certified-before-removal']
        );
        const receivers = await refused(
          () => tryCommit(a1, { add: [kp] }, [b1n!]),
          ['leaf-certified-before-removal']
        );
        world.retire(early);
        return `own client ${local}; receivers ${receivers}`;
      }
    }
  ]
});

// ---------------------------------------------------------------------------
// The last-leaf recovery exception (not run by the spike)

interface LastLeafCast {
  world: World;
  a1: Device;
  c1: Device;
  c2?: Device;
  revokedAt: number;
}

const lastLeaf = suite<LastLeafCast>({
  name: 'last-leaf recovery for a named replacement',
  async setup(mls) {
    const world = new World(mls, project('lastleaf'));
    const a1 = await world.device('A', 'A1');
    const c1 = await world.device('C', 'C1');
    await createProject(world, a1, 8);
    await addDevices(world, a1, [], [c1], {
      setRoles: [{ userId: 'C', role: 'editor' }]
    });
    await tick(world, c1, [a1], 2);
    return { world, a1, c1, revokedAt: 0 };
  },
  steps: [
    {
      name: "C revokes its only, stolen device C1 and names C2 as replacement; C1's Commits are refused",
      async run(context) {
        const { world, a1, c1 } = context;
        context.revokedAt = (await epochOf(a1)) + 1;
        await world.revoke('C', 'C1', context.revokedAt, 'C2');
        context.c2 = await world.device('C', 'C2');
        return refused(() => tryCommit(c1, {}, [a1]), ['credential-revoked']);
      }
    },
    {
      name: 'refused: a device that is not the named replacement, with the pre-revocation PSK',
      async run({ world, a1, c1, revokedAt }) {
        const psk = world.newestPsk('C', revokedAt);
        const c3 = await world.device('C', 'C3');
        const alone = await refused(
          () => tryRejoin(c3, a1, psk, [a1]),
          ...only('rejoin-psk-before-revocation')
        );
        const c4 = await world.device('C', 'C4');
        const stolen = await indexOf(c1);
        const replacing = await refused(
          () => tryRejoin(c4, a1, psk, [a1], stolen),
          ...only('rejoin-psk-before-revocation')
        );
        return `${alone}; replacing C1: ${replacing}`;
      }
    },
    {
      name: 'refused: the replacement must remove the revoked leaf in the same Commit',
      async run({ world, a1, c2, revokedAt }) {
        const copy = await world.copy(c2!, 'C2 (no removal)');
        return refused(
          () => tryRejoin(copy, a1, world.newestPsk('C', revokedAt), [a1]),
          ['rejoin-psk-before-revocation']
        );
      }
    },
    {
      name: 'accepted: the named replacement rejoins with the newest pre-revocation PSK, removing C1',
      async run({ world, a1, c1, c2, revokedAt }) {
        const result = await rejoin(
          world,
          c2!,
          a1,
          world.newestPsk('C', revokedAt),
          [a1],
          await indexOf(c1)
        );
        world.retire(c1);
        const members = (await a1.session.status()).members.map(
          (m) => m.deviceId
        );
        assert(
          members.length === 2 &&
            members.includes('C2') &&
            !members.includes('C1'),
          'C1 replaced by C2'
        );
        return `${result}; ${await agree([a1, c2!])}`;
      }
    }
  ]
});

interface LaterRevocationCast {
  world: World;
  a1: Device;
  c1: Device;
}

const laterRevocation = suite<LaterRevocationCast>({
  name: 'last-leaf recovery with a later revocation of another device',
  async setup(mls) {
    const world = new World(mls, project('lastleaf-later'));
    const a1 = await world.device('A', 'A1');
    const c1 = await world.device('C', 'C1');
    await createProject(world, a1);
    await addDevices(world, a1, [], [c1], {
      setRoles: [{ userId: 'C', role: 'editor' }]
    });
    await tick(world, c1, [a1], 2);
    return { world, a1, c1 };
  },
  steps: [
    {
      name: "the exception waives only the stale leaf's own revocation, not a later one",
      async run({ world, a1, c1 }) {
        const first = (await epochOf(a1)) + 1;
        await world.revoke('C', 'C1', first, 'C2');
        await tick(world, a1, [c1], 2);
        // A later revocation of C3, a device that never joined this group.
        const later = (await epochOf(a1)) + 1;
        await world.device('C', 'C3');
        await world.revoke('C', 'C3', later);
        await tick(world, a1, [c1], 2);
        const c2 = await world.device('C', 'C2');
        const between = await world.copy(c2, 'C2 (between cutoffs)');
        const fresh = await world.copy(c2, 'C2 (fresh PSK)');
        const stale = await indexOf(c1);
        const beforeFirst = await refused(
          () => tryRejoin(c2, a1, world.newestPsk('C', first), [a1], stale),
          ...only('rejoin-psk-before-revocation')
        );
        const betweenRefusal = await refused(
          () => tryRejoin(between, a1, world.psk('C', first), [a1], stale),
          ...only('rejoin-psk-before-revocation')
        );
        const accepted = await rejoin(
          world,
          fresh,
          a1,
          world.newestPsk('C'),
          [a1],
          stale
        );
        world.retire(c1);
        return `before both: ${beforeFirst}; between: ${betweenRefusal}; ${accepted}`;
      }
    }
  ]
});

interface TwoStaleCast {
  world: World;
  a1: Device;
  c1: Device;
  c1b: Device;
}

const twoStaleLeaves = suite<TwoStaleCast>({
  name: 'last-leaf recovery when every remaining leaf is revoked',
  async setup(mls) {
    const world = new World(mls, project('lastleaf-two'));
    const a1 = await world.device('A', 'A1');
    const c1 = await world.device('C', 'C1');
    const c1b = await world.device('C', 'C1b');
    await createProject(world, a1);
    await addDevices(world, a1, [], [c1, c1b], {
      setRoles: [{ userId: 'C', role: 'editor' }]
    });
    await tick(world, c1, [a1, c1b], 2);
    return { world, a1, c1, c1b };
  },
  steps: [
    {
      name: 'refused while another leaf of the user is still unrevoked; accepted once both are revoked, and the second is removed next',
      async run({ world, a1, c1, c1b }) {
        const first = (await epochOf(a1)) + 1;
        await world.revoke('C', 'C1', first, 'C2');
        const c2 = await world.device('C', 'C2');
        const early = await world.copy(c2, 'C2 (C1b still active)');
        const psk = world.newestPsk('C', first);
        const stale = await indexOf(c1);
        const active = await refused(
          () => tryRejoin(early, a1, psk, [a1], stale),
          ...only('rejoin-psk-before-revocation')
        );
        await world.revoke('C', 'C1b', (await epochOf(a1)) + 1, 'C2');
        const accepted = await rejoin(world, c2, a1, psk, [a1], stale);
        // The external Commit removed C1; C2 removes C1b in its next Commit.
        await advance(world, c2, [a1], { remove: [await indexOf(c1b)] });
        world.retire(c1, c1b);
        const members = (await a1.session.status()).members.map(
          (m) => m.deviceId
        );
        assert(
          members.length === 2 && members.includes('C2'),
          'both revoked leaves are gone'
        );
        return `${active}; ${accepted}; ${await agree([a1, c2])}`;
      }
    }
  ]
});

// ---------------------------------------------------------------------------
// Viewer and editor limits

interface RolesCast {
  world: World;
  a1: Device;
  e1: Device;
  v1: Device;
}

const roleLimits = suite<RolesCast>({
  name: 'what each role may commit',
  async setup(mls) {
    const world = new World(mls, project('roles'));
    const a1 = await world.device('A', 'A1');
    const e1 = await world.device('E', 'E1');
    const v1 = await world.device('V', 'V1');
    await createProject(world, a1);
    await addDevices(world, a1, [], [e1, v1], {
      setRoles: [
        { userId: 'E', role: 'editor' },
        { userId: 'V', role: 'viewer' }
      ]
    });
    return { world, a1, e1, v1 };
  },
  steps: [
    {
      name: 'a viewer commits a path-only Update of its own leaf',
      async run({ world, a1, e1, v1 }) {
        await advance(world, v1, [a1, e1]);
        return agree([a1, e1, v1]);
      }
    },
    {
      name: "refused: a viewer removing another member's leaf",
      async run({ a1, e1, v1 }) {
        const editor = await indexOf(e1);
        return refused(
          () => tryCommit(v1, { remove: [editor] }, [a1]),
          ['role-forbidden']
        );
      }
    },
    {
      name: 'refused: a viewer or an editor changing roles',
      async run({ a1, e1, v1 }) {
        const request = {
          setRoles: [{ userId: 'V', role: 'editor' as const }]
        };
        const viewer = await refused(
          () => tryCommit(v1, request, [a1, e1]),
          ['role-forbidden']
        );
        const editor = await refused(
          () => tryCommit(e1, request, [a1, v1]),
          ['role-forbidden']
        );
        return `viewer ${viewer}; editor ${editor}`;
      }
    },
    {
      name: "a viewer commits another member's SelfRemove",
      async run({ world, a1, e1, v1 }) {
        const e2 = await world.device('E', 'E2');
        await addDevices(world, a1, [e1, v1], [e2]);
        const leave = await e2.session.proposeSelfRemove();
        await deliver(leave, [a1, e1, v1]);
        await advance(world, v1, [a1, e1, e2]);
        assert(!e2.live, 'E2 left');
        return agree([a1, e1, v1]);
      }
    },
    {
      name: 'a viewer adds a leaf for its own identity with its existing role',
      async run({ world, a1, e1, v1 }) {
        const v2 = await world.device('V', 'V2');
        await addDevices(world, v1, [a1, e1], [v2]);
        return agree([a1, e1, v1, v2]);
      }
    },
    {
      name: "refused: a recovery Add of a key certified before the identity's latest leaf removal; accepted when certified after",
      async run({ world, a1, e1, v1 }) {
        // E2 left by SelfRemove in an earlier step. E3's key was certified at
        // epoch 1, before that, and held back.
        const early = await world.device('E', 'E3', true, 1);
        const kp = await early.session.keyPackage();
        const local = await refused(
          () => e1.session.commit({ add: [kp] }),
          ['leaf-certified-before-removal']
        );
        const receivers = await refused(
          () => tryCommit(e1, { add: [kp] }, [a1, v1]),
          ['leaf-certified-before-removal']
        );
        world.retire(early);
        const viewers = world.devices.filter(
          (d) => d.userId === 'V' && d.live && d !== v1
        );
        const fresh = await world.device('E', 'E4', true, await epochOf(a1));
        await addDevices(world, e1, [a1, v1, ...viewers], [fresh]);
        const agreed = await agree([a1, e1, v1, ...viewers, fresh]);
        await advance(world, a1, [e1, v1, ...viewers, fresh], {
          remove: [await indexOf(fresh)]
        });
        return `own client ${local}; receivers ${receivers}; certified after: ${agreed}`;
      }
    },
    {
      name: 'refused: a recovery Add in the Commit that removes a leaf of that identity, with a key certified before it',
      async run({ world, a1, e1, v1 }) {
        const viewers = world.devices.filter(
          (d) => d.userId === 'V' && d.live && d !== v1
        );
        const e5 = await world.device('E', 'E5');
        await addDevices(world, a1, [e1, v1, ...viewers], [e5]);
        // E6 was certified now: after every earlier removal of E, but
        // before the removal this Commit makes.
        const e6 = await world.device('E', 'E6', true, await epochOf(a1));
        const request = {
          remove: [await indexOf(e5)],
          add: [await e6.session.keyPackage()]
        };
        const local = await refused(
          () => e1.session.commit(request),
          ['leaf-certified-before-removal']
        );
        const receivers = await refused(
          () => tryCommit(e1, request, [a1, v1]),
          ['leaf-certified-before-removal']
        );
        world.retire(e6);
        await advance(world, a1, [e1, v1, ...viewers, e5], {
          remove: [await indexOf(e5)]
        });
        return `own client ${local}; receivers ${receivers}`;
      }
    },
    {
      name: 'refused: the owner listing two owners',
      async run({ a1 }) {
        return refused(
          () =>
            a1.session.commit({ setRoles: [{ userId: 'E', role: 'owner' }] }),
          ['roles-invalid']
        );
      }
    },
    {
      name: "dropping an identity removes all of that identity's leaves",
      async run({ world, a1, e1 }) {
        const viewers = world.devices.filter((d) => d.userId === 'V' && d.live);
        const { change } = await advance(world, a1, [e1, ...viewers], {
          dropUsers: ['V']
        });
        assert(
          change.removed.length === 2 && viewers.every((d) => !d.live),
          'both V leaves removed'
        );
        return agree([a1, e1]);
      }
    }
  ]
});

// ---------------------------------------------------------------------------
// Removal records carried in GroupInfo (review regressions)

interface RecordsCast {
  world: World;
  a1: Device;
  a2: Device;
  b1: Device;
}

const carriedRecords = suite<RecordsCast>({
  name: 'removal records carried in GroupInfo',
  async setup(mls) {
    const world = new World(mls, project('records'));
    const a1 = await world.device('A', 'A1');
    const a2 = await world.device('A', 'A2');
    const b1 = await world.device('B', 'B1');
    await createProject(world, a1, 8);
    await addDevices(world, a1, [], [a2, b1], {
      setRoles: [{ userId: 'B', role: 'editor' }]
    });
    await tick(world, a2, [a1, b1]);
    return { world, a1, a2, b1 };
  },
  steps: [
    {
      name: 'refused by a member whose Welcome came from the Commit that removed the leaf',
      async run({ world, a1, a2, b1 }) {
        const before = await epochOf(a1);
        const d1 = await world.device('D', 'D1');
        // One Commit adds D1 and removes A2.
        await addDevices(world, a1, [a2, b1], [d1], {
          remove: [await indexOf(a2)],
          setRoles: [{ userId: 'D', role: 'viewer' }]
        });
        assert(!a2.live, 'A2 removed');
        const copy = await world.copy(a2, 'A2 (own PSK)');
        return refused(
          () => tryRejoin(copy, a1, world.psk('A', before), [d1]),
          ...only('rejoin-psk-before-leaf-removal')
        );
      }
    },
    {
      name: 'refused by a member added through a cached Add proposal in the Commit that removed the leaf',
      async run({ world, a1, b1 }) {
        const a5 = await world.device('A', 'A5');
        await addDevices(world, a1, [b1], [a5]);
        const removedBefore = await epochOf(a1);
        const b2 = await world.device('B', 'B2');
        // B1 proposes the Add by reference; A1 commits it with a Remove of A5.
        const proposal = await b1.session.proposeAdd(
          await b2.session.keyPackage()
        );
        await deliver(proposal, [a1, a5]);
        const { welcome } = await advance(world, a1, [b1, a5], {
          remove: [await indexOf(a5)]
        });
        await join(world, welcome, [b2]);
        assert(!a5.live, 'A5 removed');
        const copy = await world.copy(a5, 'A5 (own PSK)');
        return refused(
          () => tryRejoin(copy, a1, world.psk('A', removedBefore), [b2]),
          ...only('rejoin-psk-before-leaf-removal')
        );
      }
    },
    {
      name: "a recreated device's own client refuses a stale rejoin using the GroupInfo's records, then rejoins",
      async run({ world, a1, b1 }) {
        const a6 = await world.device('A', 'A6');
        await addDevices(world, a1, [b1], [a6]);
        const joined = await epochOf(a1);
        await advance(world, a1, [b1, a6], { remove: [await indexOf(a6)] });
        // The browser storage of A6 is wiped: a fresh session for the same
        // device, with no removal history of its own.
        const fresh = await world.device('A', 'A6');
        const groupInfo = await a1.session.groupInfo();
        const local = await refused(
          () =>
            fresh.session.rejoin(groupInfo, { psk: world.psk('A', joined) }),
          ...only('rejoin-psk-before-leaf-removal')
        );
        assert(
          !(await fresh.session.status()).inGroup,
          'no group is left behind'
        );
        const accepted = await rejoin(
          world,
          fresh,
          a1,
          world.psk('A', await epochOf(a1)),
          [a1, b1]
        );
        return `${local}; ${accepted}`;
      }
    },
    {
      name: 'a forged GroupInfo leaves no removal records behind',
      async run({ world, a1, b1 }) {
        // Another group under the same project id, where a device "A/A4" was
        // removed late: its GroupInfo carries a high cutoff for A4.
        const other = new World(world.mls, world.projectId);
        const z1 = await other.device('A', 'Z1');
        const z4 = await other.device('A', 'A4');
        await createProject(other, z1, 8);
        await addDevices(other, z1, [], [z4]);
        await tick(other, z1, [z4], 12);
        await advance(other, z1, [z4], { remove: [await indexOf(z4)] });
        const forged = await z1.session.groupInfo();
        forged[forged.length - 1]! ^= 1; // break the signature only
        const a4 = await world.device('A', 'A4');
        const psk = world.psk('A', await epochOf(a1));
        // Refused while verifying the GroupInfo (its tree or its signature).
        let refusal = '';
        try {
          await a4.session.rejoin(forged, { psk });
        } catch (error) {
          assert(error instanceof MlsError, String(error));
          refusal = error.kind;
        }
        assert(refusal, 'the forged GroupInfo was accepted');
        const accepted = await rejoin(world, a4, a1, psk, [a1, b1]);
        return `forged GroupInfo refused (${refusal}); ${accepted}`;
      }
    }
  ]
});

export const scenarioSuites: ScenarioSuite[] = [
  main,
  rejoinRules,
  readd,
  lastLeaf,
  roleLimits,
  carriedRecords,
  laterRevocation,
  twoStaleLeaves
];

/** Run every suite in order; used by the browser harness. */
export async function runScenarios(
  mls: Mls,
  report: (result: {
    suite: string;
    step: string;
    ok: boolean;
    detail: string;
    ms: number;
  }) => void
): Promise<void> {
  for (const s of scenarioSuites) {
    let context: unknown;
    try {
      context = await s.setup(mls);
    } catch (error) {
      report({
        suite: s.name,
        step: 'setup',
        ok: false,
        detail: String(error),
        ms: 0
      });
      continue;
    }
    for (const step of s.steps) {
      const started = performance.now();
      try {
        const detail = await step.run(context);
        report({
          suite: s.name,
          step: step.name,
          ok: true,
          detail,
          ms: performance.now() - started
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        report({
          suite: s.name,
          step: step.name,
          ok: false,
          detail,
          ms: performance.now() - started
        });
      }
    }
  }
}
